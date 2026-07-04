package cosmoteer.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import cosmoteer.preview.ShaderPreviewService

/**
 * Opens the live WebGL shader preview for the material at the caret. Mirrors the VS Code
 * `cosmoteer.previewShader` command. The gutter marker on `Shader = ...` lines calls the same
 * service with the marker's offset.
 */
class PreviewShaderAction : AnAction() {
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
        ShaderPreviewService.getInstance(project).preview(file, editor.caretModel.offset)
    }
}
