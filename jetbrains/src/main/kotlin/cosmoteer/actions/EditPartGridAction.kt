package cosmoteer.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import cosmoteer.grid.PartGridEditorService

/**
 * Opens the interactive part grid editor for the part at the caret. Mirrors the VS Code
 * `cosmoteer.editPartGrid` command. The gutter marker on root `Part` lines calls the same
 * service with the marker's offset.
 */
class EditPartGridAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
        event.presentation.isEnabledAndVisible =
            event.project != null && file?.extension?.equals("rules", ignoreCase = true) == true
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val editor = event.getData(CommonDataKeys.EDITOR) ?: return
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        PartGridEditorService.getInstance(project).edit(file, editor.caretModel.offset)
    }
}
