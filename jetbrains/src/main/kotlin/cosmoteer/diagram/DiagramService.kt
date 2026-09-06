package cosmoteer.diagram

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
import cosmoteer.preview.JcefPageHost
import cosmoteer.preview.JcefSupport
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.TextDocumentPositionParams
import javax.swing.JComponent

/** Which drawn view the tool window is showing. */
enum class DiagramKind {
    /** The resource wiring of a part. */
    RESOURCE_FLOW,

    /** The firing chain of a part. */
    EFFECT_CHAIN
}

/**
 * Owns the drawn diagrams: a JCEF browser running the same page the VS Code extension ships
 * (`media/diagram-view.js`). A part's resource flow and its firing chain both render in it, one at
 * a time. The service asks the language server for whichever payload was
 * invoked and pushes it into the page as a `message` event, re-asking after a short debounce when
 * the document it was built from changes.
 */
@Service(Service.Level.PROJECT)
class DiagramService(private val project: Project) : Disposable {
    private val gson = Gson()
    private val page = JcefPageHost(
        "Diagram",
        "diagram-view",
        PAGE_BODY,
        null,
        "The diagrams need the embedded browser (JCEF), which this IDE runtime does not support.",
        logger<DiagramService>(),
        "Bad message from the diagram page",
        ::onPageMessage
    )
    /** What is being drawn, re-queried when its document changes. */
    @Volatile private var tracked: Triple<DiagramKind, VirtualFile, Int>? = null
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
     * Draws one of the views: shows the tool window, remembers what it is drawing, and asks for it.
     *
     * @param kind which view to draw.
     * @param file the `.rules` file it is built from.
     * @param offset the caret offset inside it.
     */
    fun show(kind: DiagramKind, file: VirtualFile, offset: Int) {
        tracked = Triple(kind, file, offset)
        ApplicationManager.getApplication().invokeLater {
            ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.show()
            render()
        }
    }

    /** Queries the server for the tracked view and pushes the result into the page. */
    private fun render() {
        val (kind, file, offset) = tracked ?: return
        val uri = LSPIJUtils.toUri(file).toASCIIString()
        val params = ReadAction.compute<TextDocumentPositionParams?, RuntimeException> {
            val document = FileDocumentManager.getInstance().getDocument(file) ?: return@compute null
            val safeOffset = offset.coerceIn(0, document.textLength)
            val line = document.getLineNumber(safeOffset)
            TextDocumentPositionParams(
                TextDocumentIdentifier(uri),
                Position(line, safeOffset - document.getLineStartOffset(line))
            )
        } ?: return
        requestFromServer(project) { server ->
            when (kind) {
                DiagramKind.RESOURCE_FLOW -> server.resourceFlowDiagram(params)
                DiagramKind.EFFECT_CHAIN -> server.effectChainDiagram(params)
            }
        }
            .thenAccept { data -> postDiagram(data) }
            .exceptionally { error ->
                logger<DiagramService>().warn("Diagram request failed", error)
                null
            }
    }

    /**
     * Posts a payload into the page, or an empty diagram when the server had none.
     *
     * @param data the payload the server answered with.
     */
    private fun postDiagram(data: JsonObject?) {
        val message = JsonObject().apply {
            addProperty("type", "diagram")
            if (data != null) add("diagram", data)
        }
        page.post(gson.toJson(message))
    }

    /** Handles messages the page sends through the shimmed `acquireVsCodeApi().postMessage`. */
    private fun onPageMessage(message: JsonObject) {
        when (message.get("type")?.asString) {
            "openLocation" -> {
                val uri = message.get("uri")?.asString ?: return
                val line = message.getAsJsonObject("range")?.getAsJsonObject("start")?.get("line")?.asInt ?: 0
                ApplicationManager.getApplication().invokeLater {
                    val path = JcefSupport.uriToPath(uri) ?: return@invokeLater
                    val file = VfsUtil.findFile(path, true) ?: return@invokeLater
                    OpenFileDescriptor(project, file, line, 0).navigate(true)
                }
            }
        }
    }

    /**
     * Re-draws (debounced) when the changed document is the one the view was built from.
     *
     * @param changed the document that changed.
     */
    private fun onDocumentChanged(changed: VirtualFile) {
        val (_, file, _) = tracked ?: return
        if (changed.path.replace('\\', '/').lowercase() != file.path.replace('\\', '/').lowercase()) return
        refreshAlarm.cancelAllRequests()
        refreshAlarm.addRequest({ render() }, 300)
    }

    override fun dispose() {
        page.dispose()
    }

    companion object {
        const val TOOL_WINDOW_ID = "Cosmoteer Diagram"

        /** The page's markup, which the shared script draws into. */
        private const val PAGE_BODY = """<div id="page">
<div id="header">
<div id="title"></div>
<div id="subtitle" hidden></div>
<div id="controls">
<input id="filter" type="search" />
<button id="fit" type="button">Fit</button>
<div id="legend"></div>
</div>
</div>
<div id="stage"><svg id="canvas"></svg><div id="empty"></div></div>
<ul id="notes" hidden></ul>
</div>"""

        fun getInstance(project: Project): DiagramService = project.getService(DiagramService::class.java)
    }
}
