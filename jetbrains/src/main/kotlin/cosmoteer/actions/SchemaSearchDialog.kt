package cosmoteer.actions

import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SearchTextField
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.Alarm
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.lsp.CosmoteerLanguageServerAPI
import cosmoteer.lsp.SchemaSearchDetailParams
import cosmoteer.lsp.SchemaSearchHit
import cosmoteer.lsp.SchemaSearchParams
import cosmoteer.lsp.SchemaSearchResult
import cosmoteer.lsp.commandResultOf
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.ExecuteCommandParams
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.TextDocumentIdentifier
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.event.ActionEvent
import java.util.concurrent.CompletableFuture
import javax.swing.Action
import javax.swing.DefaultListModel
import javax.swing.JComponent
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.ListSelectionModel
import javax.swing.event.DocumentEvent

/** The caret the search was opened from, so a found field can be written straight back into it. */
data class SchemaSearchCaret(val uri: String, val position: Position)

/**
 * The schema search dialog: a search field over every schema type, field, enum and `Type=` registry
 * plus the field documentation, a ranked result list, and the two things a hit is good for, reading
 * its documentation and writing it at the caret. Mirrors the VS Code `cosmoteer.searchSchema` picker.
 *
 * @param project the project whose language server answers the queries.
 * @param caret the caret the action was invoked from, or null when no rules file was open.
 */
class SchemaSearchDialog(private val project: Project, private val caret: SchemaSearchCaret?) : DialogWrapper(project) {
    private val searchField = SearchTextField()
    private val model = DefaultListModel<SchemaSearchHit>()
    private val hitList = JBList(model)
    private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, disposable)

    /** Writes the selected field at the caret instead of opening its documentation. */
    private val insertAction = object : DialogWrapperAction("Insert At Caret") {
        override fun doAction(event: ActionEvent) {
            selectedHit()?.let { insertField(it) }
        }
    }

    /** What the caret resolved to, shown in the title once the first answer has come back. */
    private var contextLabel: String? = null

    init {
        setTitle(BASE_TITLE)
        setOKButtonText("Open Documentation")
        hitList.selectionMode = ListSelectionModel.SINGLE_SELECTION
        hitList.cellRenderer = HitRenderer()
        hitList.addListSelectionListener { updateActionState() }
        searchField.addDocumentListener(object : DocumentAdapter() {
            override fun textChanged(event: DocumentEvent) = scheduleQuery()
        })
        insertAction.isEnabled = false
        init()
        // The opening query carries the caret, so the list starts on the class the caret is in.
        runQuery(searchField.text, withCaret = true)
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout())
        panel.add(searchField, BorderLayout.NORTH)
        panel.add(JBScrollPane(hitList), BorderLayout.CENTER)
        panel.preferredSize = Dimension(900, 500)
        return panel
    }

    override fun getPreferredFocusedComponent(): JComponent = searchField.textEditor

    override fun createActions(): Array<Action> = arrayOf(insertAction, getOKAction(), getCancelAction())

    override fun doOKAction() {
        val hit = selectedHit() ?: return
        openDocumentation(hit)
        super.doOKAction()
    }

    /** The hit the list is on, or null when nothing is selected. */
    private fun selectedHit(): SchemaSearchHit? = hitList.selectedValue

    /** Enables the insert button only for a field the caret's group can legally carry. */
    private fun updateActionState() {
        val hit = selectedHit()
        insertAction.isEnabled = caret != null && hit != null && hit.insertable
    }

    /** Re-queries after typing settles, so a fast typist issues one request instead of ten. */
    private fun scheduleQuery() {
        alarm.cancelAllRequests()
        alarm.addRequest({ runQuery(searchField.text, withCaret = false) }, QUERY_DELAY_MS)
    }

    /**
     * Sends one search to the server and repaints the list with what comes back.
     *
     * @param query the text typed in the search field.
     * @param withCaret whether to send the caret along, which only the first query of a session does.
     */
    private fun runQuery(query: String, withCaret: Boolean) {
        val params = SchemaSearchParams(query)
        if (withCaret && caret != null) {
            params.textDocument = TextDocumentIdentifier(caret.uri)
            params.position = caret.position
        }
        LanguageServerManager.getInstance(project)
            .getLanguageServer(ShaderPreviewService.SERVER_ID)
            .thenCompose { item ->
                val server = item?.server as? CosmoteerLanguageServerAPI
                    ?: return@thenCompose CompletableFuture.completedFuture<SchemaSearchResult?>(null)
                server.schemaSearch(params)
            }
            .thenAccept { result -> showResult(query, result) }
    }

    /**
     * Replaces the list contents with a search answer, on the UI thread.
     *
     * @param query the query the answer belongs to, dropped when the field has moved on since.
     * @param result the server's answer, or null when the server had nothing to say.
     */
    private fun showResult(query: String, result: SchemaSearchResult?) {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            // A slower earlier query must not overwrite the rows of a later one.
            if (query != searchField.text) return@invokeLater
            if (contextLabel == null) contextLabel = result?.contextClassName
            model.clear()
            for (hit in result?.hits.orEmpty()) model.addElement(hit)
            if (!model.isEmpty) hitList.selectedIndex = 0
            val scope = contextLabel?.let { " — caret is in $it" } ?: ""
            val counted = if (result != null && result.truncated) " — showing ${result.hits.size} of ${result.total}" else ""
            setTitle("$BASE_TITLE$scope$counted")
            updateActionState()
        }
    }

    /**
     * Fetches a hit's documentation and opens it as a read-only in-memory markdown file, rendered by
     * the Markdown plugin when it is installed.
     *
     * @param hit the hit whose page is wanted.
     */
    private fun openDocumentation(hit: SchemaSearchHit) {
        LanguageServerManager.getInstance(project)
            .getLanguageServer(ShaderPreviewService.SERVER_ID)
            .thenCompose { item ->
                val server = item?.server as? CosmoteerLanguageServerAPI
                    ?: return@thenCompose CompletableFuture.completedFuture<String?>(null)
                server.schemaSearchDetail(SchemaSearchDetailParams(hit.id))
            }
            .thenAccept { markdown ->
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed) return@invokeLater
                    if (markdown.isNullOrEmpty()) {
                        notify("No documentation is available for ${hit.label}.", NotificationType.WARNING)
                        return@invokeLater
                    }
                    val page = LightVirtualFile("${hit.label}.md", markdown)
                    page.isWritable = false
                    FileEditorManager.getInstance(project).openFile(page, true)
                }
            }
    }

    /**
     * Asks the server to scaffold a field at the caret the dialog was opened from. The server
     * re-resolves the caret's class before it writes anything, so a refusal here means the field
     * really does not belong there.
     *
     * @param hit the field hit to write.
     */
    private fun insertField(hit: SchemaSearchHit) {
        val target = caret ?: return
        // No document version rides along: the plugin has no access to the version LSP4IJ last sent,
        // and the dialog is modal, so the buffer cannot move while it is open.
        val args = JsonObject().apply {
            addProperty("uri", target.uri)
            addProperty("id", hit.id)
            add("position", JsonObject().apply {
                addProperty("line", target.position.line)
                addProperty("character", target.position.character)
            })
        }
        LanguageServerManager.getInstance(project)
            .getLanguageServer(ShaderPreviewService.SERVER_ID)
            .thenCompose { item ->
                item?.server?.workspaceService
                    ?.executeCommand(ExecuteCommandParams(INSERT_COMMAND, listOf(args)))
                    ?: CompletableFuture.completedFuture<Any?>(null)
            }
            .thenAccept { result ->
                val answer = commandResultOf(result)
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed) return@invokeLater
                    if (answer?.get("inserted")?.asBoolean == true) {
                        val written = answer.get("field")?.takeUnless { it.isJsonNull }?.asString ?: hit.label
                        notify("Wrote $written at the caret.", NotificationType.INFORMATION)
                        close(OK_EXIT_CODE)
                        return@invokeLater
                    }
                    notify(insertFailureMessage(answer?.get("failure")?.asString, hit.label), NotificationType.WARNING)
                }
            }
    }

    /** Posts a one-line outcome under the plugin's own notification group. */
    private fun notify(message: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("Cosmoteer Language Server")
            .createNotification("Cosmoteer schema search", message, type)
            .notify(project)
    }

    /** Paints one row: the name in bold, who declares it in grey, then its type and documentation. */
    private class HitRenderer : ColoredListCellRenderer<SchemaSearchHit>() {
        override fun customizeCellRenderer(
            list: JList<out SchemaSearchHit>,
            value: SchemaSearchHit,
            index: Int,
            selected: Boolean,
            hasFocus: Boolean,
        ) {
            append(value.label, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
            append("  ${value.owner}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            val marks = mutableListOf<String>()
            if (value.deprecated) marks.add("removed in a newer game version")
            else if (value.dead) marks.add("never read by the game")
            if (value.modContributed) marks.add("from a code mod")
            if (marks.isNotEmpty()) append("  ⚠ ${marks.joinToString(", ")}", SimpleTextAttributes.ERROR_ATTRIBUTES)
            append("  ${value.detail}", SimpleTextAttributes.GRAY_ITALIC_ATTRIBUTES)
            val prose = value.prose
            if (!prose.isNullOrEmpty()) append("  $prose", SimpleTextAttributes.GRAY_ITALIC_ATTRIBUTES)
        }
    }

    companion object {
        /** The dialog title, extended with the caret's class and the match count once known. */
        private const val BASE_TITLE = "Search Cosmoteer Schema"

        /** How long typing settles before the next query goes out. */
        private const val QUERY_DELAY_MS = 150

        /** The server command that scaffolds a found field at the caret. */
        private const val INSERT_COMMAND = "cosmoteer.insertSchemaField"

        /**
         * Why an insert did nothing, in a sentence the user can act on.
         *
         * @param failure the reason the server reported, or null when it answered nothing at all.
         * @param label the field that was going to be written.
         * @return the message to show.
         */
        private fun insertFailureMessage(failure: String?, label: String): String = when (failure) {
            "stale" -> "The file changed while the search was open, so nothing was written."
            "classMismatch" -> "$label is not a field of the group the caret is in, so nothing was written."
            "noContext" -> "The caret is not in a group whose type is known, so nothing was written."
            "editRejected" -> "The editor turned down the change, so nothing was written."
            else -> "$label could not be written at the caret."
        }
    }
}
