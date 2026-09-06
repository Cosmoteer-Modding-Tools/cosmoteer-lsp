package cosmoteer.actions

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/**
 * Requests what the group at the caret loads differently from the nearest base of it the game ships
 * itself, and opens the answer as a read-only in-memory markdown document. Mirrors the VS Code
 * `cosmoteer.diffAgainstBase` command.
 */
class DiffAgainstBaseAction : RulesCaretAction() {
    override fun perform(project: Project, file: VirtualFile, offset: Int) {
        showBaseDiff(project, file, offset)
    }
}

/**
 * Fetches and shows the comparison for the group at an offset.
 *
 * @param project the project whose language server is queried.
 * @param file the `.rules` file containing the group.
 * @param offset a caret offset inside the group.
 */
fun showBaseDiff(project: Project, file: VirtualFile, offset: Int) {
    val params = positionParamsFor(file, offset) ?: return
    showServerMarkdown(
        project,
        "What This Group Changes.md",
        "No comparison available",
        "This group does not derive from a file the game ships."
    ) { server -> server.baseDiff(params) }
}
