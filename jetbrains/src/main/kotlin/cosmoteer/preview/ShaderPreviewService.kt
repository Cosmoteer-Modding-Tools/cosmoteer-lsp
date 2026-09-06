package cosmoteer.preview

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
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
import com.intellij.util.Alarm
import com.redhat.devtools.lsp4ij.LSPIJUtils
import cosmoteer.lsp.requestFromServer
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.TextDocumentPositionParams
import javax.swing.JComponent

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
    private val page = JcefPageHost(
        "Shader Preview",
        "shader-preview",
        PAGE_BODY,
        // Windowed (non-OSR) mode: the platform default is off-screen rendering, where Chromium's
        // GPU-composited layers never reach the software-composited frame and the WebGL canvas
        // stays black. Remote dev forces OSR regardless, the preview degrades to a black stage there.
        false,
        "The shader preview needs the embedded browser (JCEF), which this IDE runtime does not support.",
        logger<ShaderPreviewService>(),
        "Bad message from the shader preview page",
        ::onPageMessage
    )
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
    fun component(): JComponent = page.component()

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
        requestFromServer(project) { server -> server.shaderPreview(params) }
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
            page.post("""{"type":"empty"}""")
            return
        }
        previewedShaderPath = data.get("shaderUri")?.takeUnless { it.isJsonNull }?.asString
            ?.let { JcefSupport.uriToPath(it)?.toString()?.lowercase() }
        val textureData = JsonObject()
        val textures = data.getAsJsonArray("textures") ?: com.google.gson.JsonArray()
        for (texture in textures) {
            val obj = texture.asJsonObject
            val name = obj.get("name")?.asString ?: continue
            val uri = obj.get("uri")?.takeUnless { it.isJsonNull }?.asString
            val dataUri = uri?.let { JcefSupport.imageDataUri(it) }
            if (dataUri != null) textureData.addProperty(name, dataUri) else textureData.add(name, com.google.gson.JsonNull.INSTANCE)
        }
        val message = JsonObject().apply {
            addProperty("type", "render")
            add("data", data)
            add("textureData", textureData)
        }
        page.post(gson.toJson(message))
    }

    /** Handles messages the page sends through the shimmed `acquireVsCodeApi().postMessage`. */
    private fun onPageMessage(message: JsonObject) {
        when (message.get("type")?.asString) {
            "openShader" -> {
                val uri = message.get("uri")?.asString ?: return
                ApplicationManager.getApplication().invokeLater {
                    val path = JcefSupport.uriToPath(uri) ?: return@invokeLater
                    val file = VfsUtil.findFile(path, true) ?: return@invokeLater
                    OpenFileDescriptor(project, file).navigate(true)
                }
            }
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

    override fun dispose() {
        page.dispose()
    }

    companion object {
        const val TOOL_WINDOW_ID = "Cosmoteer Shader Preview"
        const val SERVER_ID = "cosmoteerLanguageServer"

        /** The page's markup, which the shared script draws into. */
        private const val PAGE_BODY =
            """<div id="stage"><canvas id="gl" width="320" height="320"></canvas><div id="status"></div></div>
<div id="meta"></div>
<div id="controls"></div>"""

        fun getInstance(project: Project): ShaderPreviewService = project.getService(ShaderPreviewService::class.java)
    }
}
