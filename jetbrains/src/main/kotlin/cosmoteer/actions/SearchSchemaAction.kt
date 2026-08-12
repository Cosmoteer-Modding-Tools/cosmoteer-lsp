package cosmoteer.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.redhat.devtools.lsp4ij.LSPIJUtils
import org.eclipse.lsp4j.Position

/**
 * Opens the schema search: every schema type, field, enum and `Type=` registry, plus the field
 * documentation, searchable by name or by wording. When a `.rules` file is open the caret rides
 * along, so the search knows which class the caret sits in and can write a found field straight
 * into it. Mirrors the VS Code `cosmoteer.searchSchema` command.
 */
class SearchSchemaAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        // Workspace-wide on purpose: looking a field up is most useful before a file is even open.
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        SchemaSearchDialog(project, caretOf(event)).show()
    }

    /**
     * The caret of the open `.rules` editor, as the uri and zero-based position the server expects.
     *
     * @param event the action event the caret is read from.
     * @return the caret, or null when no rules file is in the editor.
     */
    private fun caretOf(event: AnActionEvent): SchemaSearchCaret? {
        val editor = event.getData(CommonDataKeys.EDITOR) ?: return null
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE) ?: return null
        if (!file.extension.equals("rules", ignoreCase = true)) return null
        val document = editor.document
        val offset = editor.caretModel.offset.coerceIn(0, document.textLength)
        val line = document.getLineNumber(offset)
        return SchemaSearchCaret(
            LSPIJUtils.toUri(file).toASCIIString(),
            Position(line, offset - document.getLineStartOffset(line))
        )
    }
}
