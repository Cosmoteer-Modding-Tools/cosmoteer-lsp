package cosmoteer.grid

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/** Hosts the [PartGridEditorService] browser in the "Cosmoteer Part Grid Editor" tool window. */
class PartGridEditorToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val content = ContentFactory.getInstance()
            .createContent(PartGridEditorService.getInstance(project).component(), "", false)
        toolWindow.contentManager.addContent(content)
    }
}
