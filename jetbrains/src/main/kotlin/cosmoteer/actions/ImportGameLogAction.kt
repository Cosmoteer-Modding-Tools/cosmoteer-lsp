package cosmoteer.actions

import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.testFramework.LightVirtualFile
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.lsp.commandResultOf
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.ExecuteCommandParams
import java.net.URI
import java.nio.file.Paths

/**
 * Imports what the game itself said the last time it loaded this mod. The game reports what it
 * refused to load only into its log file, so a mod can be shipped broken while the editor shows
 * nothing at all.
 *
 * Rendered as a report rather than as editor warnings: these findings are a recording of a past run
 * and nothing an edit does can make them true again, so they must not sit in the same channel as the
 * live checks, which is the only channel this plugin has today.
 */
class ImportGameLogAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
        val uri = runCatching { file?.toNioPath()?.toUri()?.toString() }.getOrNull()
            ?: runCatching { Paths.get(project.basePath!!).resolve("mod.rules").toUri().toString() }.getOrNull()
            ?: return
        execute(project, uri).thenAccept { result -> show(project, result) }
    }

    /**
     * Runs the import on the project's language server.
     *
     * @param project the project whose server is asked.
     * @param uri the file the mod is found from.
     * @return the raw `workspace/executeCommand` result, null when no server is running.
     */
    private fun execute(project: Project, uri: String) =
        LanguageServerManager.getInstance(project)
            .getLanguageServer(ShaderPreviewService.SERVER_ID)
            .thenCompose { item ->
                val arguments = JsonObject().apply { addProperty("uri", uri) }
                item?.server?.workspaceService
                    ?.executeCommand(ExecuteCommandParams(COMMAND, listOf(arguments)))
                    ?: java.util.concurrent.CompletableFuture.completedFuture<Any?>(null)
            }

    /**
     * Renders the import: a notification for every outcome that has nothing to show, and a markdown
     * report listing each finding with the file and line it belongs to.
     *
     * @param project the project the report belongs to.
     * @param result the raw `workspace/executeCommand` result (a Gson tree or null).
     */
    private fun show(project: Project, result: Any?) {
        val answer = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val group = NotificationGroupManager.getInstance().getNotificationGroup("Cosmoteer Language Server")
            val message = when (answer?.get("kind")?.asString) {
                null -> "The game log could not be read."
                "no-mod" -> "This file is not inside a mod: no mod.rules was found above it."
                "no-logs" -> "Cosmoteer has written no logs yet. Run the game once, then try again."
                "nothing-for-this-mod" -> "No game log mentions this mod. The game reports a mod only while it loads it."
                else -> null
            }
            if (message != null) {
                group.createNotification("Cosmoteer game log", message, NotificationType.INFORMATION).notify(project)
                return@invokeLater
            }
            val report = LightVirtualFile("Cosmoteer Game Log.md", buildReport(answer!!))
            report.isWritable = false
            FileEditorManager.getInstance(project).openFile(report, true)
        }
    }

    /**
     * The markdown report: the run the findings came from, then one line per finding as
     * `path:line message`.
     *
     * @param answer the server's import result as a Gson object.
     * @return the report text.
     */
    private fun buildReport(answer: JsonObject): String {
        val log = answer.getAsJsonObject("log")
        val diagnostics = answer.getAsJsonArray("diagnostics") ?: com.google.gson.JsonArray()
        val lines = mutableListOf("# What the game said", "")
        lines.add("From the run of ${log?.get("time")?.asString ?: "?"}, Cosmoteer ${log?.get("gameVersion")?.asString ?: "?"}.")
        lines.add("")
        if (diagnostics.size() == 0) {
            lines.add("Nothing from that run still fits the files as they are now.")
        }
        for (element in diagnostics) {
            val entry = element.asJsonObject
            val uri = entry.get("uri")?.asString ?: continue
            val diagnostic = entry.getAsJsonObject("diagnostic")
            val line = diagnostic.getAsJsonObject("range").getAsJsonObject("start").get("line").asInt + 1
            val text = diagnostic.get("message")?.asString ?: ""
            val path = runCatching { Paths.get(URI(uri)).toString() }.getOrDefault(uri)
            lines.add("- $path:$line $text")
        }
        val stale = answer.get("stale")?.asInt ?: 0
        if (stale > 0) {
            lines.add("")
            lines.add("$stale findings of that run no longer fit the files and were left out.")
        }
        lines.add("")
        return lines.joinToString("\n")
    }

    companion object {
        private const val COMMAND = "cosmoteer.readGameLog"
    }
}
