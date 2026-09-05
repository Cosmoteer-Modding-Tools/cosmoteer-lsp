package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.commands.LSPCommand
import cosmoteer.lsp.commandResultOf
import cosmoteer.lsp.failureCode

/**
 * Handles the command the server's "override this in my mod" refactoring carries, so the offer in the
 * editor runs here rather than on the server.
 *
 * It has to run here because which mod the override belongs in is a choice only the author can make.
 */
class OverrideInModCommandAction : CosmoteerCommandAction("cosmoteer.overrideInMod", "Cosmoteer override in mod") {
    override fun commandPerformed(command: LSPCommand, event: AnActionEvent) {
        val project = event.project ?: return
        val args = argumentsOf(command) ?: return
        // No mod in the arguments is what tells the server to report the candidates rather than to
        // write anything.
        execute(project, args).thenAccept { result -> offerMods(project, args, result) }
    }

    /**
     * Lets the user pick the mod the override is written into, then writes it.
     *
     * @param project the project the dialog and notifications belong to.
     * @param args the arguments the pick is added to, sent back for the second round.
     * @param result the raw scan result (a Gson tree or null).
     */
    private fun offerMods(project: Project, args: JsonObject, result: Any?) {
        val scan = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (scan == null) {
                notify(
                    project,
                    "The server did not answer the request, so nothing was changed. " +
                        "Check that the Cosmoteer language server is running.",
                    NotificationType.WARNING
                )
                return@invokeLater
            }
            val failure = scan.failureCode()
            if (failure != null) {
                notify(project, failureMessage(failure), NotificationType.WARNING)
                return@invokeLater
            }
            val candidates = scan.getAsJsonArray("candidates") ?: JsonArray()
            val open = candidates.map { it.asJsonObject }.filter { it.get("blocked")?.isJsonNull != false }
            if (open.isEmpty()) {
                notify(
                    project,
                    "No mod in this project can take the override. Either there is none, or every one " +
                        "of them ships several manifests and which gets the override is yours to decide.",
                    NotificationType.INFORMATION
                )
                return@invokeLater
            }
            val member = scan.get("memberName")?.asString.orEmpty()
            val replaces = scan.get("replacesContainer")?.asBoolean == true
            val labels = open.map { labelOf(it) }.toTypedArray()
            val choice = chooseOne(
                project,
                "The override is written into the mod's manifest as an Overrides action, so the game's " +
                    "own files stay untouched." +
                    if (replaces) " It replaces the whole of $member, so everything the game reads under it comes from your copy." else "",
                "Cosmoteer: Override In A Mod",
                labels
            )
            if (choice < 0) return@invokeLater
            args.addProperty("mod", open[choice].get("key")?.asString ?: return@invokeLater)
            if (replaces) {
                val shapes = arrayOf("Write it into mod.rules", "Keep it in its own file")
                val shape = chooseOne(
                    project,
                    "Where should the overridden value be written?",
                    "Cosmoteer: Override In A Mod",
                    shapes
                )
                if (shape < 0) return@invokeLater
                args.addProperty("shape", if (shape == 1) "file" else "inline")
            } else {
                args.addProperty("shape", "inline")
            }
            execute(project, args).thenAccept { applied -> report(project, applied) }
        }
    }

    /**
     * One line describing a mod: what it is called, and whether it already overrides this value.
     *
     * @param candidate the candidate the server reported.
     * @returns the label shown in the picker.
     */
    private fun labelOf(candidate: JsonObject): String {
        val name = candidate.get("name")?.asString.orEmpty()
        val manifest = candidate.getAsJsonArray("manifests")?.firstOrNull()?.asString ?: "mod.rules"
        val already = if (candidate.get("alreadyOverridden")?.asBoolean == true) " (already overridden)" else ""
        return "$name  ->  $manifest$already"
    }

    /**
     * Says what the override did, or why it did nothing. The edit arrives as a workspace edit, so the
     * files it touched are written out before anything is reported.
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
                    "The server did not answer the override request, so nothing was changed. " +
                        "Check that the Cosmoteer language server is running.",
                    NotificationType.WARNING
                )
                return@invokeLater
            }
            val failure = answer.failureCode()
            if (failure != null) {
                val manifests = answer.getAsJsonArray("manifests")?.joinToString(", ") { it.asString }.orEmpty()
                val detail = if (manifests.isNotEmpty()) " Candidates: $manifests." else ""
                notify(project, failureMessage(failure) + detail, NotificationType.WARNING)
                return@invokeLater
            }
            FileDocumentManager.getInstance().saveAllDocuments()
            val manifest = answer.get("manifestFsPath")?.asString.orEmpty()
                .substringAfterLast('/').substringAfterLast('\\')
            val member = answer.get("memberName")?.asString.orEmpty()
            val created = answer.get("createdFsPath")?.takeIf { !it.isJsonNull }?.asString.orEmpty()
            val where = if (created.isNotEmpty()) {
                ", with the value in " + created.substringAfterLast('/').substringAfterLast('\\')
            } else {
                ""
            }
            val note = if (answer.get("replacesContainer")?.asBoolean == true) {
                " This replaces the whole of $member, so everything the game reads under it now comes from your copy."
            } else {
                ""
            }
            notify(project, "Added the override of $member to $manifest$where.$note", NotificationType.INFORMATION)
        }
    }

    /**
     * Why an override did nothing, in one sentence the user can act on.
     *
     * @param failure the reason the server reported.
     * @returns the message to show.
     */
    private fun failureMessage(failure: String): String = when (failure) {
        "stale" -> "The value has moved since the offer was made, so nothing was changed."
        "insideList" ->
            "This value is inside a list, and the game addresses those by position, which another " +
                "mod loading first renumbers. Override the whole list instead."
        "indexSegment", "untypablePath" ->
            "The path to this value runs through a name the game reads as a position rather than as " +
                "a name, so an override written for it could point somewhere else."
        "unnamedMember" -> "This value sits in a block with no name, so there is no path to write for it."
        "shadowedName" ->
            "Another member of that group already answers to this name, so an override would change that one instead."
        "emptyMember" -> "This field has no value to copy, so nothing was changed."
        "inheritedMember" ->
            "This group has bases of its own, and an override replaces the whole of it, so copying " +
                "only its body would drop what the bases supply."
        "multiLineText" -> "This value carries text running across a line break, which cannot be copied safely."
        "scopeRelativeValue" ->
            "This value reads something around it, with \"~\", \"^\", \":\" or a bare name, so it " +
                "would mean something else from your mod."
        "unrebasablePath" ->
            "A path in this value could not be rewritten to read from the game folder, so an override " +
                "would point at nothing."
        "notVanilla" -> "This file is not one of the game install, so edit it directly rather than overriding it."
        "stringsFile" ->
            "Language files cannot be changed by an action. Ship your own file for that language instead."
        "noGamePath" -> "Set the Cosmoteer game path so the override can name the file it changes."
        "noModRoot" -> "This project holds no mod, so there is no manifest to write the override into."
        "unknownMod" -> "That mod is no longer in the project, so nothing was changed."
        "ambiguousManifest" ->
            "This mod has several manifests and none of them is mod.rules, so which one gets the " +
                "override is yours to decide."
        "notEditable" -> "The manifest could not take another action, so nothing was changed."
        "alreadyOverridden" -> "This mod already overrides that value, so nothing was changed."
        "editRejected" -> "The editor turned down the edit, so nothing was changed."
        "writeFailed" -> "The file holding the override could not be written, so nothing was changed."
        else -> "The override could not be written ($failure)."
    }
}
