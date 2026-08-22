package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.lsp.commandResultOf
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.ExecuteCommandParams
import java.nio.file.Paths
import java.util.concurrent.CompletableFuture

/**
 * Creates a new content file and wires it into the game, in the two rounds the server's command
 * speaks: the first reports what can be created in this mod and which ship classes a part could be
 * registered in, the second writes the file, registers it and adds its localization keys.
 *
 * Creating and registering are one exchange because a content file nothing registers is typed by
 * nothing and loaded by nothing, so an author would see every symptom of a broken editor and none of
 * the cause. The questions the exchange asks are choices only the author can make, which is why this
 * runs here and not on the server.
 */
class NewContentAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        // The command has to be reachable with nothing open, so the project folder stands in for a
        // file. The server reads a folder as a file inside it, which is where the mod is looked for.
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
        val uri = runCatching { file?.toNioPath()?.toUri()?.toString() }.getOrNull()
            ?: runCatching { Paths.get(project.basePath!!).toUri().toString() }.getOrNull()
            ?: return
        val args = JsonObject().apply { addProperty("uri", uri) }
        executeCommand(project, args).thenAccept { result -> ask(project, uri, result) }
    }

    /**
     * Asks what to create, what to call it and where to register it, then runs the creation.
     *
     * @param project the project the dialogs and notifications belong to.
     * @param uri the file or folder the mod was found from.
     * @param result the raw scan result (a Gson tree or null).
     */
    private fun ask(project: Project, uri: String, result: Any?) {
        val scan = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (scan == null) {
                notify(
                    project,
                    "The server did not answer the request, so nothing was created. " +
                        "Check that the Cosmoteer language server is running.",
                    NotificationType.WARNING
                )
                return@invokeLater
            }
            val failure = scan.get("failure")?.takeIf { !it.isJsonNull }?.asString
            if (failure != null) {
                notify(project, failureMessage(failure), NotificationType.WARNING)
                return@invokeLater
            }

            val kinds = (scan.getAsJsonArray("kinds") ?: JsonArray()).map { it.asJsonObject }
            if (kinds.isEmpty()) return@invokeLater
            val kindLabels = kinds.map { kindLabel(it) }.toTypedArray()
            val kindChoice = chooseOne(
                project,
                "A part is registered in a ship class. A resource is registered with an action in " +
                    "this mod's mod.rules. Nothing in the game registers a shot or a media effect, " +
                    "so those are created and the reference a part has to carry is handed back.",
                "Cosmoteer: New Content File",
                kindLabels
            )
            if (kindChoice < 0) return@invokeLater
            val kind = kinds[kindChoice]
            val kindId = kind.get("kind")?.asString ?: return@invokeLater

            val prefix = scan.get("idPrefix")?.takeIf { !it.isJsonNull }?.asString.orEmpty()
            val hint = if (kindId == "resource" || prefix.isEmpty()) {
                "The file, its folder and its id are derived from this."
            } else {
                "The file, its folder and the id $prefix.<name> are derived from this."
            }
            val name = Messages.showInputDialog(project, hint, "Cosmoteer: New Content File", null)
            if (name.isNullOrBlank()) return@invokeLater

            val args = JsonObject().apply {
                addProperty("uri", uri)
                addProperty("kind", kindId)
                addProperty("name", name)
            }
            if (kind.get("registration")?.asString == "ship") {
                if (!chooseShip(project, scan, args)) return@invokeLater
            }
            executeCommand(project, args).thenAccept { applied -> report(project, applied) }
        }
    }

    /**
     * Lets the author pick the ship class a new part is registered in, or say that it stays unwired.
     *
     * @param project the project the dialog belongs to.
     * @param scan the scan result holding the ship classes.
     * @param args the arguments the answer is added to.
     * @return true when the exchange should go on, false when the author backed out.
     */
    private fun chooseShip(project: Project, scan: JsonObject, args: JsonObject): Boolean {
        val ships = (scan.getAsJsonArray("ships") ?: JsonArray())
            .map { it.asJsonObject }
            .filter { it.get("blocked")?.isJsonNull != false }
        val unwired = "Do not register it yet"
        val labels = (ships.map { shipLabel(it) } + unwired).toTypedArray()
        val choice = chooseOne(
            project,
            "The part is added to the ship class's Parts list. A ship class of the game's own " +
                "install is patched from this mod's manifest instead, with an AddMany action.",
            "Cosmoteer: Register The New Part",
            labels
        )
        if (choice < 0) return false
        if (choice == ships.size) {
            args.addProperty("skipRegistration", true)
            return true
        }
        args.addProperty("ship", ships[choice].get("key")?.asString ?: return false)
        return true
    }

    /**
     * One line describing a content kind: what it is, where it goes and what wires it in.
     *
     * @param kind the kind the server reported.
     * @return the label shown in the picker.
     */
    private fun kindLabel(kind: JsonObject): String {
        val name = when (kind.get("kind")?.asString) {
            "part" -> "Part"
            "resource" -> "Resource"
            "bullet" -> "Shot"
            "mediaEffect" -> "Media effect"
            else -> kind.get("kind")?.asString.orEmpty()
        }
        val folder = kind.get("folder")?.asString.orEmpty()
        val wiring = when {
            kind.get("blocked")?.isJsonNull == false -> "not registerable in this mod"
            kind.get("registration")?.asString == "ship" -> "into a ship class"
            kind.get("registration")?.asString == "manifest" -> "with a mod.rules action"
            else -> "nothing registers it"
        }
        return "$name  ->  $folder/  ($wiring)"
    }

    /**
     * One line describing a ship class: what it is called, and what registering into it would touch.
     *
     * @param ship the ship the server reported.
     * @return the label shown in the picker.
     */
    private fun shipLabel(ship: JsonObject): String {
        val name = ship.get("id")?.takeIf { !it.isJsonNull }?.asString
            ?: ship.get("groupName")?.asString.orEmpty()
        val file = (ship.get("fsPath")?.asString ?: "").substringAfterLast('/').substringAfterLast('\\')
        val how = if (ship.get("via")?.asString == "modAction") "mod manifest" else file
        return "$name  ->  $how"
    }

    /**
     * Runs the command on the project's language server, which owns the write so that both clients
     * share one implementation.
     *
     * @param project the project whose server is asked.
     * @param arguments the single argument object the command takes.
     * @return the raw `workspace/executeCommand` result, null when no server is running.
     */
    private fun executeCommand(project: Project, arguments: JsonObject): CompletableFuture<Any?> =
        LanguageServerManager.getInstance(project)
            .getLanguageServer(ShaderPreviewService.SERVER_ID)
            .thenCompose { item ->
                item?.server?.workspaceService
                    ?.executeCommand(ExecuteCommandParams(COMMAND, listOf(arguments)))
                    ?: CompletableFuture.completedFuture<Any?>(null)
            }

    /**
     * Says what was created and what still has to happen, which for a shot or a media effect is the
     * whole answer, since nothing in the game registers those.
     *
     * @param project the project the notification belongs to.
     * @param result the raw apply result (a Gson tree or null).
     */
    private fun report(project: Project, result: Any?) {
        val answer = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (answer == null) {
                notify(
                    project,
                    "The server did not answer the request, so nothing was created. " +
                        "Check that the Cosmoteer language server is running.",
                    NotificationType.WARNING
                )
                return@invokeLater
            }
            val failure = answer.get("failure")?.takeIf { !it.isJsonNull }?.asString
            if (failure != null) {
                notify(project, failureMessage(failure), NotificationType.WARNING)
                return@invokeLater
            }
            FileDocumentManager.getInstance().saveAllDocuments()

            val created = answer.get("created")?.asString.orEmpty()
            val name = created.substringAfterLast('/').substringAfterLast('\\')
            val reference = answer.get("reference")?.asString.orEmpty()
            val registrationFailure = answer.get("registrationFailure")?.takeIf { !it.isJsonNull }?.asString
            val notes = mutableListOf<String>()
            when {
                answer.get("route")?.asString == "none" -> {
                    notes += answer.get("pointedAtBy")?.takeIf { !it.isJsonNull }?.asString
                        ?: "Nothing references this file yet."
                    notes += "The reference to use is $reference."
                }
                registrationFailure != null -> {
                    notes += registrationMessage(registrationFailure, answer)
                    notes += "The reference to use is $reference."
                }
                else -> {
                    val where = answer.get("registeredIn")?.asString.orEmpty()
                        .substringAfterLast('/').substringAfterLast('\\')
                    notes += "Registered in $where."
                }
            }
            val keys = answer.getAsJsonArray("localizationKeys") ?: JsonArray()
            val files = answer.getAsJsonArray("localizationFiles") ?: JsonArray()
            if (keys.size() > 0 && files.size() == 0) {
                notes += "This mod ships no language file, so ${keys.first().asString} was not " +
                    "declared anywhere and the game will show no name."
            }
            val assets = answer.getAsJsonArray("placeholderAssets") ?: JsonArray()
            if (assets.size() > 0) {
                notes += "It points at ${assets.first().asString} for now, which is a file of the " +
                    "game you can replace with your own."
            }
            notify(project, "Created $name. " + notes.joinToString(" "), NotificationType.INFORMATION)
        }
    }

    /**
     * Why nothing was created, in one sentence the author can act on.
     *
     * @param failure the reason the server reported.
     * @return the message to show.
     */
    private fun failureMessage(failure: String): String = when (failure) {
        "noModRoot" -> "This folder is in no mod. Open a mod with a mod.rules manifest first."
        "notEditable" ->
            "This is the game's own data or somebody else's installed mod, which is not yours to add to."
        "unknownKind" -> "That kind of content is not one this version can create."
        "invalidName" ->
            "That name leaves nothing usable behind. Use letters and digits, starting with a letter."
        "pathTaken" -> "A file or folder of that name is already there, so nothing was created."
        "idTaken" ->
            "That id is already declared, and two files with one id means the game keeps only one of them."
        "writeFailed" -> "The file could not be written, so nothing was created."
        else -> "Nothing was created ($failure)."
    }

    /**
     * Why a created file was not wired in, which never stops the file from being created.
     *
     * @param failure the reason the server reported.
     * @param answer the apply result, which carries the manifest names for the ambiguous case.
     * @return the message to show.
     */
    private fun registrationMessage(failure: String, answer: JsonObject): String = when (failure) {
        "noShipChosen" -> "Nothing registers it yet, so no ship will build it until one lists it."
        "alreadyRegistered" -> "It was already registered, so nothing was added twice."
        "ambiguousManifest" -> {
            val manifests = answer.getAsJsonArray("manifests")?.joinToString(", ") { it.asString }.orEmpty()
            "This mod has several manifests and none of them is mod.rules, so which one gets it is " +
                "yours to decide. Candidates: $manifests."
        }
        "manifestUnusable" ->
            "This mod's Actions come from an included file, which cannot be appended to, so the " +
                "action is yours to add."
        "noGameRoot" -> "The Cosmoteer game path is unset, so where the registry lives could not be read."
        "partsInherited" -> "That ship gets its Parts list from a base file, which is not rewritten."
        "noPartsList" -> "That ship declares no Parts list to add to."
        "editRejected" -> "The editor turned the registration down, so the file is not wired in yet."
        else -> "It could not be registered, so nothing loads it yet."
    }

    /**
     * Shows one outcome notification.
     *
     * @param project the project the notification belongs to.
     * @param content the message body.
     * @param type the notification severity.
     */
    private fun notify(project: Project, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("Cosmoteer Language Server")
            .createNotification("Cosmoteer new content", content, type)
            .notify(project)
    }

    companion object {
        /** The server's own command id, the one it declares and answers. */
        const val COMMAND = "cosmoteer.newContent"
    }
}
