package cosmoteer.lsp

import com.google.gson.JsonParser
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.platform.backend.documentation.DocumentationLinkHandler
import com.intellij.platform.backend.documentation.DocumentationTarget
import com.intellij.platform.backend.documentation.LinkResolveResult
import com.redhat.devtools.lsp4ij.LanguageServerManager
import org.eclipse.lsp4j.ExecuteCommandParams
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * Executes the `command:cosmoteer.openInDecompiler?<args>` link a schema hover carries when the
 * "Open in decompiler" setting is on. VS Code executes such command links natively, but LSP4IJ's
 * own documentation link handler only covers `file://` navigation, so this handler fills the gap
 * by forwarding the command to the language server as a plain `workspace/executeCommand`. The
 * server finds and spawns the user's ILSpy/dotPeek locally, shared with the VS Code path.
 */
class DecompilerLinkHandler : DocumentationLinkHandler {

    override fun resolveLink(target: DocumentationTarget, url: String): LinkResolveResult? {
        if (!url.startsWith(LINK_PREFIX)) return null
        val encodedArgs = url.substringAfter('?', missingDelimiterValue = "")
        ApplicationManager.getApplication().executeOnPooledThread { execute(encodedArgs) }
        // The click is fully handled by the side effect. Re-resolving the same target keeps the
        // documentation popup on the hover it already shows.
        return LinkResolveResult.resolvedTarget(target)
    }

    /**
     * Sends the decoded command to the Cosmoteer server of whichever open project runs one. The
     * documentation target does not expose its project, so every open project is tried. Only
     * projects with `.rules` files have a running server, so the realistic case is exactly one.
     *
     * @param encodedArgs the URI-encoded JSON argument array from the command link.
     */
    private fun execute(encodedArgs: String) {
        val arguments = try {
            JsonParser.parseString(URLDecoder.decode(encodedArgs, StandardCharsets.UTF_8)).asJsonArray.toList()
        } catch (_: Exception) {
            return
        }
        for (project in ProjectManager.getInstance().openProjects) {
            LanguageServerManager.getInstance(project)
                .getLanguageServer(COMMAND_SERVER_ID)
                .thenAccept { item ->
                    item?.server?.workspaceService
                        ?.executeCommand(ExecuteCommandParams(COMMAND, arguments))
                }
        }
    }

    companion object {
        private const val COMMAND = "cosmoteer.openInDecompiler"
        private const val LINK_PREFIX = "command:$COMMAND"
        private const val COMMAND_SERVER_ID = "cosmoteerLanguageServer"
    }
}
