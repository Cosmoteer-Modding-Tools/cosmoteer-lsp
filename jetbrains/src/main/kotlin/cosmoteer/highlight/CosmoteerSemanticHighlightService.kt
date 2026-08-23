package cosmoteer.highlight

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.EditorKind
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.MarkupModel
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiFile
import com.intellij.util.Alarm
import com.redhat.devtools.lsp4ij.LSPIJUtils
import com.redhat.devtools.lsp4ij.LanguageServerItem
import com.redhat.devtools.lsp4ij.LanguageServerManager
import com.redhat.devtools.lsp4ij.features.semanticTokens.SemanticTokensColorsProvider
import cosmoteer.settings.CosmoteerSettings
import org.eclipse.lsp4j.SemanticTokens
import org.eclipse.lsp4j.SemanticTokensDelta
import org.eclipse.lsp4j.SemanticTokensDeltaParams
import org.eclipse.lsp4j.SemanticTokensEdit
import org.eclipse.lsp4j.SemanticTokensLegend
import org.eclipse.lsp4j.SemanticTokensParams
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.jsonrpc.messages.Either
import java.util.concurrent.CompletableFuture

/**
 * Paints the language server's semantic tokens into the open editors of one project.
 *
 * LSP4IJ's own semantic-tokens support is switched off in
 * [cosmoteer.lsp.CosmoteerLanguageServerFactory] and replaced by this service. Its highlight
 * visitor contributes nothing at all while a token request is in flight or while the IDE is
 * indexing, and the code analysis daemon then commits that empty result as the file's semantic
 * layer, so every overlay color falls back to the plain TextMate rendering until a later pass
 * puts it back. That is the flicker the setting used to warn about.
 *
 * Here the tokens live in each editor's markup model instead. A range highlighter is a range
 * marker, so it follows the text through later edits on its own: a token set that is one edit old
 * drifts with the text rather than disappearing, and it is only ever replaced by a newer one that
 * was computed for the text as it stands. Nothing can drop the colors back to plain.
 *
 * Everything the service keeps is read and written on the event dispatch thread only, which is
 * where the editor and document events arrive and where every server answer is handed back.
 */
@Service(Service.Level.PROJECT)
class CosmoteerSemanticHighlightService(private val project: Project) : Disposable {

    /** One token painted into one editor, kept so the next answer can be diffed against it. */
    private class PaintedToken(val highlighter: RangeHighlighter, val key: TextAttributesKey)

    /** One token of a server answer, resolved to document offsets and a color key. */
    private class DecodedToken(val start: Int, val end: Int, val key: TextAttributesKey)

    /**
     * A server answer, carried from the request's completion thread to the paint step.
     *
     * Exactly one of [tokens] and [edits] is set: a full answer replaces the token array, a delta
     * answer patches the array the last painted set was built from.
     */
    private class TokenAnswer(
        val tokens: List<Int>?,
        val edits: List<SemanticTokensEdit>?,
        val resultId: String?,
        val legend: SemanticTokensLegend,
        val colors: SemanticTokensColorsProvider,
    )

    /**
     * What the service knows about one open document.
     *
     * [tokens] is always the array the highlighters in [editors] were built from, so it is also
     * the base the server's next delta is applied to. It is updated in the same step that paints,
     * never before, which is what keeps a discarded answer from corrupting the next one.
     */
    private class DocumentOverlay(val refresh: Runnable) {
        var tokens: List<Int> = emptyList()
        var resultId: String? = null
        val editors: MutableMap<Editor, MutableList<PaintedToken>> = LinkedHashMap()
        var requestInFlight = false
        var emptyAnswers = 0
    }

    private val overlays: MutableMap<Document, DocumentOverlay> = HashMap()
    private val refreshAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)

    init {
        val factory = EditorFactory.getInstance()
        factory.addEditorFactoryListener(object : EditorFactoryListener {
            override fun editorCreated(event: EditorFactoryEvent) = attach(event.editor)

            override fun editorReleased(event: EditorFactoryEvent) = detach(event.editor)
        }, this)
        factory.eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                if (overlays.containsKey(event.document)) scheduleRefresh(event.document, EDIT_DEBOUNCE_MS)
            }
        }, this)
    }

    /**
     * Starts tracking the editors the project already has open. A project service is created the
     * first time something asks for it, which without this would be the first editor opened after
     * startup, leaving the files restored with the project unpainted.
     */
    fun attachOpenEditors() {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            for (editor in EditorFactory.getInstance().allEditors) attach(editor)
        }
    }

    /**
     * Re-reads the "Semantic highlighting from the language server" setting: repaints every
     * tracked editor, or takes the overlay off them. Called when the settings page is applied, so
     * the switch lands on the open files instead of only on the next one opened.
     */
    fun settingChanged() {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (isOverlayEnabled()) {
                for (document in overlays.keys.toList()) scheduleRefresh(document, 0)
                return@invokeLater
            }
            for (overlay in overlays.values) {
                for ((editor, painted) in overlay.editors) removeAll(editor, painted)
                overlay.tokens = emptyList()
                overlay.resultId = null
                overlay.emptyAnswers = 0
            }
        }
    }

    /**
     * Starts tracking one editor, when it is a main editor of this project showing a file the
     * server understands.
     *
     * @param editor the editor to paint into.
     */
    private fun attach(editor: Editor) {
        if (editor.isDisposed || editor.project !== project) return
        if (editor.editorKind != EditorKind.MAIN_EDITOR) return
        val file = FileDocumentManager.getInstance().getFile(editor.document) ?: return
        if (!file.isInLocalFileSystem) return
        val extension = file.extension?.lowercase() ?: return
        if (extension !in HANDLED_EXTENSIONS) return
        val document = editor.document
        val overlay = overlays.getOrPut(document) { DocumentOverlay(Runnable { refresh(document) }) }
        if (overlay.editors.containsKey(editor)) return
        overlay.editors[editor] = ArrayList()
        scheduleRefresh(document, OPEN_DELAY_MS)
    }

    /**
     * Stops tracking one editor. Its highlighters go with the editor, so only the bookkeeping is
     * dropped, and the document itself is forgotten once its last editor is gone.
     *
     * @param editor the editor being released.
     */
    private fun detach(editor: Editor) {
        val overlay = overlays[editor.document] ?: return
        overlay.editors.remove(editor)
        if (overlay.editors.isEmpty()) {
            refreshAlarm.cancelRequest(overlay.refresh)
            overlays.remove(editor.document)
        }
    }

    /**
     * Queues one refresh of a document, replacing any refresh already queued for it.
     *
     * @param document the document to re-request tokens for.
     * @param delayMs how long to sit out further keystrokes first.
     */
    private fun scheduleRefresh(document: Document, delayMs: Int) {
        val overlay = overlays[document] ?: return
        if (refreshAlarm.isDisposed) return
        refreshAlarm.cancelRequest(overlay.refresh)
        refreshAlarm.addRequest(overlay.refresh, delayMs)
    }

    /**
     * Sends one token request for a document, unless one is already out for it.
     *
     * @param document the document to tokenize.
     */
    private fun refresh(document: Document) {
        if (project.isDisposed) return
        val overlay = overlays[document] ?: return
        if (!isOverlayEnabled() || overlay.requestInFlight) return
        val file = FileDocumentManager.getInstance().getFile(document) ?: return
        // The same helper LSP4IJ addresses the file with when it opens it on the server, so the
        // request names the document the server actually holds.
        val identifier = TextDocumentIdentifier(LSPIJUtils.toUriAsString(file))
        val previousResultId = overlay.resultId
        val stamp = document.modificationStamp
        overlay.requestInFlight = true
        // LSP4IJ sends its own textDocument/didChange once the PSI is committed. Queueing the
        // request behind the same gate keeps it ordered after the edit it is meant to describe,
        // so the server never answers this request from text one keystroke old.
        PsiDocumentManager.getInstance(project).performForCommittedDocument(document) {
            sendRequest(document, identifier, previousResultId, stamp)
        }
    }

    /**
     * Resolves the language server and asks it for the document's tokens, handing the answer back
     * to the event dispatch thread.
     *
     * @param document the document being tokenized.
     * @param identifier the document as the server addresses it.
     * @param previousResultId the id of the token array currently painted, or null for a full request.
     * @param stamp the document's modification stamp when the request was built.
     */
    private fun sendRequest(
        document: Document,
        identifier: TextDocumentIdentifier,
        previousResultId: String?,
        stamp: Long,
    ) {
        if (project.isDisposed) {
            overlays[document]?.requestInFlight = false
            return
        }
        LanguageServerManager.getInstance(project)
            .getLanguageServer(SERVER_ID)
            .thenCompose { item -> tokenRequest(item, identifier, previousResultId) }
            .whenComplete { answer, error ->
                if (error != null) {
                    logger<CosmoteerSemanticHighlightService>().warn("Semantic token request failed", error)
                }
                ApplicationManager.getApplication().invokeLater {
                    onAnswer(document, previousResultId, stamp, answer)
                }
            }
    }

    /**
     * Builds the one request to send, taking the delta form whenever the server offers it and a
     * previous answer is still painted. A delta ships only the changed slice of the token array.
     *
     * @param item the resolved language server, or null when none is running.
     * @param identifier the document as the server addresses it.
     * @param previousResultId the id of the token array currently painted, or null for a full request.
     * @returns the answer, or a future of null when the server cannot serve semantic tokens.
     */
    private fun tokenRequest(
        item: LanguageServerItem?,
        identifier: TextDocumentIdentifier,
        previousResultId: String?,
    ): CompletableFuture<TokenAnswer?> {
        if (item == null) return CompletableFuture.completedFuture(null)
        val provider = item.serverCapabilities?.semanticTokensProvider ?: return CompletableFuture.completedFuture(null)
        // The legend is the contract for reading the token array: a token's type and modifiers are
        // indexes into it, so it is taken from the server's own answer and never assumed.
        val legend = provider.legend ?: return CompletableFuture.completedFuture(null)
        val colors = item.semanticTokensColorsProvider
        val full = provider.full
        val deltaOffered = full != null && full.isRight && full.right?.delta == true
        if (previousResultId != null && deltaOffered) {
            return item.textDocumentService
                .semanticTokensFullDelta(SemanticTokensDeltaParams(identifier, previousResultId))
                .thenApply { either -> deltaAnswer(either, legend, colors) }
        }
        return item.textDocumentService
            .semanticTokensFull(SemanticTokensParams(identifier))
            .thenApply { tokens -> fullAnswer(tokens, legend, colors) }
    }

    /**
     * Reads a full token answer.
     *
     * @param tokens the server's answer.
     * @param legend the token type and modifier names the answer's indexes point into.
     * @param colors the provider turning a token's type and modifiers into an editor color.
     * @returns the answer, or null when the server sent nothing.
     */
    private fun fullAnswer(
        tokens: SemanticTokens?,
        legend: SemanticTokensLegend,
        colors: SemanticTokensColorsProvider,
    ): TokenAnswer? =
        if (tokens == null) null else TokenAnswer(tokens.data ?: emptyList(), null, tokens.resultId, legend, colors)

    /**
     * Reads a delta answer. The server falls back to a full result whenever the id the request
     * named is no longer the one it holds, which the answer type allows, so both shapes arrive here.
     *
     * @param either the server's answer, either a full token array or a patch.
     * @param legend the token type and modifier names the answer's indexes point into.
     * @param colors the provider turning a token's type and modifiers into an editor color.
     * @returns the answer, or null when the server sent nothing.
     */
    private fun deltaAnswer(
        either: Either<SemanticTokens, SemanticTokensDelta>?,
        legend: SemanticTokensLegend,
        colors: SemanticTokensColorsProvider,
    ): TokenAnswer? {
        if (either == null) return null
        if (either.isLeft) return fullAnswer(either.left, legend, colors)
        val delta = either.right ?: return null
        return TokenAnswer(null, delta.edits ?: emptyList(), delta.resultId, legend, colors)
    }

    /**
     * Takes one server answer and repaints the document's editors with it, or keeps what is
     * painted when the answer no longer describes the text on screen.
     *
     * @param document the document the answer is for.
     * @param previousResultId the id the request was sent with, used to confirm a delta still applies.
     * @param stamp the document's modification stamp when the request was built.
     * @param answer the server's answer, or null when it could not be served.
     */
    private fun onAnswer(document: Document, previousResultId: String?, stamp: Long, answer: TokenAnswer?) {
        val overlay = overlays[document] ?: return
        overlay.requestInFlight = false
        if (project.isDisposed || !isOverlayEnabled()) return
        // The text moved on while the request was out, so the answer describes something else.
        // What is painted has drifted with the edit and stays, and a fresh request goes out.
        if (document.modificationStamp != stamp) {
            scheduleRefresh(document, EDIT_DEBOUNCE_MS)
            return
        }
        if (answer == null) return
        val tokens = when {
            answer.tokens != null -> answer.tokens
            // A patch only means anything against the array it was computed from. If that is no
            // longer what is painted, forget the id so the next request asks for the whole array.
            answer.edits != null && overlay.resultId == previousResultId -> applyEdits(overlay.tokens, answer.edits)
            else -> {
                overlay.resultId = null
                scheduleRefresh(document, 0)
                return
            }
        }
        if (tokens.isEmpty() && document.textLength > 0 && overlay.emptyAnswers < MAX_EMPTY_ANSWER_RETRIES) {
            // The server only tokenizes documents it has open, and on a freshly opened file its
            // didOpen can still be on its way. Keep what is painted and ask again shortly.
            overlay.emptyAnswers++
            scheduleRefresh(document, EMPTY_ANSWER_RETRY_MS)
            return
        }
        val psiFile = PsiDocumentManager.getInstance(project).getPsiFile(document) ?: return
        val decoded = decode(tokens, answer.legend, answer.colors, psiFile, document)
        overlay.emptyAnswers = 0
        overlay.tokens = tokens
        overlay.resultId = answer.resultId
        for ((editor, painted) in overlay.editors) {
            if (!editor.isDisposed) sync(editor, painted, decoded)
        }
    }

    /**
     * Applies the server's patch to the token array the painted highlighters were built from.
     * Every edit is described against that array, so they are applied from the last one backwards
     * and the earlier starts keep meaning what they meant.
     *
     * @param base the token array currently painted.
     * @param edits the server's patch.
     * @returns the patched token array.
     */
    private fun applyEdits(base: List<Int>, edits: List<SemanticTokensEdit>): List<Int> {
        val patched = ArrayList(base)
        for (edit in edits.sortedByDescending { it.start }) {
            val start = edit.start.coerceIn(0, patched.size)
            val deleteCount = edit.deleteCount.coerceIn(0, patched.size - start)
            if (deleteCount > 0) patched.subList(start, start + deleteCount).clear()
            edit.data?.let { patched.addAll(start, it) }
        }
        return patched
    }

    /**
     * Turns the delta-encoded token array into document offsets and color keys. Each token is
     * five numbers: the line step from the token before it, the character step, the length, the
     * index of its type in the legend, and its modifiers as a bit per legend entry.
     *
     * @param data the token array.
     * @param legend the token type and modifier names the indexes point into.
     * @param colors the provider turning a token's type and modifiers into an editor color.
     * @param psiFile the file, which a color provider may branch on.
     * @param document the text the offsets are resolved against.
     * @returns the tokens that fall inside the document, in document order.
     */
    private fun decode(
        data: List<Int>,
        legend: SemanticTokensLegend,
        colors: SemanticTokensColorsProvider,
        psiFile: PsiFile,
        document: Document,
    ): List<DecodedToken> {
        val types = legend.tokenTypes ?: return emptyList()
        val modifierNames = legend.tokenModifiers ?: emptyList()
        val decoded = ArrayList<DecodedToken>(data.size / 5)
        var line = 0
        var character = 0
        var index = 0
        while (index + 4 < data.size) {
            val lineStep = data[index]
            line += lineStep
            if (lineStep > 0) character = 0
            character += data[index + 1]
            val length = data[index + 2]
            val type = data[index + 3]
            val modifierBits = data[index + 4]
            index += 5
            if (length <= 0 || line < 0 || line >= document.lineCount) continue
            if (type < 0 || type >= types.size) continue
            // No token spans a line break, so a length that runs past the line end can only come
            // from text the answer no longer matches. Clamping keeps it on its own line.
            val lineStart = document.getLineStartOffset(line)
            val lineEnd = document.getLineEndOffset(line)
            val start = (lineStart + character).coerceIn(lineStart, lineEnd)
            val end = (start + length).coerceAtMost(lineEnd)
            if (end <= start) continue
            val key = colors.getTextAttributesKey(types[type], modifiers(modifierBits, modifierNames), psiFile) ?: continue
            decoded.add(DecodedToken(start, end, key))
        }
        return decoded
    }

    /**
     * Reads a token's modifier bits as legend names.
     *
     * @param bits one bit per legend entry, in legend order.
     * @param names the modifier names the bits point into.
     * @returns the names of the set bits.
     */
    private fun modifiers(bits: Int, names: List<String>): List<String> {
        if (bits == 0) return emptyList()
        val set = ArrayList<String>(2)
        for (index in names.indices) if (((bits shr index) and 1) == 1) set.add(names[index])
        return set
    }

    /**
     * Brings one editor's highlighters in line with a fresh token set, touching only the tokens
     * that actually differ. Both lists run in document order, so one walk over them finds the
     * difference, and an edit that shifted the text leaves most tokens matching where their
     * highlighters have already drifted to.
     *
     * @param editor the editor to paint.
     * @param painted the highlighters currently in that editor, updated in place.
     * @param fresh the token set the editor should show.
     */
    private fun sync(editor: Editor, painted: MutableList<PaintedToken>, fresh: List<DecodedToken>) {
        val markup = editor.markupModel
        val kept = ArrayList<PaintedToken>(fresh.size)
        var oldIndex = 0
        var newIndex = 0
        while (oldIndex < painted.size || newIndex < fresh.size) {
            val old = painted.getOrNull(oldIndex)
            // A highlighter whose text was deleted no longer stands for anything.
            if (old != null && !old.highlighter.isValid) {
                markup.removeHighlighter(old.highlighter)
                oldIndex++
                continue
            }
            val new = fresh.getOrNull(newIndex)
            if (old == null) {
                kept.add(paint(markup, new!!))
                newIndex++
                continue
            }
            if (new == null) {
                markup.removeHighlighter(old.highlighter)
                oldIndex++
                continue
            }
            val oldStart = old.highlighter.startOffset
            if (oldStart == new.start && old.highlighter.endOffset == new.end && old.key == new.key) {
                kept.add(old)
                oldIndex++
                newIndex++
            } else if (oldStart > new.start) {
                kept.add(paint(markup, new))
                newIndex++
            } else {
                markup.removeHighlighter(old.highlighter)
                oldIndex++
            }
        }
        painted.clear()
        painted.addAll(kept)
    }

    /**
     * Adds one token's highlighter to an editor. The color goes in as a key rather than as
     * resolved attributes, so a theme switch and the user's own color settings keep applying.
     *
     * @param markup the editor's markup model.
     * @param token the token to paint.
     * @returns the painted token.
     */
    private fun paint(markup: MarkupModel, token: DecodedToken): PaintedToken =
        PaintedToken(
            // Above the TextMate syntax layer, which stays the synchronous base rendering, and
            // below the layers the daemon paints warnings and errors on.
            markup.addRangeHighlighter(
                token.key,
                token.start,
                token.end,
                HighlighterLayer.ADDITIONAL_SYNTAX,
                HighlighterTargetArea.EXACT_RANGE
            ),
            token.key
        )

    /**
     * Takes the whole overlay off one editor.
     *
     * @param editor the editor to clear.
     * @param painted the highlighters in that editor, emptied in place.
     */
    private fun removeAll(editor: Editor, painted: MutableList<PaintedToken>) {
        if (!editor.isDisposed) {
            val markup = editor.markupModel
            for (token in painted) markup.removeHighlighter(token.highlighter)
        }
        painted.clear()
    }

    /** Whether the user wants the server's colors on top of the TextMate highlighting. */
    private fun isOverlayEnabled(): Boolean = CosmoteerSettings.getInstance().state.semanticTokensEnabled

    override fun dispose() {
        // The service is disposed with the project, which releases every editor it painted, so the
        // highlighters go on their own and only the bookkeeping has to be dropped here.
        overlays.clear()
    }

    companion object {
        /** The LSP4IJ server id the plugin registers the Cosmoteer server under. */
        private const val SERVER_ID = "cosmoteerLanguageServer"

        /** How long to sit out further keystrokes before asking for fresh tokens. */
        private const val EDIT_DEBOUNCE_MS = 250

        /** A short pause after an editor opens, so the first request follows the file's didOpen. */
        private const val OPEN_DELAY_MS = 50

        /** How long to wait before asking again when the server had no tokens for a file yet. */
        private const val EMPTY_ANSWER_RETRY_MS = 500

        /** How often to accept an empty answer for a file with text before believing it. */
        private const val MAX_EMPTY_ANSWER_RETRIES = 3

        /** The file kinds the server tokenizes, matching the plugin's LSP4IJ pattern mappings. */
        private val HANDLED_EXTENSIONS = setOf("rules", "shader")

        /**
         * Looks up the overlay service of one project.
         *
         * @param project the project whose editors are painted.
         * @returns that project's service.
         */
        fun getInstance(project: Project): CosmoteerSemanticHighlightService =
            project.getService(CosmoteerSemanticHighlightService::class.java)

        /**
         * Tells every open project that the semantic highlighting setting changed. The overlay is
         * painted by the plugin itself, so nothing else would repaint the open editors.
         */
        fun refreshOpenProjects() {
            for (project in ProjectManager.getInstance().openProjects) {
                if (!project.isDisposed) getInstance(project).settingChanged()
            }
        }
    }
}
