package cosmoteer.preview

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/** Hosts the [ShaderPreviewService] browser in the "Cosmoteer Shader Preview" tool window. */
class ShaderPreviewToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val content = ContentFactory.getInstance()
            .createContent(ShaderPreviewService.getInstance(project).component(), "", false)
        toolWindow.contentManager.addContent(content)
    }
}
