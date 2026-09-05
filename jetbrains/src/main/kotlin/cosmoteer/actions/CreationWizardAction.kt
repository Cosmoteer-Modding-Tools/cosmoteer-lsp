package cosmoteer.actions

import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import cosmoteer.lsp.commandResultOf
import cosmoteer.lsp.executeServerCommand
import cosmoteer.lsp.failureCode
import cosmoteer.lsp.notifyCosmoteer

/**
 * The shape every creation wizard shares: it finds the mod from whatever the action was invoked on,
 * asks the server what is already there, puts a form in front of the author, and has the server write
 * the result. Both rounds speak the same command, told apart by the arguments the second one carries.
 *
 * @param commandId the server's own command id, the one it declares and answers.
 * @param notificationTitle the title the balloons of this wizard carry.
 * @param silentOutcome how the balloons name a round that changed nothing.
 */
abstract class CreationWizardAction(
    private val commandId: String,
    private val notificationTitle: String,
    private val silentOutcome: String = "nothing was created",
) : AnAction() {
    final override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    final override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    final override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val anchor = event.modAnchorUri() ?: return
        round(project, JsonObject().apply { addProperty("uri", anchor) }) { scan -> onScan(project, anchor, scan) }
    }

    /**
     * Puts the form in front of the author and, when they accept it, calls [write] with what they
     * filled in. Runs on the UI thread with the scan already read.
     *
     * @param project the project the dialogs belong to.
     * @param anchor the uri the mod was found from.
     * @param scan what the first round answered.
     */
    protected abstract fun onScan(project: Project, anchor: String, scan: JsonObject)

    /**
     * Runs the writing round and reports what came back.
     *
     * @param project the project the notifications belong to.
     * @param anchor the uri the mod was found from.
     * @param args the form's arguments, which the anchor is added to.
     * @param onWritten what to say about the answer, on the UI thread with every file written out.
     */
    protected fun write(project: Project, anchor: String, args: JsonObject, onWritten: (JsonObject) -> Unit) {
        round(project, args.apply { addProperty("uri", anchor) }) { answer ->
            FileDocumentManager.getInstance().saveAllDocuments()
            onWritten(answer)
        }
    }

    /**
     * Why nothing happened, in one sentence the user can act on. The shared reasons unless a wizard
     * has one of its own.
     *
     * @param failure the reason the server reported.
     * @returns the message to show.
     */
    protected open fun failureMessage(failure: String): String = creationFailureMessage(failure)

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

    /**
     * One round of the command: run it, and hand the answer on unless the server said nothing or
     * said why it refused.
     *
     * @param project the project the notifications belong to.
     * @param arguments the arguments the round takes.
     * @param onAnswer what to do with an answer that carries no failure, on the UI thread.
     */
    private fun round(project: Project, arguments: JsonObject, onAnswer: (JsonObject) -> Unit) {
        executeServerCommand(project, commandId, arguments).thenAccept { result ->
            val answer = commandResultOf(result)
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                if (answer == null) {
                    notify(project, "The server did not answer the request, so $silentOutcome.", NotificationType.WARNING)
                    return@invokeLater
                }
                val failure = answer.failureCode()
                if (failure != null) {
                    notify(project, failureMessage(failure), NotificationType.WARNING)
                    return@invokeLater
                }
                onAnswer(answer)
            }
        }
    }
}

/**
 * Why nothing was created, for the wizards that share the faction command's failures.
 *
 * @param failure the reason the server reported.
 * @returns the message to show.
 */
fun creationFailureMessage(failure: String): String = when (failure) {
    "noModRoot" -> "This folder is in no mod. Open a mod with a mod.rules manifest first."
    "notEditable" -> "This is the game's own data or somebody else's installed mod, which is not yours to add to."
    "noGameRoot" -> "The game path is unset, so the game's own files this builds on could not be read."
    "invalidId" -> "An id is one word of letters, digits and underscores."
    "idTaken" -> "Something of that id already exists."
    "pathTaken" -> "A folder for that id is already there, so nothing was created."
    "writeFailed" -> "The files could not be written, so nothing was created."
    else -> "Nothing was created ($failure)."
}

/**
 * Sentences about the wirings that did not happen, shared by the creation wizards.
 *
 * @param answer the apply result.
 * @return the sentences, empty when everything was wired.
 */
fun wiringNotes(answer: JsonObject): List<String> {
    val wiring = answer.getAsJsonObject("wiring") ?: return emptyList()
    val unwired = wiring.entrySet().filter {
        it.value.asString != "written" && it.value.asString != "present" && it.value.asString != "skipped"
    }
    if (unwired.isEmpty()) return emptyList()
    return listOf(
        when (unwired.first().value.asString) {
            "ambiguousManifest" -> {
                val manifests = answer.getAsJsonArray("manifests")?.joinToString(", ") { it.asString }.orEmpty()
                "The mod has several manifests and none is mod.rules, so the actions wiring it in are yours " +
                    "to write. Candidates: $manifests."
            }
            "manifestUnusable" ->
                "The mod's Actions come from an included file, which cannot be appended to, so the actions " +
                    "wiring it in are yours to write."
            else -> "Some of it could not be wired in: ${unwired.joinToString(", ") { it.key }}."
        }
    )
}

/**
 * Opens a file the server has just written, which is on disk but not yet in the virtual file system.
 *
 * @param project the project to open the file in.
 * @param path the on-disk path, null when the answer named none.
 */
fun openCreatedFile(project: Project, path: String?) {
    val file = path?.let { LocalFileSystem.getInstance().refreshAndFindFileByPath(it) }
    if (file != null) FileEditorManager.getInstance(project).openFile(file, true)
}
