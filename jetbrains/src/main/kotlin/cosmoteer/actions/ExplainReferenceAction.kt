package cosmoteer.actions

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/**
 * Requests the explanation of the reference at the caret and opens it as a read-only in-memory
 * markdown document. Mirrors the VS Code `cosmoteer.explainReference` command.
 *
 * No gutter marker: a reference is far too common for a marker of its own, so this lives in the Tools
 * and editor-popup menus.
 */
class ExplainReferenceAction : RulesCaretAction() {
    override fun perform(project: Project, file: VirtualFile, offset: Int) {
        explainReference(project, file, offset)
    }
}

/**
 * Fetches and shows the report for the reference at an offset.
 *
 * @param project the project whose language server is queried.
 * @param file the `.rules` file containing the reference.
 * @param offset a caret offset on the reference.
 */
fun explainReference(project: Project, file: VirtualFile, offset: Int) {
    val params = positionParamsFor(file, offset) ?: return
    showServerMarkdown(
        project,
        "What This Reference Points At.md",
        "No report available",
        "The caret is not on a reference."
    ) { server -> server.explainReference(params) }
}
