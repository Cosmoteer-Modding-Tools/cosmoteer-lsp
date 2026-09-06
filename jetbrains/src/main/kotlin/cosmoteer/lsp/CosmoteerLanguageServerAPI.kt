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

/** Parameters of a request that names one document inside a mod. */
class ModFileParams(var textDocument: TextDocumentIdentifier? = null)

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

/** Which parts the part table is narrowed to. An axis with no values narrows nothing. */
class PartTableFilter(
    /** The `TypeCategories` tags a part has to carry one of. */
    var categories: List<String> = emptyList(),
    /** The component types a part has to carry one of. */
    var components: List<String> = emptyList(),
    /** The mods a part may come from. */
    var sources: List<String> = emptyList(),
)

/** Parameters of the `cosmoteer/partTable` request. */
class PartTableParams(
    /** The document the table is scoped to, which decides the mod it reads beside the game data. */
    var textDocument: TextDocumentIdentifier? = null,
    /** The column paths to compute, null on the first build so the server ranks them. */
    var columns: List<String>? = null,
    /** Which parts to narrow to, null for all of them. */
    var filter: PartTableFilter? = null,
    /** Read the parts from disk again rather than answering from the walk of the last build. */
    var refresh: Boolean = false,
    /** The columns version the page holds, so the answer can leave the columns out while it stands. */
    var columnsVersion: String? = null,
)

/** The `cosmoteer/partTableProgress` notice: how far the server's walk over the parts has come. */
class PartTableProgress(
    /** How many parts have been read. */
    var done: Int = 0,
    /** How many parts the walk reads in all. */
    var total: Int = 0,
)

/** Parameters of the `cosmoteer/partTableFormula` request. */
class PartTableFormulaParams(
    /** The expression, written over column paths in square brackets. */
    var formula: String = "",
    /** The row key `ref(…)` reads, null when the table compares nothing. */
    var reference: String? = null,
    /** The other formula columns by name, so one formula may read another by its name. */
    var formulas: Map<String, String>? = null,
    /** The row keys on screen, which the column aggregates run over. */
    var rows: List<String>? = null,
    /** Row key to column path to number or null: the values the reader typed over cells, passed through as JSON. */
    var overrides: JsonObject? = null,
)

/** Parameters of the `cosmoteer/partTableEdit` request (mirror of the server's PartTableEditParams). */
class PartTableEditParams(
    /** The row key of the part the value belongs to. */
    var row: String = "",
    /** The column path of the cell. */
    var column: String = "",
    /** The text the reader typed, written into the file as it stands. */
    var text: String = "",
)

/** Result of the `cosmoteer/partTableEdit` request (mirror of the server's PartTableEditResult). */
class PartTableEditResult(
    var status: String = "notFound",
    var edit: WorkspaceEdit? = null,
    var message: String? = null,
    /** Where a write that followed a reference landed, shown in the page's notice line. */
    var note: String? = null,
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
     * Renders what the group at a position loads differently from the nearest base of it the game
     * ships itself.
     *
     * @param params the document and a position inside the group.
     * @returns the markdown, or null when the group derives from nothing the game ships.
     */
    @JsonRequest("cosmoteer/baseDiff")
    fun baseDiff(params: TextDocumentPositionParams): CompletableFuture<String?>

    /**
     * Reads what a `.ship.png` blueprint places, and judges every part id it names.
     *
     * @param params the blueprint file.
     * @returns the markdown, or null when the file carries no saved ship.
     */
    @JsonRequest("cosmoteer/shipBlueprint")
    fun shipBlueprint(params: ModFileParams): CompletableFuture<String?>

    /**
     * Builds the drawn resource wiring of the part at a position.
     *
     * @param params the document and a position inside the part.
     * @returns the diagram payload, or null when the part carries no resources.
     */
    @JsonRequest("cosmoteer/resourceFlowDiagram")
    fun resourceFlowDiagram(params: TextDocumentPositionParams): CompletableFuture<JsonObject?>

    /**
     * Builds the drawn firing chain of the part at a position.
     *
     * @param params the document and a position inside the part.
     * @returns the diagram payload, or null when the part fires nothing.
     */
    @JsonRequest("cosmoteer/effectChainDiagram")
    fun effectChainDiagram(params: TextDocumentPositionParams): CompletableFuture<JsonObject?>

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

    /**
     * Builds the part comparison table: every part of the game and of the mod being edited, the
     * member paths they carry, and the values of the columns the view is showing.
     *
     * @param params the scoping document and the columns to compute.
     * @returns the table, or null when it could not be built.
     */
    @JsonRequest("cosmoteer/partTable")
    fun partTable(params: PartTableParams): CompletableFuture<JsonObject?>

    /**
     * Computes one formula column over the table the last build produced.
     *
     * @param params the formula and the row it compares against.
     * @returns the value per row key, or the message to show when the formula does not parse.
     */
    @JsonRequest("cosmoteer/partTableFormula")
    fun partTableFormula(params: PartTableFormulaParams): CompletableFuture<JsonObject?>

    /**
     * Turns a value typed over a table cell into the WorkspaceEdit that writes it into the file the
     * cell was read from.
     *
     * @param params the row, the column and the typed text.
     * @returns the edit and its status, or the message to show when the cell cannot be written.
     */
    @JsonRequest("cosmoteer/partTableEdit")
    fun partTableEdit(params: PartTableEditParams): CompletableFuture<PartTableEditResult?>
}
