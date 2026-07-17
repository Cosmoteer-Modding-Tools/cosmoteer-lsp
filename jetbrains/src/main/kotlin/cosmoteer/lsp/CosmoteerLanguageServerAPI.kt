package cosmoteer.lsp

import com.google.gson.JsonObject
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.TextDocumentPositionParams
import org.eclipse.lsp4j.WorkspaceEdit
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

/** Parameters of the `cosmoteer/modOverview` request. */
class ModOverviewParams(var textDocument: TextDocumentIdentifier? = null)

/** Parameters of the `cosmoteer/partGridEdit` request (mirror of the server's PartGridEditParams). */
class PartGridEditParams(
    var textDocument: TextDocumentIdentifier? = null,
    /** The part group anchor of the payload the mutation was made against. */
    var anchor: Position? = null,
    /** The payload's dataVersion, refused as `stale` when the document moved on. */
    var dataVersion: Int = 0,
    /** The webview mutation, forwarded verbatim. */
    var mutation: JsonObject? = null,
)

/** Result of the `cosmoteer/partGridEdit` request (mirror of the server's PartGridEditResult). */
class PartGridEditResult(
    var status: String? = null,
    var message: String? = null,
    var edit: WorkspaceEdit? = null,
)

/**
 * The Cosmoteer server's protocol surface: standard LSP plus the custom requests the VS Code
 * client also uses (live shader preview payload, the mod-overview markdown report, and the part
 * grid editor's payload/write-back pair).
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

    /**
     * Builds the interactive part grid editor payload for the part at a position (effective size,
     * sprites, per-cell field layers, rotation fields).
     *
     * @param params the document and a position inside the part group.
     * @returns the payload, or null when no part encloses the position.
     */
    @JsonRequest("cosmoteer/partGridData")
    fun partGridData(params: TextDocumentPositionParams): CompletableFuture<JsonObject?>

    /**
     * Turns one grid editor mutation into a minimal WorkspaceEdit the client applies.
     *
     * @param params the mutation with the payload's anchor and dataVersion.
     * @returns the edit result (`ok` with an edit, or a refusal status such as `stale`).
     */
    @JsonRequest("cosmoteer/partGridEdit")
    fun partGridEdit(params: PartGridEditParams): CompletableFuture<PartGridEditResult?>
}
