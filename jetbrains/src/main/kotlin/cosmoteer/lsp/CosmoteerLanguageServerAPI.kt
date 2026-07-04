package cosmoteer.lsp

import com.google.gson.JsonObject
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.TextDocumentPositionParams
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

/** Parameters of the `cosmoteer/modOverview` request. */
class ModOverviewParams(var textDocument: TextDocumentIdentifier? = null)

/**
 * The Cosmoteer server's protocol surface: standard LSP plus the two custom requests the
 * VS Code client also uses (live shader preview payload and the mod-overview markdown report).
 */
interface CosmoteerLanguageServerAPI : LanguageServer {
    /**
     * Resolves the material at a position to a renderable preview payload (translated GLSL,
     * constants, textures, blend state and so on).
     *
     * @param params the document and position of the material's `Shader` assignment.
     * @returns the preview payload, or null when there is no material at the position.
     */
    @JsonRequest("cosmoteer/shaderPreview")
    fun shaderPreview(params: TextDocumentPositionParams): CompletableFuture<JsonObject?>

    /**
     * Renders a mod manifest's actions and unreachable files as a markdown report.
     *
     * @param params the manifest document.
     * @returns the markdown, or null when the file is not inside a mod.
     */
    @JsonRequest("cosmoteer/modOverview")
    fun modOverview(params: ModOverviewParams): CompletableFuture<String?>
}
