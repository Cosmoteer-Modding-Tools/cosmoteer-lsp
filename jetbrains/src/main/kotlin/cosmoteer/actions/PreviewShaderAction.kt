package cosmoteer.actions

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import cosmoteer.preview.ShaderPreviewService

/**
 * Opens the live WebGL shader preview for the material at the caret. Mirrors the VS Code
 * `cosmoteer.previewShader` command. The gutter marker on `Shader = ...` lines calls the same
 * service with the marker's offset.
 */
class PreviewShaderAction : RulesCaretAction() {
    override fun perform(project: Project, file: VirtualFile, offset: Int) {
        ShaderPreviewService.getInstance(project).preview(file, offset)
    }
}
