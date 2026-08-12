package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffDialogHints
import com.intellij.diff.DiffManager
import com.intellij.diff.chains.SimpleDiffRequestChain
import com.intellij.diff.requests.DiffRequest
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.lsp.commandResultOf
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.ExecuteCommandParams
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture

/**
 * The half of the shared-base extraction that starts once a plan has been picked: ask the server what
 * the plan would do, show it in the diff viewer, and apply it only if the user says so. Shared by the
 * Tools action, which picks a plan from a whole-project sweep, and by the refactoring the server
 * offers in the editor, which arrives with its plan already chosen.
 */
object SharedBaseFlow {
    /**
     * Says which of the two silent failures happened, because they need different answers and the
     * message is the only place either of them shows up.
     *
     * @param step the round trip that failed, named as the user would recognize it.
     * @param result the raw result that could not be read.
     * @returns the message to show.
     */
    fun unreadable(step: String, result: Any?): String =
        if (result == null) {
            "The server did not answer the $step request, so nothing was changed. " +
                "Check that the Cosmoteer language server is running."
        } else {
            "The $step answer could not be read (${result.javaClass.simpleName}), so nothing was changed."
        }

    /**
     * Runs the shared-base command on the project's language server.
     *
     * @param project the project whose server is asked.
     * @param arguments the single argument object the command takes.
     * @returns the raw `workspace/executeCommand` result, null when no server is running.
     */
    fun executeCommand(project: Project, arguments: JsonObject): CompletableFuture<Any?> =
        LanguageServerManager.getInstance(project)
            .getLanguageServer(ShaderPreviewService.SERVER_ID)
            .thenCompose { item ->
                item?.server?.workspaceService
                    ?.executeCommand(ExecuteCommandParams(COMMAND, listOf(arguments)))
                    ?: CompletableFuture.completedFuture<Any?>(null)
            }

    /**
     * Asks the server what a plan would do, and carries on into the diff and the confirmation.
     *
     * @param project the project the dialogs belong to.
     * @param plan the plan to preview, sent back untouched when the user confirms.
     */
    fun start(project: Project, plan: JsonElement) {
        val arguments = JsonObject().apply {
            add("plan", plan)
            addProperty("preview", true)
        }
        executeCommand(project, arguments).thenAccept { preview -> offerPreview(project, plan, preview) }
    }

    /**
     * Opens the rewrite's diff and applies it only once the user has read it and said so. The whole
     * change is several files at once, which no one-line summary conveys.
     *
     * @param project the project the editor and dialogs belong to.
     * @param plan the plan the user picked, sent back untouched when they confirm.
     * @param result the raw preview result (a Gson tree or null).
     */
    fun offerPreview(project: Project, plan: JsonElement, result: Any?) {
        val preview = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            // Three different things go wrong here and they need different answers: no answer at
            // all, an answer that could not be read, and the server saying why it declined.
            if (preview == null) {
                showNotification(project, unreadable("preview", result), NotificationType.WARNING)
                return@invokeLater
            }
            val failure = preview.get("failure")?.takeIf { !it.isJsonNull }?.asString
            if (failure != null) {
                showNotification(project, reasonFor(failure), NotificationType.WARNING)
                return@invokeLater
            }
            val files = preview.get("files")?.asInt ?: 0
            val fields = preview.get("fields")?.asInt ?: 0
            val removed = preview.get("removedBytes")?.asInt ?: 0
            val omitted = preview.get("omitted")?.asInt ?: 0
            val changed = preview.getAsJsonArray("changed") ?: JsonArray()
            // The real diff viewer when the preview carries the rewritten files, which is a file by
            // file side-by-side view with the rules syntax highlighted. The patch file is the fallback
            // for a server old enough not to send them.
            val shown = showSideBySideDiff(project, changed)
            if (!shown) openDiff(project, preview.get("diff")?.asString ?: "")
            val base = (preview.get("baseFsPath")?.asString ?: "").substringAfterLast('/').substringAfterLast('\\')
            val question = if (preview.get("tier")?.asString == "existingBase") {
                "Move $fields fields into $base, the base those $files files already inherit?"
            } else {
                "Create $base and rewrite $files files to inherit it?"
            }
            val scope = if (omitted > 0) {
                "The diff shows ${changed.size()} of the changed files. In total $fields fields leave " +
                    "$files files, removing $removed bytes of duplicated source."
            } else {
                "The diff is the whole change: $fields fields leave $files files, " +
                    "removing $removed bytes of duplicated source."
            }
            val confirmed = Messages.showYesNoDialog(
                project,
                "$question\n\n$scope",
                "Cosmoteer Shared Base",
                "Extract",
                "Cancel",
                null
            )
            if (confirmed != Messages.YES) return@invokeLater
            val arguments = JsonObject().apply { add("plan", plan) }
            executeCommand(project, arguments).thenAccept { applied -> showSummary(project, applied) }
        }
    }

    /**
     * Shows the rewrite in the IDE's own diff viewer, one entry per changed file, each opening the
     * file as it is now against the text the extraction would leave in it.
     *
     * A `.rules` author should be reading their own syntax side by side, not a patch format, and the
     * viewer's file list is how a rewrite covering many files is navigated. The left-hand side is the
     * real file, so it is the editor's own content with its own highlighting; a file that does not
     * exist yet is compared against nothing and reads as all-added.
     *
     * @param project the project the viewer belongs to.
     * @param changed the changed files the preview carried, base file first.
     * @returns true when a diff was shown, false when there was nothing to show.
     */
    fun showSideBySideDiff(project: Project, changed: JsonArray): Boolean {
        val factory = DiffContentFactory.getInstance()
        val requests = mutableListOf<DiffRequest>()
        for (element in changed) {
            val entry = element.asJsonObject
            val fsPath = entry.get("fsPath")?.asString ?: continue
            val after = entry.get("after")?.asString ?: continue
            val created = entry.get("created")?.asBoolean ?: false
            val name = fsPath.substringAfterLast('/').substringAfterLast('\\')
            val file = try {
                LocalFileSystem.getInstance().refreshAndFindFileByNioFile(Path.of(fsPath))
            } catch (_: Exception) {
                null
            }
            val fileType = file?.fileType ?: FileTypeManager.getInstance().getFileTypeByFileName(name)
            val before = if (created || file == null) factory.create("", fileType) else factory.create(project, file)
            requests.add(SimpleDiffRequest(name, before, factory.create(after, fileType), "Now", "After extraction"))
        }
        if (requests.isEmpty()) return false
        // Modal, so it blocks here and the question that follows cannot cover a diff the user is
        // still reading. They close the viewer when they have seen enough, and are then asked.
        DiffManager.getInstance().showDiff(project, SimpleDiffRequestChain(requests), DiffDialogHints.MODAL)
        return true
    }

    /**
     * Writes a rewrite's diff to a temporary file and opens it, the fallback for a preview that
     * carries no file contents.
     *
     * @param project the project to open the file in.
     * @param diff the unified diff to show.
     * @param fileName the temp file's name, so two features previewing at once do not overwrite
     *        each other's diff.
     */
    fun openDiff(project: Project, diff: String, fileName: String = "cosmoteer-shared-base.diff") {
        if (diff.isEmpty()) return
        try {
            val target = Path.of(System.getProperty("java.io.tmpdir"), fileName)
            Files.writeString(target, diff)
            val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(target) ?: return
            FileEditorManager.getInstance(project).openFile(file, false)
        } catch (_: Exception) {
            // A temp file that cannot be written only costs the preview, never the extraction.
        }
    }

    /**
     * Reports what the extraction did, and opens the base file it created.
     *
     * @param project the project the notification belongs to.
     * @param result the raw apply result (a Gson tree or null).
     */
    fun showSummary(project: Project, result: Any?) {
        val summary = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (summary == null) {
                showNotification(project, unreadable("extraction", result), NotificationType.WARNING)
                return@invokeLater
            }
            val failure = summary.get("failure")?.takeIf { !it.isJsonNull }?.asString
            if (failure != null) {
                showNotification(project, reasonFor(failure), NotificationType.WARNING)
                return@invokeLater
            }
            // The rewrite arrives as a workspace edit, which leaves every file it touched in memory
            // and unwritten. For a plan covering hundreds of files that is hundreds of unsaved
            // buffers, so they are written out before anything is reported.
            FileDocumentManager.getInstance().saveAllDocuments()
            val created = summary.get("created")?.asString ?: ""
            val files = summary.get("files")?.asInt ?: 0
            val fields = summary.get("fields")?.asInt ?: 0
            val removed = summary.get("removedBytes")?.asInt ?: 0
            val name = created.substringAfterLast('/').substringAfterLast('\\')
            showNotification(
                project,
                if (summary.get("tier")?.asString == "existingBase") {
                    "Moved $fields fields into $name, out of the $files files that inherit it, " +
                        "$removed bytes of duplicated source removed."
                } else {
                    "Created $name, inherited by $files files, $fields fields moved out of each, " +
                        "$removed bytes of duplicated source removed."
                },
                NotificationType.INFORMATION
            )
            openCreated(project, created)
        }
    }

    /**
     * Turns the server's failure code into the sentence the user is shown.
     *
     * @param failure the code the apply result carried.
     * @returns the explanation.
     */
    fun reasonFor(failure: String): String = when (failure) {
        "planStale" ->
            "Those files changed since the scan, so nothing was rewritten. Run the action again to rescan."
        "baseFileExists" ->
            "A file with the base file's name already exists next to them, so nothing was written."
        "notEditable" ->
            "The base file could not be written. The folder is read-only, or it belongs to the game install."
        "editRejected" ->
            "The rewrite was rejected by the editor, so nothing was changed."
        else -> "The extraction did not happen ($failure)."
    }

    /**
     * Opens the freshly written base file, which exists on disk but not yet in the virtual file
     * system, so it has to be refreshed into it first.
     *
     * @param project the project to open the file in.
     * @param created the on-disk path the server reported, empty when there is none.
     */
    fun openCreated(project: Project, created: String) {
        if (created.isEmpty()) return
        val file = try {
            LocalFileSystem.getInstance().refreshAndFindFileByNioFile(Path.of(created))
        } catch (_: Exception) {
            null
        } ?: return
        FileEditorManager.getInstance(project).openFile(file, true)
    }

    /**
     * Shows one balloon in the plugin's notification group.
     *
     * @param project the project the notification belongs to.
     * @param content the message text.
     * @param type the balloon's severity.
     */
    fun showNotification(project: Project, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("Cosmoteer Language Server")
            .createNotification("Cosmoteer shared base", content, type)
            .notify(project)
    }

    /** The server's own command id, the one it declares and answers. */
    const val COMMAND = "cosmoteer.extractSharedBase"
}
