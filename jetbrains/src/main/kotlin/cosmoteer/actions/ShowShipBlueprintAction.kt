package cosmoteer.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.redhat.devtools.lsp4ij.LSPIJUtils
import cosmoteer.lsp.ModFileParams
import org.eclipse.lsp4j.TextDocumentIdentifier

/**
 * Reads what a `.ship.png` blueprint places and opens the answer as a read-only in-memory markdown
 * document. Mirrors the VS Code `cosmoteer.showShipBlueprint` command.
 */
class ShowShipBlueprintAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val context = event.getData(CommonDataKeys.VIRTUAL_FILE)
        val file =
            if (context != null && context.name.endsWith(".ship.png", ignoreCase = true)) context
            else chooseBlueprint(project) ?: return
        showShipBlueprint(project, file)
    }
}

/**
 * Asks for the blueprint to read, for the reader who invoked the action with something else selected.
 * A saved ship is a picture rather than a rules file, so it is rarely the file being edited.
 *
 * @param project the project the dialog belongs to.
 * @return the chosen file, or null when the dialog was dismissed.
 */
private fun chooseBlueprint(project: Project): VirtualFile? {
    // Single-file descriptor built directly, the way the settings page builds its pickers: the
    // factory helpers are deprecated release by release while this constructor is only obsolete.
    // Args: chooseFiles, chooseFolders, chooseJars, chooseJarsAsFiles, chooseJarContents, chooseMultiple.
    val descriptor = FileChooserDescriptor(true, false, false, false, false, false)
        .withTitle("Select a Saved Ship")
        .withExtensionFilter("png")
    return FileChooser.chooseFile(descriptor, project, null)
}

/**
 * Fetches and shows the blueprint report for a saved ship.
 *
 * @param project the project whose language server is queried.
 * @param file the `.ship.png` file.
 */
fun showShipBlueprint(project: Project, file: VirtualFile) {
    val params = ModFileParams(TextDocumentIdentifier(LSPIJUtils.toUri(file).toASCIIString()))
    showServerMarkdown(
        project,
        "Ship Blueprint.md",
        "No blueprint here",
        "This file does not carry a saved ship."
    ) { server -> server.shipBlueprint(params) }
}
