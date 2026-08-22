package cosmoteer.lsp

import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.redhat.devtools.lsp4ij.LanguageServerManager
import com.redhat.devtools.lsp4ij.server.ProcessStreamConnectionProvider
import cosmoteer.PluginPaths
import cosmoteer.node.ManagedNodeRuntime
import cosmoteer.settings.CosmoteerSettings

/**
 * Launches the bundled `server.mjs` over stdio with a Node.js runtime. Node is taken from the
 * plugin settings when set, then from PATH, then from the runtime the plugin downloaded itself.
 * With none of those, a notification offers the download. The l10n bundle path is passed the same
 * way the VS Code client does it, so server messages follow the IDE language.
 */
class CosmoteerConnectionProvider(project: Project) : ProcessStreamConnectionProvider() {
    init {
        val node = resolveNode(project)
        // The young-generation size the VS Code client also passes. A whole-mod check allocates one
        // AST per file and drops it again, which fills Node's default young generation hundreds of
        // times and promotes short-lived objects into the old generation, where clearing them costs
        // a pause the user sees. `--expose-gc` lets the server hand that memory back once a check is
        // over rather than sit on it.
        commands = listOf(node, "--max-semi-space-size=64", "--expose-gc", PluginPaths.serverJs().toString(), "--stdio")
        project.basePath?.let { workingDirectory = it }
        userEnvironmentVariables = mapOf("EXTENSION_BUNDLE_PATH" to PluginPaths.l10nBundle().toString())
    }

    /**
     * Picks the Node.js executable to run the server with.
     *
     * @param project the project, used to anchor the missing-node notification and to restart the
     * server once a download finishes.
     * @returns the configured path, a PATH hit, the managed runtime, or the bare command as a last
     * resort (which fails to spawn and surfaces in the LSP console).
     */
    private fun resolveNode(project: Project): String {
        val configured = CosmoteerSettings.getInstance().state.nodePath.trim()
        if (configured.isNotEmpty()) return configured
        val executable = if (SystemInfo.isWindows) "node.exe" else "node"
        PathEnvironmentVariableUtil.findInPath(executable)?.let { return it.absolutePath }
        ManagedNodeRuntime.executable()?.let { return it.toString() }
        offerDownload(project)
        return executable
    }

    /** Shows the missing-node notification, with the runtime download as the primary action. */
    private fun offerDownload(project: Project) {
        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup("Cosmoteer Language Server")
            .createNotification(
                "Node.js not found",
                "The Cosmoteer language server runs on Node.js, which is not installed on this system. " +
                    "The plugin can download a private copy (about 30 MB from nodejs.org), " +
                    "or set a path in Settings | Tools | Cosmoteer Rules.",
                NotificationType.WARNING
            )
        if (ManagedNodeRuntime.isDownloadable()) {
            notification.addAction(NotificationAction.createSimpleExpiring("Download Node.js") {
                ManagedNodeRuntime.download(project) {
                    val manager = LanguageServerManager.getInstance(project)
                    manager.stop(SERVER_ID)
                    manager.start(SERVER_ID)
                }
            })
        }
        notification.notify(project)
    }

    companion object {
        private const val SERVER_ID = "cosmoteerLanguageServer"
    }
}
