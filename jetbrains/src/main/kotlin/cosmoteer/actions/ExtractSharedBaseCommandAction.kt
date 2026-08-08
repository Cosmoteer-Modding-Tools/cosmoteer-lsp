package cosmoteer.actions

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.redhat.devtools.lsp4ij.commands.LSPCommand
import com.redhat.devtools.lsp4ij.commands.LSPCommandAction
import cosmoteer.lsp.commandResultOf

/**
 * Handles the command the server's "extract shared base file" refactoring carries, so the offer in
 * the editor runs here rather than on the server.
 *
 * LSP4IJ resolves a command against the language server first and only looks for an action of the
 * same id when the server does not claim it, which is why the server deliberately leaves this one
 * out of its `executeCommandProvider`. It has to run here because the rewrite creates a file and
 * edits every file that inherits it, and only the IDE can put that in front of the user as a diff
 * before it happens. The action id in `plugin.xml` must stay exactly the command id the server
 * writes into the code action.
 *
 * Invoked from anywhere else (the action search, say) there is no plan to work from, so it falls
 * back to the whole-project sweep, which is the same thing the Tools menu entry does.
 */
class ExtractSharedBaseCommandAction : LSPCommandAction() {
    override fun getCommandPerformedThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun commandPerformed(command: LSPCommand, event: AnActionEvent) {
        val project = event.project ?: return
        val plan = planOf(command)
        if (plan == null) {
            SharedBaseFlow.executeCommand(project, JsonObject()).thenAccept { result ->
                SharedBaseFlow.showNotification(
                    project,
                    "Run Tools | Cosmoteer: Extract Shared Base Files to pick an extraction " +
                        "(${commandResultOf(result)?.getAsJsonArray("plans")?.size() ?: 0} available).",
                    com.intellij.notification.NotificationType.INFORMATION
                )
            }
            return
        }
        SharedBaseFlow.start(project, plan)
    }

    /**
     * The plan the code action carried, which is the command's single argument.
     *
     * @param command the command as it arrived.
     * @returns the plan, or null when the command was invoked without one.
     */
    private fun planOf(command: LSPCommand): JsonElement? {
        val raw = command.originalArguments?.firstOrNull() ?: command.arguments?.firstOrNull()
        return (raw as? JsonElement)?.takeIf { it.isJsonObject }
    }
}
