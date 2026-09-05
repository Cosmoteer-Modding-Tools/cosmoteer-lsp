package cosmoteer.table

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/** Hosts the [PartTableService] browser in the "Cosmoteer Part Table" tool window. */
class PartTableToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val content = ContentFactory.getInstance()
            .createContent(PartTableService.getInstance(project).component(), "", false)
        toolWindow.contentManager.addContent(content)
    }
}
