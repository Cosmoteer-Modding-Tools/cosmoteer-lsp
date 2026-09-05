package cosmoteer.diagram

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/** Hosts the [DiagramService] browser in the "Cosmoteer Diagram" tool window. */
class DiagramToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val content = ContentFactory.getInstance()
            .createContent(DiagramService.getInstance(project).component(), "", false)
        toolWindow.contentManager.addContent(content)
    }
}
