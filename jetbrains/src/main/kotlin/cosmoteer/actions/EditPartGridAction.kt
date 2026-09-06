package cosmoteer.actions

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import cosmoteer.grid.PartGridEditorService

/**
 * Opens the interactive part grid editor for the part at the caret. Mirrors the VS Code
 * `cosmoteer.editPartGrid` command. The gutter marker on root `Part` lines calls the same
 * service with the marker's offset.
 */
class EditPartGridAction : RulesCaretAction() {
    override fun perform(project: Project, file: VirtualFile, offset: Int) {
        PartGridEditorService.getInstance(project).edit(file, offset)
    }
}
