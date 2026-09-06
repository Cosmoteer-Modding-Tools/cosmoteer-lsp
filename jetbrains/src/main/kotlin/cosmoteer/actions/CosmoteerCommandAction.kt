package cosmoteer.actions

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.commands.LSPCommand
import com.redhat.devtools.lsp4ij.commands.LSPCommandAction
import cosmoteer.lsp.executeServerCommand
import cosmoteer.lsp.notifyCosmoteer
import java.util.concurrent.CompletableFuture

/**
 * The shape every command of the server that has to run in the client shares: it arrives from a code
 * action carrying one JSON argument object, is answered by the language server so that both clients
 * share one implementation, and reports what happened in one balloon.
 *
 * LSP4IJ resolves a command against the language server first and only looks for an action of the
 * same id when the server does not claim it, which is why the server deliberately leaves these out of
 * its `executeCommandProvider`. The action id in `plugin.xml` must stay exactly the command id the
 * server writes into the code action.
 *
 * @param commandId the server's own command id, the one it declares and answers.
 * @param notificationTitle the title the balloons of this action carry.
 */
abstract class CosmoteerCommandAction(
    private val commandId: String,
    private val notificationTitle: String,
) : LSPCommandAction() {
    final override fun getCommandPerformedThread(): ActionUpdateThread = ActionUpdateThread.EDT

    /**
     * The arguments the code action carried, as a tree this action may add to.
     *
     * @param command the command as it arrived.
     * @returns a mutable copy of the argument object, or null when the command carried none.
     */
    protected fun argumentsOf(command: LSPCommand): JsonObject? {
        val raw = command.originalArguments?.firstOrNull() ?: command.arguments.firstOrNull()
        return (raw as? JsonElement)?.takeIf { it.isJsonObject }?.asJsonObject?.deepCopy()
    }

    /**
     * Runs the command on the project's language server.
     *
     * @param project the project whose server is asked.
     * @param arguments the single argument object the command takes.
     * @returns the raw `workspace/executeCommand` result, null when no server is running.
     */
    protected fun execute(project: Project, arguments: JsonObject): CompletableFuture<Any?> =
        executeServerCommand(project, commandId, arguments)

    /**
     * Shows one outcome notification.
     *
     * @param project the project the notification belongs to.
     * @param content the message body.
     * @param type the notification severity.
     */
    protected fun notify(project: Project, content: String, type: NotificationType) {
        notifyCosmoteer(project, notificationTitle, content, type)
    }
}
