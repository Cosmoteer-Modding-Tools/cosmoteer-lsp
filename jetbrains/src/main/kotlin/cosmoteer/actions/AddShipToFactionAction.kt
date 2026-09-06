package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFile
import cosmoteer.lsp.commandResultOf
import cosmoteer.lsp.executeServerCommand
import cosmoteer.lsp.failureCode
import cosmoteer.lsp.notifyCosmoteer
import java.nio.file.Paths
import java.util.concurrent.CompletableFuture

/**
 * Puts saved ships into a faction's spawn pool, in the two rounds the server's command speaks: the
 * first reads the blueprints and says what each one is, the second copies them into the mod and
 * writes every registration. Mirrors the VS Code `cosmoteer.addShipToFaction` command.
 *
 * The server rates each ship the way the game does, so the ordinary case is one pick of a faction
 * and one confirmation. A ship can still be adjusted before anything is written.
 */
class AddShipToFactionAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val selected = event.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.toList().orEmpty()
        val blueprints = selected.filter { it.isDirectory || it.name.endsWith(".ship.png", ignoreCase = true) }
        val files = if (blueprints.isNotEmpty()) blueprints else chooseBlueprints(project)
        if (files.isEmpty()) return
        // The mod is found from the project folder, since a saved ship is rarely inside the mod yet.
        val anchor = runCatching { Paths.get(project.basePath!!).toUri().toString() }.getOrNull() ?: return
        val paths = JsonArray().apply { files.forEach { add(it.path) } }
        val args = JsonObject().apply {
            addProperty("uri", anchor)
            add("blueprints", paths)
        }
        executeCommand(project, args).thenAccept { result -> ask(project, anchor, paths, result) }
    }

    /**
     * Asks for the ships to register, for the reader who invoked the action with nothing selected.
     *
     * @param project the project the dialog belongs to.
     * @return the chosen files and folders, empty when the dialog was dismissed.
     */
    private fun chooseBlueprints(project: Project): List<VirtualFile> {
        // Args: chooseFiles, chooseFolders, chooseJars, chooseJarsAsFiles, chooseJarContents, chooseMultiple.
        val descriptor = FileChooserDescriptor(true, true, false, false, false, true)
            .withTitle("Select Saved Ships or a Folder of Them")
        return FileChooser.chooseFiles(descriptor, project, null).toList()
    }

    /**
     * Asks which faction and whether the suggestions stand, then runs the registration.
     *
     * @param project the project the dialogs belong to.
     * @param anchor the uri the mod was found from.
     * @param blueprints the paths the scan read.
     * @param result the raw scan result (a Gson tree or null).
     */
    private fun ask(project: Project, anchor: String, blueprints: JsonArray, result: Any?) {
        val scan = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (scan == null) {
                notify(project, "The server did not answer the request, so nothing was registered.", NotificationType.WARNING)
                return@invokeLater
            }
            val failure = scan.failureCode()
            if (failure != null) {
                notify(project, failureMessage(failure), NotificationType.WARNING)
                return@invokeLater
            }
            // Nothing to register is said before a faction is asked for, with the reason, so a folder
            // of the game's own ships does not cost the author the whole wizard to find out.
            val all = (scan.getAsJsonArray("ships") ?: JsonArray()).map { it.asJsonObject }
            val ships = all.filter { it.get("blocked")?.isJsonNull != false }
            if (ships.isEmpty()) {
                val taken = all.count { it.get("blocked")?.takeIf { b -> !b.isJsonNull }?.asString == "idTaken" }
                notify(
                    project,
                    if (taken > 0) {
                        "None of those ships can be registered. $taken of them carry the name of a built-in ship, " +
                            "which the game refuses as a duplicate. Rename the files to register them."
                    } else {
                        "None of those files is a saved ship."
                    },
                    NotificationType.WARNING
                )
                return@invokeLater
            }
            chooseFaction(project, anchor, scan) { faction ->
                val choices = reviewShips(project, ships) ?: return@chooseFaction
                val args = JsonObject().apply {
                    addProperty("uri", anchor)
                    add("blueprints", blueprints)
                    addProperty("faction", faction)
                    add("ships", choices)
                }
                executeCommand(project, args).thenAccept { applied -> report(project, applied) }
            }
        }
    }

    /**
     * Lets the author pick the faction, the mod's own first, or create one. Creating one is its own
     * exchange with the server, so the rest of the flow is handed over as a continuation rather
     * than waited for on the UI thread.
     *
     * @param project the project the dialog belongs to.
     * @param anchor the uri the mod was found from.
     * @param scan the scan result holding the factions.
     * @param then what to do with the chosen faction id, not called when the author backed out.
     */
    private fun chooseFaction(project: Project, anchor: String, scan: JsonObject, then: (String) -> Unit) {
        val factions = (scan.getAsJsonArray("factions") ?: JsonArray()).map { it.asJsonObject }
        val create = "Create a new faction..."
        val labels = (factions.map { factionLabel(it) } + create).toTypedArray()
        val choice = chooseOne(
            project,
            "The ships are copied into the mod under builtin_ships/<faction>/<role> and registered " +
                "there, the way the game's own ships are, and the manifest adds the faction's file to the " +
                "game's built-in ships with one action.",
            "Cosmoteer: Add Ships to a Faction",
            labels
        )
        if (choice < 0) return
        if (choice == factions.size) {
            NewFactionAction.createFaction(project, anchor, then)
            return
        }
        factions[choice].get("id")?.asString?.let(then)
    }

    /**
     * Offers each ship with its suggestion, and asks whether to adjust any before writing.
     *
     * @param project the project the dialogs belong to.
     * @param ships the readable ships the scan reported.
     * @return the choices, or null when the author backed out.
     */
    private fun reviewShips(project: Project, ships: List<JsonObject>): JsonArray? {
        val summary = ships.joinToString("\n") { shipSummary(it) }
        val answer = Messages.showYesNoCancelDialog(
            project,
            "Each ship is rated the way the game rates it. Tier is the danger level of the star " +
                "systems it spawns in, 1 to 18, read from the price of its parts, doors and crew. " +
                "Difficulty rates how hard it is for that tier, 1 easy, 2 average, 3 hard, read from " +
                "what it spends on weapons and armor against the game's own ships of that tier. The " +
                "role comes from what it carries.\n\n$summary",
            "Cosmoteer: Register as Suggested?",
            "Register",
            "Adjust Each Ship",
            "Cancel",
            null
        )
        if (answer == Messages.CANCEL) return null
        val adjust = answer == Messages.NO
        val choices = JsonArray()
        for (ship in ships) {
            val choice = if (adjust) adjustShip(project, ship) ?: return null else suggestionFor(ship)
            choices.add(choice)
        }
        return choices
    }

    /**
     * Asks the role, the tier and the difficulty of one ship, each starting from the suggestion.
     *
     * @param project the project the dialogs belong to.
     * @param ship the scanned ship.
     * @return the choice, or null when the author backed out.
     */
    private fun adjustShip(project: Project, ship: JsonObject): JsonObject? {
        val name = ship.get("name")?.asString.orEmpty()
        val roles = (ship.getAsJsonArray("roles") ?: JsonArray()).map { it.asString }
        val tiers = ship.getAsJsonObject("tierByRole")
        val roleChoice = chooseOne(
            project,
            "What kind of ship is $name? The first entry is the suggestion.",
            "Cosmoteer: $name",
            roles.map { "${roleLabel(it)}  (tier ${tiers?.get(it)?.asInt ?: 1})" }.toTypedArray()
        )
        if (roleChoice < 0) return null
        val role = roles[roleChoice]
        val valueTier = ship.get("valueTier")?.asInt ?: 1
        val tierText = Messages.showInputDialog(
            project,
            "The danger level of the star systems $name spawns in, 1 to 18. The game values it at " +
                "${credits(ship)} credits, which its tier table puts at tier $valueTier.",
            "Cosmoteer: $name",
            null,
            (tiers?.get(role)?.asInt ?: valueTier).toString(),
            null
        ) ?: return null
        val tier = tierText.trim().toIntOrNull()?.takeIf { it >= 1 } ?: return null
        val suggested = ship.get("difficulty")?.asInt ?: 2
        val bands = arrayOf(
            "1, easy: fewer weapons and less armor than the game's ships of its tier",
            "2, average: armed and armored like the game's ships of its tier",
            "3, hard: more weapons and armor than the game's ships of its tier"
        )
        val ordered = (listOf(suggested) + listOf(1, 2, 3).filter { it != suggested })
        val difficultyChoice = chooseOne(
            project,
            "${difficultyReason(ship)} The game itself never reads the difficulty, only mods that " +
                "filter their spawns by it do. The first entry is the suggestion.",
            "Cosmoteer: $name",
            ordered.map { bands[it - 1] }.toTypedArray()
        )
        if (difficultyChoice < 0) return null
        return JsonObject().apply {
            addProperty("fsPath", ship.get("fsPath")?.asString)
            addProperty("role", role)
            addProperty("tier", tier)
            addProperty("difficulty", ordered[difficultyChoice])
        }
    }

    /** The server's suggestion for a ship, as a choice. */
    private fun suggestionFor(ship: JsonObject): JsonObject {
        val role = ship.getAsJsonArray("roles")?.firstOrNull()?.asString ?: "combat"
        return JsonObject().apply {
            addProperty("fsPath", ship.get("fsPath")?.asString)
            addProperty("role", role)
            addProperty("tier", ship.getAsJsonObject("tierByRole")?.get(role)?.asInt ?: 1)
            addProperty("difficulty", ship.get("difficulty")?.asInt ?: 2)
        }
    }

    /** One line per ship in the review: its name, its suggestion and the figures behind it. */
    private fun shipSummary(ship: JsonObject): String {
        val role = ship.getAsJsonArray("roles")?.firstOrNull()?.asString ?: "combat"
        val tier = ship.getAsJsonObject("tierByRole")?.get(role)?.asInt ?: 1
        val valueTier = ship.get("valueTier")?.asInt ?: tier
        val difficulty = ship.get("difficulty")?.asInt ?: 2
        val lowered =
            if (tier != valueTier) " (rated tier $valueTier by value, written lower the way the game writes stations)" else ""
        return "${ship.get("name")?.asString}: ${roleLabel(role)}, tier $tier$lowered, difficulty $difficulty " +
            "(${difficultyWord(difficulty)}). ${credits(ship)} credits. ${difficultyReason(ship)}"
    }

    /** The one word a difficulty band means. */
    private fun difficultyWord(difficulty: Int): String = when (difficulty) {
        1 -> "easy"
        3 -> "hard"
        else -> "average"
    }

    /** A ship's value with thousands separators. */
    private fun credits(ship: JsonObject): String =
        "%,d".format(ship.getAsJsonObject("value")?.get("total")?.asDouble?.toLong() ?: 0L)

    /**
     * Says what the difficulty was read from: the ship's weapon and armor shares next to what the
     * game's own ships of its tier spend.
     *
     * @param ship the scanned ship.
     * @return the sentence.
     */
    private fun difficultyReason(ship: JsonObject): String {
        val strength = ship.getAsJsonObject("strength")
        fun percent(field: String): String = "${Math.round((strength?.get(field)?.asDouble ?: 0.0) * 100)}%"
        val valueTier = ship.get("valueTier")?.asInt ?: 1
        val difficulty = ship.get("difficulty")?.asInt ?: 2
        return "Weapons take ${percent("weaponShare")} of its value and armor ${percent("armorShare")}, where the " +
            "game's tier $valueTier ships spend ${percent("typicalWeaponShare")} and ${percent("typicalArmorShare")}, " +
            "so it rates ${difficultyWord(difficulty)}."
    }

    /** One line describing a faction: its name and whose it is. */
    private fun factionLabel(faction: JsonObject): String {
        val id = faction.get("id")?.asString.orEmpty()
        val name = faction.get("name")?.takeIf { !it.isJsonNull }?.asString
        val whose = when {
            faction.get("own")?.asBoolean == true -> "this mod"
            faction.get("source")?.asString == "game" -> "the game"
            else -> "another mod in the workspace"
        }
        return (if (name != null) "$name ($id)" else id) + "  ->  $whose"
    }

    /**
     * Runs the command on the project's language server.
     *
     * @param project the project whose server is asked.
     * @param arguments the single argument object the command takes.
     * @return the raw `workspace/executeCommand` result, null when no server is running.
     */
    private fun executeCommand(project: Project, arguments: JsonObject): CompletableFuture<Any?> =
        executeServerCommand(project, COMMAND, arguments)

    /**
     * Says what was registered and what was not.
     *
     * @param project the project the notification belongs to.
     * @param result the raw apply result (a Gson tree or null).
     */
    private fun report(project: Project, result: Any?) {
        val answer = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (answer == null) {
                notify(project, "The server did not answer the request, so nothing was registered.", NotificationType.WARNING)
                return@invokeLater
            }
            val failure = answer.failureCode()
            if (failure != null) {
                notify(project, failureMessage(failure), NotificationType.WARNING)
                return@invokeLater
            }
            FileDocumentManager.getInstance().saveAllDocuments()
            val ships = (answer.getAsJsonArray("ships") ?: JsonArray()).map { it.asJsonObject }
            val done = ships.filter { it.get("failure")?.isJsonNull != false }
            val failed = ships.filter { it.get("failure")?.isJsonNull == false }
            val notes = mutableListOf<String>()
            if (done.isNotEmpty()) {
                notes += "${done.size} registered in ${answer.get("faction")?.asString}: " +
                    done.joinToString(", ") { "${it.get("name")?.asString} (${roleLabel(it.get("role")?.asString.orEmpty())}, tier ${it.get("tier")?.asInt})" } + "."
            }
            for (ship in failed) notes += "${ship.get("name")?.asString}: ${shipFailure(ship.get("failure")?.asString.orEmpty())}."
            val manifestFailure = answer.get("manifestFailure")?.takeIf { !it.isJsonNull }?.asString
            if (manifestFailure != null) notes += manifestFailure(manifestFailure, answer)
            else if (done.isNotEmpty()) {
                val manifest = answer.get("manifest")?.asString.orEmpty().substringAfterLast('/').substringAfterLast('\\')
                if (manifest.isNotEmpty()) notes += "The faction is wired in from $manifest."
            }
            val icons = done.count { it.get("stasisIcon")?.takeIf { icon -> !icon.isJsonNull } != null }
            if (icons > 0) notes += "$icons station icons were drawn beside the ships, for you to replace if you like."
            val starterKeys = done.mapNotNull { it.get("starterDescriptionKey")?.takeIf { key -> !key.isJsonNull }?.asString }
            if (starterKeys.isNotEmpty()) {
                notes += "The career mode offers the starter ships with these descriptions to write in the language files: " +
                    starterKeys.joinToString(", ") + "."
            }
            notify(project, notes.joinToString(" "), if (done.isEmpty()) NotificationType.WARNING else NotificationType.INFORMATION)
        }
    }

    /** Why nothing could be registered, in one sentence the author can act on. */
    private fun failureMessage(failure: String): String = when (failure) {
        "noModRoot" -> "This folder is in no mod. Open a mod with a mod.rules manifest first."
        "notEditable" -> "This is the game's own data or somebody else's installed mod, which is not yours to add to."
        "noGameRoot" -> "The game path is unset, so the ships could not be judged."
        "noBlueprints" -> "None of those files is a saved ship."
        "unknownFaction" -> "No faction was chosen, so nothing was registered."
        else -> "Nothing was registered ($failure)."
    }

    /** Why one ship stayed out. */
    private fun shipFailure(failure: String): String = when (failure) {
        "alreadyRegistered" -> "already registered"
        "idTaken" -> "a built-in ship of that name exists, so the game would refuse the duplicate"
        "unreadable" -> "not a saved ship"
        "copyFailed" -> "could not be copied into the mod"
        "editRejected" -> "the editor turned the edit down"
        else -> failure
    }

    /** Why the manifest was not written, which leaves the ship files in place but unwired. */
    private fun manifestFailure(failure: String, answer: JsonObject): String = when (failure) {
        "ambiguousManifest" -> {
            val manifests = answer.getAsJsonArray("manifests")?.joinToString(", ") { it.asString }.orEmpty()
            "The mod has several manifests and none is mod.rules, so the action adding the faction to " +
                "the built-in ships is yours to write. Candidates: $manifests."
        }
        "manifestUnusable" ->
            "The mod's Actions come from an included file, which cannot be appended to, so the action " +
                "adding the faction to the built-in ships is yours to write."
        "noGameRoot" -> "The game path is unset, so the manifest action could not be written."
        else -> "The manifest could not be written, so nothing loads the ships yet."
    }

    private fun notify(project: Project, content: String, type: NotificationType) {
        notifyCosmoteer(project, "Cosmoteer ships", content, type)
    }

    companion object {
        const val COMMAND = "cosmoteer.registerShip"

        /** The roles, as the dialogs name them. */
        fun roleLabel(role: String): String = when (role) {
            "combat" -> "Combat ship"
            "trade" -> "Trade ship"
            "crew_transport" -> "Crew transport"
            "defense" -> "Defense platform"
            "trade_station" -> "Trade station"
            "military_station" -> "Military station"
            "wreckage" -> "Wreckage"
            "starter" -> "Starter ship"
            "storage_pod" -> "Storage pod"
            else -> role
        }
    }
}
