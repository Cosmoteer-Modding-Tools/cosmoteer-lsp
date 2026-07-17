package cosmoteer.grid

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.Alarm
import com.redhat.devtools.lsp4ij.LSPIJUtils
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.PluginPaths
import cosmoteer.lsp.CosmoteerLanguageServerAPI
import cosmoteer.lsp.PartGridEditParams
import cosmoteer.preview.JcefSupport
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.TextDocumentPositionParams
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.SwingConstants

/**
 * Owns the interactive part grid editor: a JCEF browser running the same page the VS Code
 * extension ships (`media/part-grid-editor.js`). The service asks the language server for the part
 * at a tracked position, inlines the part sprites as data URIs, and pushes the payload into the
 * page as a `message` event. Page clicks come back as mutations: the server turns each into a
 * WorkspaceEdit which is applied in a write command (native undo), and the resulting document
 * change re-renders the page with fresh authoritative state.
 */
@Service(Service.Level.PROJECT)
class PartGridEditorService(private val project: Project) : Disposable {
    private val gson = Gson()
    private var browser: JBCefBrowser? = null
    private var fallback: JComponent? = null
    /** Whether the page reported `ready`. Messages posted earlier are queued. */
    @Volatile private var pageReady = false
    @Volatile private var queuedMessage: String? = null
    /** The part document and offset being edited, re-queried when the document changes. */
    @Volatile private var tracked: Pair<VirtualFile, Int>? = null
    /** The part group anchor of the last payload, echoed by edit requests. */
    @Volatile private var anchor: Position? = null
    private val refreshAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)

    init {
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                onDocumentChanged(FileDocumentManager.getInstance().getFile(event.document) ?: return)
            }
        }, this)
    }

    /** The Swing component the tool window shows: the browser, or a notice when JCEF is unavailable. */
    fun component(): JComponent {
        if (!JBCefApp.isSupported()) {
            return fallback ?: JLabel(
                "The part grid editor needs the embedded browser (JCEF), which this IDE runtime does not support.",
                SwingConstants.CENTER
            ).also { fallback = it }
        }
        return ensureBrowser().component
    }

    /**
     * Opens the grid editor for the part at an offset: shows the tool window, remembers the
     * position for live refresh, and requests a render.
     *
     * @param file the `.rules` file containing the part.
     * @param offset a caret or marker offset inside the part group.
     */
    fun edit(file: VirtualFile, offset: Int) {
        tracked = file to offset
        ApplicationManager.getApplication().invokeLater {
            ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.show()
            render()
        }
    }

    /** Queries the server for the tracked part and pushes the payload into the page. */
    private fun render() {
        val (file, offset) = tracked ?: return
        val params = ReadAction.compute<TextDocumentPositionParams?, RuntimeException> {
            val document = FileDocumentManager.getInstance().getDocument(file) ?: return@compute null
            val safeOffset = offset.coerceIn(0, document.textLength)
            val line = document.getLineNumber(safeOffset)
            TextDocumentPositionParams(
                TextDocumentIdentifier(LSPIJUtils.toUri(file).toASCIIString()),
                Position(line, safeOffset - document.getLineStartOffset(line))
            )
        } ?: return
        withServer { server -> server.partGridData(params) }
            .thenAccept { data -> postRender(data) }
            .exceptionally { error ->
                logger<PartGridEditorService>().warn("Part grid data request failed", error)
                null
            }
    }

    /** Resolves the language server and runs one request against it. */
    private fun <T> withServer(request: (CosmoteerLanguageServerAPI) -> CompletableFuture<T?>): CompletableFuture<T?> =
        LanguageServerManager.getInstance(project)
            .getLanguageServer(SERVER_ID)
            .thenCompose { item ->
                val server = item?.server as? CosmoteerLanguageServerAPI
                    ?: return@thenCompose CompletableFuture.completedFuture<T?>(null)
                request(server)
            }

    /** Converts the server payload to the page's `render`/`empty` message and posts it. */
    private fun postRender(data: JsonObject?) {
        if (data == null) {
            anchor = null
            postMessage("""{"type":"empty"}""")
            return
        }
        anchor = data.getAsJsonObject("anchor")?.let { position ->
            Position(position.get("line")?.asInt ?: 0, position.get("character")?.asInt ?: 0)
        }
        val spriteData = JsonObject()
        val sprites = data.getAsJsonArray("sprites") ?: com.google.gson.JsonArray()
        for (sprite in sprites) {
            val obj = sprite.asJsonObject
            val id = obj.get("id")?.asString ?: continue
            val uri = obj.get("uri")?.takeUnless { it.isJsonNull }?.asString
            val dataUri = uri?.let { JcefSupport.imageDataUri(it) }
            if (dataUri != null) spriteData.addProperty(id, dataUri) else spriteData.add(id, com.google.gson.JsonNull.INSTANCE)
        }
        val message = JsonObject().apply {
            addProperty("type", "render")
            add("data", data)
            add("spriteData", spriteData)
        }
        postMessage(gson.toJson(message))
    }

    /** Dispatches a message into the page, queueing it until the page has reported `ready`. */
    private fun postMessage(json: String) {
        val cefBrowser = ensureBrowserOnEdt() ?: return
        if (!pageReady) {
            queuedMessage = json
            return
        }
        cefBrowser.cefBrowser.executeJavaScript(
            "window.dispatchEvent(new MessageEvent('message', {data: $json}));",
            cefBrowser.cefBrowser.url,
            0
        )
    }

    /** [ensureBrowser], hopping to the EDT when needed. Null when JCEF is unsupported. */
    private fun ensureBrowserOnEdt(): JBCefBrowser? {
        if (!JBCefApp.isSupported()) return null
        browser?.let { return it }
        var created: JBCefBrowser? = null
        ApplicationManager.getApplication().invokeAndWait { created = ensureBrowser() }
        return created
    }

    /** Creates the browser and loads the editor page on first use. */
    private fun ensureBrowser(): JBCefBrowser {
        browser?.let { return it }
        // Windowed (non-OSR) mode, same as the shader preview: off-screen rendering never
        // composites GPU layers, and it is also required for reliable mouse interaction here.
        val newBrowser = JBCefBrowser.createBuilder()
            .setOffScreenRendering(false)
            .build()
        val query = JBCefJSQuery.create(newBrowser as JBCefBrowserBase)
        query.addHandler { raw ->
            onPageMessage(raw)
            null
        }
        newBrowser.loadHTML(pageHtml(query))
        browser = newBrowser
        return newBrowser
    }

    /** Handles messages the page sends through the shimmed `acquireVsCodeApi().postMessage`. */
    private fun onPageMessage(raw: String) {
        try {
            val message = JsonParser.parseString(raw).asJsonObject
            when (message.get("type")?.asString) {
                "ready" -> {
                    pageReady = true
                    queuedMessage?.let { pending ->
                        queuedMessage = null
                        postMessage(pending)
                    }
                }
                "edit" -> applyMutation(message)
                "openLocation" -> openLocation(message)
                "refresh" -> ApplicationManager.getApplication().invokeLater { render() }
            }
        } catch (exception: Exception) {
            logger<PartGridEditorService>().warn("Bad message from the part grid editor page", exception)
        }
    }

    /**
     * Sends one page mutation to the server and applies the returned WorkspaceEdit in a write
     * command (native undo, one step per click). The document change listener then re-renders the
     * page with fresh authoritative state, which also carries the new dataVersion the page's
     * queued clicks resume against.
     */
    private fun applyMutation(message: JsonObject) {
        val (file, _) = tracked ?: return
        val currentAnchor = anchor ?: return
        val params = PartGridEditParams(
            TextDocumentIdentifier(LSPIJUtils.toUri(file).toASCIIString()),
            currentAnchor,
            message.get("dataVersion")?.asInt ?: -1,
            message.getAsJsonObject("mutation")
        )
        withServer { server -> server.partGridEdit(params) }
            .thenAccept { result ->
                val edit = result?.edit
                if (result?.status == "ok" && edit != null) {
                    ApplicationManager.getApplication().invokeLater {
                        WriteCommandAction.runWriteCommandAction(project, "Edit Part Grid", null, {
                            LSPIJUtils.applyWorkspaceEdit(edit)
                        })
                    }
                } else {
                    val reason = result?.status ?: "error"
                    postMessage("""{"type":"editRejected","reason":"$reason"}""")
                }
            }
            .exceptionally { error ->
                logger<PartGridEditorService>().warn("Part grid edit request failed", error)
                postMessage("""{"type":"editRejected","reason":"error"}""")
                null
            }
    }

    /** Jumps to a value's source location reported by the page. */
    private fun openLocation(message: JsonObject) {
        val uri = message.get("uri")?.asString ?: return
        val range = message.getAsJsonObject("range")
        val line = range?.getAsJsonObject("start")?.get("line")?.asInt ?: 0
        val character = range?.getAsJsonObject("start")?.get("character")?.asInt ?: 0
        ApplicationManager.getApplication().invokeLater {
            val path = JcefSupport.uriToPath(uri) ?: return@invokeLater
            val file = VfsUtil.findFile(path, true) ?: return@invokeLater
            OpenFileDescriptor(project, file, line, character).navigate(true)
        }
    }

    /** Re-render (debounced) when the changed document is the tracked part file. */
    private fun onDocumentChanged(changed: VirtualFile) {
        val (file, _) = tracked ?: return
        if (changed.path.replace('\\', '/').lowercase() != file.path.replace('\\', '/').lowercase()) return
        refreshAlarm.cancelAllRequests()
        refreshAlarm.addRequest({ render() }, 250)
    }

    /** The page shell: the bundled stylesheet and editor script inlined, plus the VS Code API shim. */
    private fun pageHtml(query: JBCefJSQuery): String {
        val css = Files.readString(PluginPaths.media("part-grid-editor.css"))
        val script = Files.readString(PluginPaths.media("part-grid-editor.js"))
        val bridge = query.inject("JSON.stringify(m)")
        return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>$css</style>
<style>${JcefSupport.themeCss()}</style>
<title>Part Grid Editor</title>
</head>
<body>
<div id="editor">
<div id="stage"><canvas id="grid"></canvas><div id="status"></div></div>
<div id="sidebar"></div>
</div>
<script>
window.acquireVsCodeApi = function () {
    return {
        postMessage: function (m) { $bridge },
        getState: function () { return undefined; },
        setState: function () {}
    };
};
</script>
<script>$script</script>
</body>
</html>"""
    }

    override fun dispose() {
        browser = null
    }

    companion object {
        const val TOOL_WINDOW_ID = "Cosmoteer Part Grid Editor"
        const val SERVER_ID = "cosmoteerLanguageServer"

        fun getInstance(project: Project): PartGridEditorService = project.getService(PartGridEditorService::class.java)
    }
}
