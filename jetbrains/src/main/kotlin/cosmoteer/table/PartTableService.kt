package cosmoteer.table

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.redhat.devtools.lsp4ij.LSPIJUtils
import cosmoteer.lsp.PartTableEditParams
import cosmoteer.lsp.PartTableEditResult
import cosmoteer.lsp.PartTableFilter
import cosmoteer.lsp.PartTableFormulaParams
import cosmoteer.lsp.PartTableParams
import cosmoteer.lsp.requestFromServer
import cosmoteer.preview.JcefPageHost
import cosmoteer.preview.JcefSupport
import org.eclipse.lsp4j.TextDocumentIdentifier
import java.awt.datatransfer.StringSelection
import java.util.concurrent.CompletableFuture
import javax.swing.JComponent

/**
 * Owns the part comparison table: a JCEF browser running the same page the VS Code extension ships
 * (`media/part-table.js`). The service asks the language server for the table, pushes it into the
 * page as a `message` event, and answers the page's column picks, formula columns, typed values,
 * jumps and export the same way the VS Code panel does.
 */
@Service(Service.Level.PROJECT)
class PartTableService(private val project: Project) : Disposable {
    private val gson = Gson()
    private val page = JcefPageHost(
        "Part Table",
        "part-table",
        PAGE_BODY,
        null,
        "The part table needs the embedded browser (JCEF), which this IDE runtime does not support.",
        logger<PartTableService>(),
        "Bad message from the part table page",
        ::onPageMessage
    )

    /** The file the table is scoped to, which decides the mod it reads beside the game data. */
    @Volatile private var scope: VirtualFile? = null

    /** True while a table request is out, which is when the server's progress is worth relaying. */
    @Volatile private var waiting = false

    /** Whether the page keeps its table on screen through the current wait. */
    @Volatile private var quietWait = false

    /** The Swing component the tool window shows: the browser, or a notice when JCEF is unavailable. */
    fun component(): JComponent = page.component()

    /**
     * Shows the table for a file's scope: reveals the tool window and asks the server for the rows.
     *
     * @param file the `.rules` file the table is scoped to, null to read the game data alone.
     */
    fun show(file: VirtualFile?) {
        scope = file
        ApplicationManager.getApplication().invokeLater {
            ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.show()
            request(null, null)
        }
    }

    /**
     * Asks the server for the table and pushes it into the page.
     *
     * @param columns the column paths to compute, null to let the server rank them.
     * @param pendingFormula the formula the page is waiting to have computed once the columns land.
     * @param filter which parts to narrow to, null for all of them.
     * @param refresh whether to read the parts from disk again rather than from the last walk.
     * @param columnsVersion the columns version the page holds, so the answer can leave them out.
     * @param quiet whether the page keeps its table on screen while it waits, as it does following an edit.
     */
    private fun request(
        columns: List<String>?,
        pendingFormula: String?,
        filter: PartTableFilter? = null,
        refresh: Boolean = false,
        columnsVersion: String? = null,
        quiet: Boolean = false
    ) {
        val params = PartTableParams(
            scope?.let { TextDocumentIdentifier(LSPIJUtils.toUri(it).toASCIIString()) },
            columns,
            filter,
            refresh,
            columnsVersion
        )
        // The page says it is waiting rather than sitting on a stale table. The first build walks
        // every part of the install, which is seconds rather than an instant.
        quietWait = quiet
        waiting = true
        page.post(gson.toJson(JsonObject().apply {
            addProperty("type", "loading")
            addProperty("quiet", quiet)
        }))
        requestFromServer(project) { server -> server.partTable(params) }
            .whenComplete { _, _ -> waiting = false }
            .thenAccept { data ->
                val message = JsonObject().apply {
                    addProperty("type", "table")
                    if (data != null) add("table", data)
                    columns?.let { add("columns", gson.toJsonTree(it)) }
                    pendingFormula?.let { addProperty("pendingFormula", it) }
                }
                page.post(gson.toJson(message))
            }
            .exceptionally { error ->
                logger<PartTableService>().warn("Part table request failed", error)
                null
            }
    }

    /**
     * Tells the page how far the server's walk has come, while a request is out. The wait for a
     * large mod says which part it is on rather than nothing.
     *
     * @param done how many parts have been read.
     * @param total how many parts the walk reads in all.
     */
    fun notifyProgress(done: Int, total: Int) {
        if (!page.isReady() || !waiting) return
        page.post(gson.toJson(JsonObject().apply {
            addProperty("type", "loading")
            addProperty("text", "Reading part $done of $total…")
            addProperty("quiet", quietWait)
        }))
    }

    /**
     * Computes one formula column and pushes the result into the page.
     *
     * @param id the page's own id for the column.
     * @param params the formula, the row it compares against, the other formulas, the rows on
     *   screen and the typed values.
     */
    private fun requestFormula(id: String, params: PartTableFormulaParams) {
        requestFromServer(project) { server -> server.partTableFormula(params) }
            .thenAccept { result ->
                val message = JsonObject().apply {
                    addProperty("type", "formulaResult")
                    addProperty("id", id)
                    result?.entrySet()?.forEach { (key, value) -> add(key, value) }
                }
                page.post(gson.toJson(message))
            }
            .exceptionally { error ->
                logger<PartTableService>().warn("Part table formula failed", error)
                null
            }
    }

    /**
     * Writes the values the reader typed over cells into their files, one after the other, and
     * tells the page how each of them went.
     *
     * The edits run in sequence rather than side by side because two of them may land in the same
     * file, and an edit computed against the text before the other one was applied would write to
     * the wrong place. The page clears a written value when it hears `ok`, and the table reads
     * itself again on the change notice the server sends after the write.
     *
     * @param edits the page's edits, each a row key, a column path and the typed text.
     */
    private fun applyEdits(edits: List<PartTableEditParams>) {
        val results = mutableListOf<JsonObject>()
        var chain: CompletableFuture<Void> = CompletableFuture.completedFuture(null)
        for (params in edits) {
            chain = chain.thenCompose {
                requestFromServer(project) { server -> server.partTableEdit(params) }
                    .thenApply { result -> resultOf(params, result) }
                    .exceptionally { error ->
                        logger<PartTableService>().warn("Part table edit failed", error)
                        resultOf(params, null)
                    }
                    .thenAccept { result -> results.add(result) }
            }
        }
        chain.thenRun {
            val message = JsonObject().apply {
                addProperty("type", "editsApplied")
                add("results", gson.toJsonTree(results))
            }
            page.post(gson.toJson(message))
        }
    }

    /**
     * Applies one edit the server answered with and shapes the answer the page reads.
     *
     * @param params the edit that was asked for.
     * @param result the server's answer, null when the request itself failed.
     * @returns the page's result object: the row, the column, the status and any message or note.
     */
    private fun resultOf(params: PartTableEditParams, result: PartTableEditResult?): JsonObject {
        val edit = result?.edit
        if (result?.status == "ok" && edit != null) {
            ApplicationManager.getApplication().invokeLater {
                WriteCommandAction.runWriteCommandAction(project, "Edit Part Table", null, {
                    LSPIJUtils.applyWorkspaceEdit(edit)
                })
            }
        }
        return JsonObject().apply {
            addProperty("row", params.row)
            addProperty("column", params.column)
            if (result == null) {
                addProperty("status", "error")
                addProperty("message", "The value could not be written.")
            } else {
                addProperty("status", result.status)
                result.message?.let { addProperty("message", it) }
                result.note?.let { addProperty("note", it) }
            }
        }
    }

    /**
     * Tells the page the files moved under the table, so it asks for the table again. A page that
     * is not up yet has no table to be stale, so nothing is queued.
     */
    fun notifyChanged() {
        if (!page.isReady()) return
        page.post("""{"type":"changed"}""")
    }

    /**
     * The filter the page sent, read into the shape the request takes.
     *
     * @param filter the page's filter object, null when it sent none.
     * @returns the filter, or null when nothing is narrowed.
     */
    private fun filterOf(filter: JsonObject?): PartTableFilter? {
        if (filter == null) return null
        val axis = { name: String ->
            filter.getAsJsonArray(name)?.mapNotNull { it.asString }?.filter { it.isNotEmpty() } ?: emptyList()
        }
        val categories = axis("categories")
        val components = axis("components")
        val sources = axis("sources")
        if (categories.isEmpty() && components.isEmpty() && sources.isEmpty()) return null
        return PartTableFilter(categories, components, sources)
    }

    /**
     * The views saved on this machine, keyed by the name the reader gave them.
     *
     * @returns the saved views, empty when none has been saved or the stored text cannot be read.
     */
    private fun savedViews(): JsonObject =
        runCatching { JsonParser.parseString(PropertiesComponent.getInstance().getValue(VIEWS_KEY)).asJsonObject }
            .getOrElse { JsonObject() }

    /**
     * Hands the page the saved views, after a save, a delete, or on its first request. The working
     * state rides along, which is what the page puts back when it opens.
     */
    private fun postViews() {
        val kept = runCatching {
            JsonParser.parseString(PropertiesComponent.getInstance().getValue(STATE_KEY)).asJsonObject
        }.getOrElse { JsonObject() }
        val message = JsonObject().apply {
            addProperty("type", "views")
            add("views", savedViews())
            kept.get("view")?.let { add("state", it) }
            addProperty("activeView", kept.get("activeView")?.asString ?: "")
        }
        page.post(gson.toJson(message))
    }

    /** Handles messages the page sends through the shimmed `acquireVsCodeApi().postMessage`. */
    private fun onPageMessage(message: JsonObject) {
        when (message.get("type")?.asString) {
            "columns", "refresh" -> {
                val columns = message.getAsJsonArray("columns")?.map { it.asString }
                request(
                    columns,
                    message.get("pendingFormula")?.asString,
                    filterOf(message.getAsJsonObject("filter")),
                    message.get("refresh")?.asBoolean ?: false,
                    message.get("columnsVersion")?.takeUnless { it.isJsonNull }?.asString,
                    message.get("quiet")?.asBoolean ?: false
                )
            }
            "listViews" -> postViews()
            "saveState" -> {
                val kept = JsonObject().apply {
                    message.get("view")?.let { add("view", it) }
                    addProperty("activeView", message.get("activeView")?.asString ?: "")
                }
                PropertiesComponent.getInstance().setValue(STATE_KEY, gson.toJson(kept))
            }
            "saveView" -> {
                val name = message.get("name")?.asString ?: return
                val view = message.get("view") ?: return
                val stored = savedViews().apply { add(name, view) }
                PropertiesComponent.getInstance().setValue(VIEWS_KEY, gson.toJson(stored))
                postViews()
            }
            "deleteView" -> {
                val name = message.get("name")?.asString ?: return
                val stored = savedViews().apply { remove(name) }
                PropertiesComponent.getInstance().setValue(VIEWS_KEY, gson.toJson(stored))
                postViews()
            }
            "formula" -> {
                val id = message.get("id")?.asString ?: return
                val formula = message.get("formula")?.asString ?: return
                val formulas = message.get("formulas")?.takeIf { it.isJsonObject }?.asJsonObject
                    ?.entrySet()?.associate { (name, value) -> name to value.asString }
                val rows = message.get("rows")?.takeIf { it.isJsonArray }?.asJsonArray?.map { it.asString }
                val overrides = message.get("overrides")?.takeIf { it.isJsonObject }?.asJsonObject
                val params = PartTableFormulaParams(
                    formula,
                    message.get("reference")?.asString?.takeIf { it.isNotEmpty() },
                    formulas,
                    rows,
                    overrides
                )
                requestFormula(id, params)
            }
            "applyEdits" -> {
                val edits = message.get("edits")?.takeIf { it.isJsonArray }?.asJsonArray
                    ?.mapNotNull { it.takeIf { entry -> entry.isJsonObject }?.asJsonObject }
                    ?.map { edit ->
                        PartTableEditParams(
                            edit.get("row")?.asString ?: "",
                            edit.get("column")?.asString ?: "",
                            edit.get("text")?.asString ?: ""
                        )
                    }
                    ?: emptyList()
                if (edits.isNotEmpty()) applyEdits(edits)
            }
            "copyCsv" -> {
                val text = message.get("text")?.asString ?: return
                CopyPasteManager.getInstance().setContents(StringSelection(text))
            }
            "openLocation" -> {
                val uri = message.get("uri")?.asString ?: return
                val start = message.getAsJsonObject("range")?.getAsJsonObject("start")
                val line = start?.get("line")?.asInt ?: 0
                val character = start?.get("character")?.asInt ?: 0
                ApplicationManager.getApplication().invokeLater {
                    val path = JcefSupport.uriToPath(uri) ?: return@invokeLater
                    val file = VfsUtil.findFile(path, true) ?: return@invokeLater
                    OpenFileDescriptor(project, file, line, character).navigate(true)
                }
            }
        }
    }

    override fun dispose() {
        page.dispose()
    }

    companion object {
        const val TOOL_WINDOW_ID = "Cosmoteer Part Table"

        /** Where the saved views live, shared by every project the way the game's parts are. */
        private const val VIEWS_KEY = "cosmoteer.partTable.views"

        /** Where the working state lives, so closing the tool window loses nothing. */
        private const val STATE_KEY = "cosmoteer.partTable.state"

        fun getInstance(project: Project): PartTableService = project.getService(PartTableService::class.java)

        /** The page's markup, which the shared script draws into. */
        private const val PAGE_BODY = """<div id="page">
<div id="toolbar">
<input id="search" type="search" />
<select id="category"></select>
<select id="component"></select>
<select id="source"></select>
<select id="group"></select>
<button id="toggle-tree" type="button" class="secondary">Hide tree</button>
<button id="pick-columns" type="button" class="secondary">Columns…</button>
<button id="add-formula" type="button" class="secondary">Add formula</button>
<button id="clear-formulas" type="button" class="secondary">Clear formulas</button>
<button id="pick-views" type="button" class="secondary">Views…</button>
<label class="check">Compare with <input id="reference" type="search" list="reference-options" /></label>
<datalist id="reference-options"></datalist>
<label class="check"><input id="percent" type="checkbox" disabled />Show as % of that part</label>
<span id="legend" class="legend" hidden><span class="swatch below"></span>below <span class="swatch same"></span>same <span class="swatch above"></span>above</span>
<label class="check"><input id="per-tile" type="checkbox" />Per tile</label>
<button id="copy-csv" type="button" class="secondary">Copy as CSV</button>
<button id="refresh" type="button" class="secondary">Refresh</button>
<button id="apply-edits" type="button" hidden></button><button id="discard-edits" type="button" class="secondary" hidden></button>
<div id="status"></div>
<div id="notice" hidden></div>
</div>
<div id="loading"><span class="spinner"></span><span class="text">Reading the parts…</span></div>
<div id="body">
<div id="tree" hidden></div>
<div id="main">
<div id="stage"></div>
<div id="empty" hidden></div>
</div>
</div>
<div id="columns-panel" class="panel" hidden>
<h2>Columns</h2>
<input id="column-search" type="search" />
<div id="column-list" class="list"></div>
<div class="actions">
<button id="columns-close" type="button" class="secondary">Close</button>
<button id="columns-apply" type="button">Show these</button>
</div>
</div>
<div id="views-panel" class="panel" hidden>
<h2>Saved views</h2>
<div class="hint">A view keeps the filters, the grouping, the columns, the formulas, the frozen columns, the sort, the compared part and any values you typed.</div>
<div class="row"><input id="view-name" type="text" placeholder="Name this view" /><button id="view-save" type="button">Save</button></div>
<div id="view-list" class="list"></div>
<div class="actions">
<button id="views-close" type="button" class="secondary">Close</button>
</div>
</div>
<div id="formula-panel" class="panel" hidden>
<h2>Formula column</h2>
<input id="formula-name" type="text" />
<input id="formula-text" type="text" />
<div id="formula-error" hidden></div>
<div class="hint">Write column paths in square brackets, exactly as the column picker spells them. A path with no slashes may be written bare, and another formula is named by its name. A * in a path matches every column it fits, so sum([Resources/*]) adds every resource. The functions of the rules math are available (round, min, max, sum, avg, abs, sqrt, …), plus if(condition, then, else), coalesce(a, b, …) for the first value that exists, has(column), ref(column) for the value of the compared part, and colmin, colmax, colavg, colsum, colcount, colmedian and rank over the parts on screen. Double-click a cell to try a value; the formulas follow it, and "Write changes" puts it in the file.</div>
<div class="hint">Pick an example to start from:</div>
<div id="formula-examples" class="examples list"></div>
<div class="hint">Insert a column on screen:</div>
<div id="formula-columns" class="examples list"></div>
<div class="actions">
<button id="formula-close" type="button" class="secondary">Close</button>
<button id="formula-apply" type="button">Add column</button>
</div>
</div>
</div>"""
    }
}
