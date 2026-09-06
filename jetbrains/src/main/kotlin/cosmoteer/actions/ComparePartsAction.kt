package cosmoteer.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import cosmoteer.table.PartTableService

/**
 * Opens the part comparison table, scoped to the mod the invoking file sits in. Mirrors the VS Code
 * `cosmoteer.compareParts` command.
 */
class ComparePartsAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        PartTableService.getInstance(project).show(event.getData(CommonDataKeys.VIRTUAL_FILE))
    }
}
