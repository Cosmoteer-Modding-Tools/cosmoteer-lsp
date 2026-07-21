package cosmoteer.actions

import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.testFramework.LightVirtualFile
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.ExecuteCommandParams

/**
 * One-command workspace migration: asks the language server to upgrade every rules file of the
 * project to the current game version (deprecation renames, deletions, and rewrites, applied by the
 * server as one WorkspaceEdit) and shows the returned summary. Mirrors the VS Code
 * `cosmoteer.migrateMod` command, including the optional dead-field cleanup prompt.
 */
class MigrateModAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val choice = Messages.showYesNoCancelDialog(
            project,
            "Migrate every rules file of this project to the current game version?\n\n" +
                "\"Migrate\" applies the known game-update renames and rewrites. " +
                "\"Migrate + Clean\" additionally removes fields the game never reads.",
            "Cosmoteer Migration",
            "Migrate",
            "Migrate + Clean",
            Messages.getCancelButton(),
            null
        )
        if (choice == Messages.CANCEL) return
        val arguments = JsonObject().apply { addProperty("removeDeadFields", choice == Messages.NO) }
        LanguageServerManager.getInstance(project)
            .getLanguageServer(ShaderPreviewService.SERVER_ID)
            .thenCompose { item ->
                item?.server?.workspaceService
                    ?.executeCommand(ExecuteCommandParams(COMMAND, listOf(arguments)))
                    ?: java.util.concurrent.CompletableFuture.completedFuture<Any?>(null)
            }
            .thenAccept { result -> showSummary(project, result) }
    }

    /**
     * Renders the server's migration summary: a notification with the applied-fix counts, plus a
     * markdown report (per-game-version counts and manual-review findings) when there is more to
     * show than one line.
     *
     * @param project the project the notification belongs to.
     * @param result the raw `workspace/executeCommand` result (a Gson tree or null).
     */
    private fun showSummary(project: Project, result: Any?) {
        val summary = result as? JsonObject
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val group = NotificationGroupManager.getInstance().getNotificationGroup("Cosmoteer Language Server")
            if (summary == null) {
                group.createNotification(
                    "Cosmoteer migration",
                    "The migration did not run (no workspace folder, or the server is not ready).",
                    NotificationType.WARNING
                ).notify(project)
                return@invokeLater
            }
            val fixes = summary.get("fixes")?.asInt ?: 0
            val files = summary.get("files")?.asInt ?: 0
            val dead = summary.get("deadFieldsRemoved")?.asInt ?: 0
            val manual = summary.getAsJsonArray("manual") ?: com.google.gson.JsonArray()
            val unparsable = summary.get("unparsable")?.asInt ?: 0
            if (fixes == 0 && dead == 0 && manual.size() == 0) {
                group.createNotification(
                    "Cosmoteer migration",
                    "Everything is already up to date.",
                    NotificationType.INFORMATION
                ).notify(project)
                return@invokeLater
            }
            val pieces = mutableListOf<String>()
            if (fixes > 0) pieces.add("applied $fixes fixes in $files files")
            if (dead > 0) pieces.add("removed $dead dead fields")
            if (manual.size() > 0) pieces.add("${manual.size()} findings need manual review")
            if (unparsable > 0) pieces.add("skipped $unparsable files with parse errors")
            group.createNotification("Cosmoteer migration", pieces.joinToString(", "), NotificationType.INFORMATION)
                .notify(project)
            if (manual.size() > 0 || fixes > 0) {
                val report = LightVirtualFile("Cosmoteer Migration Report.md", buildReport(summary))
                report.isWritable = false
                FileEditorManager.getInstance(project).openFile(report, true)
            }
        }
    }

    /**
     * The markdown details report: fixes grouped by the game version that made each change, the
     * optional cleanup counts, and every manual-review finding as `path:line message`.
     *
     * @param summary the server's migration summary as a Gson object.
     * @return the report text.
     */
    private fun buildReport(summary: JsonObject): String {
        val lines = mutableListOf("# Cosmoteer migration report", "")
        val fixes = summary.get("fixes")?.asInt ?: 0
        val files = summary.get("files")?.asInt ?: 0
        lines.add("Applied $fixes fixes in $files files.")
        lines.add("")
        val byVersion = summary.getAsJsonObject("byVersion") ?: JsonObject()
        for ((version, count) in byVersion.entrySet().sortedBy { it.key }) {
            val label = if (version.isEmpty()) "pre-changelog game versions" else "game version $version"
            lines.add("- $label: ${count.asInt}")
        }
        val dead = summary.get("deadFieldsRemoved")?.asInt ?: 0
        if (dead > 0) {
            lines.add("")
            lines.add("Removed $dead fields the game never reads.")
        }
        val unparsable = summary.get("unparsable")?.asInt ?: 0
        if (unparsable > 0) {
            lines.add("")
            lines.add("Skipped $unparsable files with parse errors (never edited mechanically).")
        }
        val manual = summary.getAsJsonArray("manual")
        if (manual != null && manual.size() > 0) {
            lines.add("")
            lines.add("## Needs manual review")
            lines.add("")
            for (element in manual) {
                val finding = element.asJsonObject
                val uri = finding.get("uri")?.asString ?: continue
                val line = finding.get("line")?.asInt ?: 0
                val message = finding.get("message")?.asString ?: ""
                val path = try {
                    java.nio.file.Paths.get(java.net.URI(uri)).toString()
                } catch (_: Exception) {
                    uri
                }
                lines.add("- $path:$line $message")
            }
        }
        lines.add("")
        return lines.joinToString("\n")
    }

    companion object {
        private const val COMMAND = "cosmoteer.migrateWorkspace"
    }
}
