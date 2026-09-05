package cosmoteer.actions

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/**
 * Requests the "what the game actually loads here" report for the group at the caret and opens it as
 * a read-only in-memory markdown document. Mirrors the VS Code `cosmoteer.showEffectiveGroup`
 * command.
 *
 * No gutter marker: the report applies to every group, and `CosmoteerLineMarkerProvider` returns at
 * most one marker per element, so this lives in the Tools and editor-popup menus.
 */
class ShowEffectiveGroupAction : RulesCaretAction() {
    override fun perform(project: Project, file: VirtualFile, offset: Int) {
        showEffectiveGroup(project, file, offset)
    }
}

/**
 * Fetches and shows the effective-member report for the group at an offset.
 *
 * @param project the project whose language server is queried.
 * @param file the `.rules` file containing the group.
 * @param offset a caret offset inside the group.
 */
fun showEffectiveGroup(project: Project, file: VirtualFile, offset: Int) {
    val params = positionParamsFor(file, offset) ?: return
    showServerMarkdown(
        project,
        "What The Game Loads.md",
        "No report available",
        "The caret is not inside a readable group."
    ) { server -> server.effectiveGroup(params) }
}
