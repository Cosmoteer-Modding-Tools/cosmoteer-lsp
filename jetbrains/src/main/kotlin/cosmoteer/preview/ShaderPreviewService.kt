package cosmoteer.preview

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.Alarm
import com.intellij.util.ui.JBFont
import com.intellij.util.ui.UIUtil
import com.redhat.devtools.lsp4ij.LSPIJUtils
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.PluginPaths
import cosmoteer.lsp.CosmoteerLanguageServerAPI
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.TextDocumentPositionParams
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.Base64
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.SwingConstants
import javax.swing.UIManager

/**
 * Owns the live shader preview: a JCEF browser running the same WebGL page the VS Code extension
 * ships (`media/shader-preview.js`). The service asks the language server for the material at a
 * tracked position, inlines the bound textures as data URIs, and pushes the payload into the page
 * as a `message` event. Edits to the material's document or its resolved shader re-render after a
 * short debounce.
 */
@Service(Service.Level.PROJECT)
class ShaderPreviewService(private val project: Project) : Disposable {
    private val gson = Gson()
    private var browser: JBCefBrowser? = null
    private var fallback: JComponent? = null
    /** Whether the page reported `ready`. Messages posted earlier are queued. */
    @Volatile private var pageReady = false
    @Volatile private var queuedMessage: String? = null
    /** The material being previewed, re-queried when its document or its shader changes. */
    @Volatile private var tracked: Pair<VirtualFile, Int>? = null
    /** Lower-cased path of the shader the last render resolved, so an edit to it refreshes too. */
    @Volatile private var previewedShaderPath: String? = null
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
                "The shader preview needs the embedded browser (JCEF), which this IDE runtime does not support.",
                SwingConstants.CENTER
            ).also { fallback = it }
        }
        return ensureBrowser().component
    }

    /**
     * Previews the material at an offset: shows the tool window, remembers the position for live
     * refresh, and requests a render.
     *
     * @param file the `.rules` file containing the material.
     * @param offset the caret or marker offset of the material's `Shader` assignment.
     */
    fun preview(file: VirtualFile, offset: Int) {
        tracked = file to offset
        ApplicationManager.getApplication().invokeLater {
            ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.show()
            render()
        }
    }

    /** Queries the server for the tracked material and pushes the result into the page. */
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
        LanguageServerManager.getInstance(project)
            .getLanguageServer(SERVER_ID)
            .thenCompose { item ->
                val server = item?.server as? CosmoteerLanguageServerAPI
                    ?: return@thenCompose java.util.concurrent.CompletableFuture.completedFuture<JsonObject?>(null)
                server.shaderPreview(params)
            }
            .thenAccept { data -> postRender(data) }
            .exceptionally { error ->
                logger<ShaderPreviewService>().warn("Shader preview request failed", error)
                null
            }
    }

    /** Converts the server payload to the page's `render`/`empty` message and posts it. */
    private fun postRender(data: JsonObject?) {
        if (data == null) {
            previewedShaderPath = null
            postMessage("""{"type":"empty"}""")
            return
        }
        previewedShaderPath = data.get("shaderUri")?.takeUnless { it.isJsonNull }?.asString
            ?.let { uriToPath(it)?.toString()?.lowercase() }
        val textureData = JsonObject()
        val textures = data.getAsJsonArray("textures") ?: com.google.gson.JsonArray()
        for (texture in textures) {
            val obj = texture.asJsonObject
            val name = obj.get("name")?.asString ?: continue
            val uri = obj.get("uri")?.takeUnless { it.isJsonNull }?.asString
            val dataUri = uri?.let { textureDataUri(it) }
            if (dataUri != null) textureData.addProperty(name, dataUri) else textureData.add(name, com.google.gson.JsonNull.INSTANCE)
        }
        val message = JsonObject().apply {
            addProperty("type", "render")
            add("data", data)
            add("textureData", textureData)
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

    /** Creates the browser and loads the preview page on first use. */
    private fun ensureBrowser(): JBCefBrowser {
        browser?.let { return it }
        // Windowed (non-OSR) mode: the platform default is off-screen rendering, where Chromium's
        // GPU-composited layers never reach the software-composited frame and the WebGL canvas
        // stays black. Remote dev forces OSR regardless, the preview degrades to a black stage there.
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
                "openShader" -> {
                    val uri = message.get("uri")?.asString ?: return
                    ApplicationManager.getApplication().invokeLater {
                        val path = uriToPath(uri) ?: return@invokeLater
                        val file = VfsUtil.findFile(path, true) ?: return@invokeLater
                        OpenFileDescriptor(project, file).navigate(true)
                    }
                }
            }
        } catch (exception: Exception) {
            logger<ShaderPreviewService>().warn("Bad message from the shader preview page", exception)
        }
    }

    /**
     * Re-render (debounced) when the changed document is the tracked material or the shader it
     * resolved to, matching by path so editor and server URI encodings still line up.
     */
    private fun onDocumentChanged(changed: VirtualFile) {
        val (file, _) = tracked ?: return
        val changedPath = changed.path.replace('\\', '/').lowercase()
        val trackedPath = file.path.replace('\\', '/').lowercase()
        val shaderPath = previewedShaderPath?.replace('\\', '/')
        if (changedPath != trackedPath && changedPath != shaderPath) return
        refreshAlarm.cancelAllRequests()
        refreshAlarm.addRequest({ render() }, 250)
    }

    /**
     * The `--vscode-*` variables the stylesheet reads, resolved from the IDE theme. VS Code's
     * webview host injects these. JCEF has no such host, so without them every `var()` falls back
     * to the browser defaults (black on white) and the page is unreadable in a dark theme.
     */
    private fun themeCss(): String {
        val toHex = { color: java.awt.Color -> String.format("#%02x%02x%02x", color.red, color.green, color.blue) }
        val background = toHex(UIUtil.getPanelBackground())
        val foreground = toHex(UIUtil.getLabelForeground())
        val description = toHex(UIUtil.getContextHelpForeground())
        val border = toHex(JBColor.border())
        val inputBackground = toHex(UIManager.getColor("TextField.background") ?: UIUtil.getPanelBackground())
        val buttonBackground = toHex(UIManager.getColor("Button.default.startBackground") ?: java.awt.Color(0x36, 0x58, 0x80))
        val buttonForeground = toHex(UIManager.getColor("Button.default.foreground") ?: java.awt.Color.WHITE)
        val labelFont = JBFont.label()
        val editorFont = EditorColorsManager.getInstance().globalScheme.editorFontName
        return """
:root {
    --vscode-font-family: '${labelFont.family}', sans-serif;
    --vscode-font-size: ${labelFont.size}px;
    --vscode-foreground: $foreground;
    --vscode-descriptionForeground: $description;
    --vscode-panel-border: $border;
    --vscode-input-background: $inputBackground;
    --vscode-input-foreground: $foreground;
    --vscode-input-border: $border;
    --vscode-button-background: $buttonBackground;
    --vscode-button-foreground: $buttonForeground;
    --vscode-editor-font-family: '$editorFont', monospace;
}
body {
    background: $background;
    color: $foreground;
}
"""
    }

    /** The page shell: the bundled stylesheet and preview script inlined, plus the VS Code API shim. */
    private fun pageHtml(query: JBCefJSQuery): String {
        val css = Files.readString(PluginPaths.media("shader-preview.css"))
        val script = Files.readString(PluginPaths.media("shader-preview.js"))
        val bridge = query.inject("JSON.stringify(m)")
        return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>$css</style>
<style>${themeCss()}</style>
<title>Shader Preview</title>
</head>
<body>
<div id="stage"><canvas id="gl" width="320" height="320"></canvas><div id="status"></div></div>
<div id="meta"></div>
<div id="controls"></div>
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

    /** Parses a `file:` URI into a filesystem path, null when it cannot be parsed. */
    private fun uriToPath(uri: String): Path? = try {
        Paths.get(java.net.URI(uri))
    } catch (_: Exception) {
        null
    }

    /**
     * Reads a texture into a `data:` URI so the page can show it without filesystem access.
     * Returns null when the file is missing, too large, or not a supported image kind.
     */
    private fun textureDataUri(fileUri: String): String? {
        val path = uriToPath(fileUri) ?: return null
        return try {
            if (Files.size(path) > MAX_TEXTURE_BYTES) return null
            val mime = when (path.toString().substringAfterLast('.').lowercase()) {
                "png" -> "image/png"
                "jpg", "jpeg" -> "image/jpeg"
                else -> return null
            }
            "data:$mime;base64," + Base64.getEncoder().encodeToString(Files.readAllBytes(path))
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        const val TOOL_WINDOW_ID = "Cosmoteer Shader Preview"
        const val SERVER_ID = "cosmoteerLanguageServer"
        /** The largest texture inlined as a data URI, matching the VS Code client's cap. */
        private const val MAX_TEXTURE_BYTES = 16L * 1024 * 1024

        fun getInstance(project: Project): ShaderPreviewService = project.getService(ShaderPreviewService::class.java)
    }
}
