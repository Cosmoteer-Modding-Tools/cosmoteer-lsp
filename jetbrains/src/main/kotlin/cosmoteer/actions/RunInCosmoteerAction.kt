package cosmoteer.actions

import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.lsp.commandResultOf
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.ExecuteCommandParams
import java.nio.file.Paths

/**
 * Runs the open mod in the game: the server links it into the folder the game loads mods from,
 * switches it on in the game's own settings and starts the game in developer mode. Mirrors the VS
 * Code `cosmoteer.runInGame` command, including the question about which user folder to use and the
 * named reason for every case the server refuses to guess its way through.
 */
class RunInCosmoteerAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val uri = documentUri(event, project) ?: return
        execute(project, uri, null).thenAccept { result -> handle(project, uri, result) }
    }

    /**
     * The file the command is invoked on, which is what the mod is found from. Falls back to the
     * project folder itself so the command still works with no editor open.
     *
     * @param event the action event.
     * @param project the project the action ran in.
     * @return the file uri, or null when the project has no location on disk.
     */
    private fun documentUri(event: AnActionEvent, project: Project): String? {
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
        if (file != null) return runCatching { file.toNioPath().toUri().toString() }.getOrNull()
        val base = project.basePath ?: return null
        return runCatching { Paths.get(base).resolve("mod.rules").toUri().toString() }.getOrNull()
    }

    /**
     * Runs the command on the project's language server.
     *
     * @param project the project whose server is asked.
     * @param uri the file the mod is found from.
     * @param userDataFolder the folder the user picked, when they were asked.
     * @return the raw `workspace/executeCommand` result, null when no server is running.
     */
    private fun execute(project: Project, uri: String, userDataFolder: String?) =
        LanguageServerManager.getInstance(project)
            .getLanguageServer(ShaderPreviewService.SERVER_ID)
            .thenCompose { item ->
                val arguments = JsonObject().apply {
                    addProperty("uri", uri)
                    if (userDataFolder != null) addProperty("userDataFolder", userDataFolder)
                }
                item?.server?.workspaceService
                    ?.executeCommand(ExecuteCommandParams(COMMAND, listOf(arguments)))
                    ?: java.util.concurrent.CompletableFuture.completedFuture<Any?>(null)
            }

    /**
     * Renders what the server answered: the choice of user folder as a dialog, a refusal as its own
     * sentence, and a start as a notification.
     *
     * @param project the project the dialogs and notifications belong to.
     * @param uri the file the command was invoked on, carried through the folder question.
     * @param result the raw `workspace/executeCommand` result (a Gson tree or null).
     */
    private fun handle(project: Project, uri: String, result: Any?) {
        val answer = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val group = NotificationGroupManager.getInstance().getNotificationGroup("Cosmoteer Language Server")
            if (answer == null) {
                group.createNotification("Cosmoteer", "Cosmoteer could not be started.", NotificationType.ERROR)
                    .notify(project)
                return@invokeLater
            }
            when (answer.get("kind")?.asString) {
                "choose-user-data" -> {
                    val candidates = answer.getAsJsonArray("candidates").map { it.asString }.toTypedArray()
                    val chosen = Messages.showChooseDialog(
                        project,
                        "Which Cosmoteer user folder does the game use?",
                        "Run in Cosmoteer",
                        null,
                        candidates,
                        candidates.firstOrNull() ?: ""
                    ) ?: return@invokeLater
                    execute(project, uri, chosen).thenAccept { next -> handle(project, uri, next) }
                }
                "refused" -> {
                    val reason = answer.get("reason")?.asString ?: ""
                    val detail = answer.get("detail")?.asString
                    group.createNotification("Cosmoteer", refusalMessage(reason, detail), NotificationType.ERROR)
                        .notify(project)
                }
                "started" -> {
                    val linked = answer.get("linked")?.asBoolean == true
                    val folder = answer.get("modFolder")?.asString ?: ""
                    val message = if (linked) {
                        "Starting Cosmoteer. The mod is linked into your Mods folder as $folder."
                    } else {
                        "Starting Cosmoteer with the mod enabled."
                    }
                    group.createNotification("Cosmoteer", message, NotificationType.INFORMATION).notify(project)
                    if (answer.get("compatible")?.asBoolean == false) {
                        group.createNotification(
                            "Cosmoteer",
                            "The mod's CompatibleGameVersions does not name the installed game version, " +
                                "so the game will turn it off again while loading.",
                            NotificationType.WARNING
                        ).notify(project)
                    }
                }
            }
        }
    }

    /**
     * The sentence for each reason the run refused. Every one of them is a state the flow will not
     * guess its way through, since it writes into the user's own game settings and mods folder.
     *
     * @param reason the reason the server answered with.
     * @param detail the path or message it named, when it named one.
     * @return the message to show.
     */
    private fun refusalMessage(reason: String, detail: String?): String = when (reason) {
        "unsupported-platform" -> "Cosmoteer ships no macOS build, so it cannot be started from here."
        "no-install" -> "No Cosmoteer install was found. Set the Cosmoteer path in Settings | Tools | Cosmoteer Rules."
        "no-executable" -> "The Cosmoteer executable is missing at ${detail ?: ""}."
        "no-mod" -> "This file is not inside a mod: no mod.rules was found above it."
        "no-user-data" -> "Cosmoteer has no user folder yet. Start the game once, then try again."
        "no-settings-file" ->
            "Cosmoteer has never written its settings file at ${detail ?: ""}, so there is nothing to enable the mod in."
        "game-running" -> "Cosmoteer is running. It rewrites its settings when it exits, so close it first."
        "link-name-taken" -> "${detail ?: ""} already exists and is not a link to this mod. Rename one of them first."
        "link-failed" -> "The mod could not be linked into your Mods folder: ${detail ?: ""}"
        "settings-unparseable" -> "Cosmoteer's settings file could not be read, so it was left untouched."
        "settings-no-game-settings", "settings-no-enabled-mods" ->
            "Cosmoteer's settings file has no enabled-mods list, so it was left untouched."
        "settings-not-equivalent", "settings-bad-entry" ->
            "The change to the settings file did not come out as expected, so nothing was written."
        "settings-write-failed" -> "The settings file could not be written: ${detail ?: ""}"
        else -> "Cosmoteer could not be started."
    }

    companion object {
        private const val COMMAND = "cosmoteer.runInCosmoteer"
    }
}
