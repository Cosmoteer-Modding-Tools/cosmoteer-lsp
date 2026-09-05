package cosmoteer.lsp

import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.ExecuteCommandParams
import java.util.concurrent.CompletableFuture

/** The notification group every balloon of this plugin is shown in. */
private const val NOTIFICATION_GROUP = "Cosmoteer Language Server"

/**
 * Runs one of the server's own requests, which needs the running server typed as the Cosmoteer
 * protocol surface rather than as a plain language server.
 *
 * @param project the project whose server is asked.
 * @param request what to ask the server once it is there.
 * @returns the answer, or null when no Cosmoteer server is running.
 */
fun <T> requestFromServer(
    project: Project,
    request: (CosmoteerLanguageServerAPI) -> CompletableFuture<T?>,
): CompletableFuture<T?> =
    LanguageServerManager.getInstance(project)
        .getLanguageServer(ShaderPreviewService.SERVER_ID)
        .thenCompose { item ->
            val server = item?.server as? CosmoteerLanguageServerAPI
                ?: return@thenCompose CompletableFuture.completedFuture<T?>(null)
            request(server)
        }

/**
 * Runs one `workspace/executeCommand` on the project's language server, which owns every command so
 * that both clients share one implementation.
 *
 * @param project the project whose server is asked.
 * @param command the server's own command id.
 * @param arguments the arguments the command takes.
 * @returns the raw result, or null when no server is running.
 */
fun executeServerCommand(project: Project, command: String, arguments: List<Any>): CompletableFuture<Any?> =
    LanguageServerManager.getInstance(project)
        .getLanguageServer(ShaderPreviewService.SERVER_ID)
        .thenCompose { item ->
            item?.server?.workspaceService
                ?.executeCommand(ExecuteCommandParams(command, arguments))
                ?: CompletableFuture.completedFuture<Any?>(null)
        }

/**
 * Runs one `workspace/executeCommand` that takes a single argument object, which is the shape every
 * command of this plugin speaks.
 *
 * @param project the project whose server is asked.
 * @param command the server's own command id.
 * @param arguments the single argument object.
 * @returns the raw result, or null when no server is running.
 */
fun executeServerCommand(project: Project, command: String, arguments: JsonObject): CompletableFuture<Any?> =
    executeServerCommand(project, command, listOf(arguments))

/**
 * The failure code a command answer carries.
 *
 * @returns the code, or null when the round did what it was asked.
 */
fun JsonObject.failureCode(): String? = get("failure")?.takeIf { !it.isJsonNull }?.asString

/**
 * Shows one balloon in the server's own notification group.
 *
 * @param project the project the balloon belongs to.
 * @param title the balloon's title.
 * @param content the message body.
 * @param type the balloon's severity.
 */
fun notifyCosmoteer(project: Project, title: String, content: String, type: NotificationType) {
    NotificationGroupManager.getInstance()
        .getNotificationGroup(NOTIFICATION_GROUP)
        .createNotification(title, content, type)
        .notify(project)
}
