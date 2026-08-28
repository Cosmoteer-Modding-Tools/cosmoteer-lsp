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
    /** Where a write that followed a reference landed, shown in the page's status line. */
    var note: String? = null,
)

/** Parameters of the `cosmoteer/schemaSearch` request. */
class SchemaSearchParams(
    /** The raw query, whitespace-separated terms that are ANDed. */
    var query: String = "",
    /** Sent only on the first request of a picker session, so no keystroke waits on the index. */
    var textDocument: TextDocumentIdentifier? = null,
    var position: Position? = null,
    var limit: Int? = null,
)

/** Parameters of the `cosmoteer/schemaSearchDetail` request. */
class SchemaSearchDetailParams(var id: String = "")

/** One hit of the `cosmoteer/schemaSearch` answer (mirror of the server's SchemaSearchHit). */
class SchemaSearchHit(
    var id: String = "",
    var kind: String = "",
    var label: String = "",
    var owner: String = "",
    var detail: String = "",
    var prose: String? = null,
    var insertable: Boolean = false,
    var dead: Boolean = false,
    var deprecated: Boolean = false,
    var modContributed: Boolean = false,
)

/** Result of the `cosmoteer/schemaSearch` request (mirror of the server's SchemaSearchResult). */
class SchemaSearchResult(
    var hits: List<SchemaSearchHit> = emptyList(),
    var total: Int = 0,
    var truncated: Boolean = false,
    var contextClass: String? = null,
    var contextClassName: String? = null,
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

    /**
     * Renders what the part at a position still needs before the game can build it as a markdown
     * report: whether a ship pulls the file in, whether the build palette can show it, which techs
     * and modes offer it, and whether its localization keys exist.
     *
     * @param params the document and a position inside the part group.
     * @returns the markdown, or null when no part encloses the position.
     */
    @JsonRequest("cosmoteer/partWiring")
    fun partWiring(params: TextDocumentPositionParams): CompletableFuture<String?>

    /**
     * Renders the member set the game really deserializes for the group at a position: its whole
     * inheritance chain folded into one table, with each row's origin and whatever the fold could
     * not read.
     *
     * @param params the document and a position inside the group.
     * @returns the markdown, or null when no readable group encloses the position.
     */
    @JsonRequest("cosmoteer/effectiveGroup")
    fun effectiveGroup(params: TextDocumentPositionParams): CompletableFuture<String?>

    /**
     * Explains the reference at a position: which of its segments resolved, where the last one that
     * did landed, and what the game would have found there.
     *
     * @param params the document and a position on the reference.
     * @returns the markdown, or null when the position is not on a reference.
     */
    @JsonRequest("cosmoteer/explainReference")
    fun explainReference(params: TextDocumentPositionParams): CompletableFuture<String?>

    /**
     * Ranks every schema type, field, enum member and registry, plus the field documentation,
     * against a query.
     *
     * @param params the query, and on the first request of a session the caret to resolve.
     * @returns the ranked hits, or null when the search could not run.
     */
    @JsonRequest("cosmoteer/schemaSearch")
    fun schemaSearch(params: SchemaSearchParams): CompletableFuture<SchemaSearchResult?>

    /**
     * Renders one search hit's documentation as markdown.
     *
     * @param params the hit's entry id.
     * @returns the markdown page, or null when the schema no longer declares the entry.
     */
    @JsonRequest("cosmoteer/schemaSearchDetail")
    fun schemaSearchDetail(params: SchemaSearchDetailParams): CompletableFuture<String?>
}
