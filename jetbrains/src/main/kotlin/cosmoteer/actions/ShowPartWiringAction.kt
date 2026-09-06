package cosmoteer.actions

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/**
 * Requests the part wiring report for the part at the caret and opens it as a read-only in-memory
 * markdown document (rendered by the Markdown plugin when installed). Mirrors the VS Code
 * `cosmoteer.showPartWiring` command.
 *
 * There is no gutter marker for this: `CosmoteerLineMarkerProvider` returns at most one marker per
 * element and already claims the root `Part` line for the grid editor, so the JetBrains entry point
 * is the Tools and editor-popup menus. VS Code gets a lens because CodeLenses stack.
 */
class ShowPartWiringAction : RulesCaretAction() {
    override fun perform(project: Project, file: VirtualFile, offset: Int) {
        showPartWiring(project, file, offset)
    }
}

/**
 * Fetches and shows the wiring report for the part at an offset.
 *
 * @param project the project whose language server is queried.
 * @param file the `.rules` file containing the part.
 * @param offset a caret offset inside the part group.
 */
fun showPartWiring(project: Project, file: VirtualFile, offset: Int) {
    val params = positionParamsFor(file, offset) ?: return
    showServerMarkdown(
        project,
        "Part Wiring.md",
        "No part wiring available",
        "The caret is not inside a part."
    ) { server -> server.partWiring(params) }
}
