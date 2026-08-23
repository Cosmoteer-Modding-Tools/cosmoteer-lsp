import { CompletionItem, CompletionList, MarkupKind } from 'vscode-languageserver/node';
import { Completion } from '../features/completion/autocompletion.service';
import { toCompletionItem } from '../features/completion/completion-item';
import { hasCompletionDocResolveCapability, hasSnippetCapability } from './capabilities';

/** Upper bound of completion items shipped in one response. Larger lists (every localization key,
 *  every project id) are prefix-filtered and truncated, and marked incomplete so the client
 *  re-requests as the user types instead of holding a huge stale list. */
const COMPLETION_ITEM_CAP = 500;

/** Markdown documentation deferred out of recent completion responses, keyed by request id and
 *  item index, until the client resolves the selected item. Only the latest few requests are kept,
 *  a resolve only ever targets the list the client is currently showing. */
const completionDocStores: Map<number, Array<string | undefined>> = new Map();

/** Source of the completion request ids the deferred-documentation store is keyed by. */
let completionRequestCounter = 0;

/** How many recent completion responses keep their deferred documentation resolvable. */
const COMPLETION_DOC_STORES_KEPT = 4;

/**
 * Strips the Markdown documentation out of completion items and parks it in
 * {@link completionDocStores}, marking each stripped item with the store key in `item.data` so
 * `completionItem/resolve` can reattach it. Documentation is the bulk of a list's payload and the
 * client only ever shows one item's docs at a time, so shipping it lazily keeps the per-keystroke
 * response small. Only called when the client declared `resolveSupport` for `documentation`.
 *
 * @param items the completion items about to be returned.
 */
const deferCompletionDocumentation = (items: CompletionItem[]): void => {
    if (!items.some((item) => item.documentation !== undefined)) return;
    const requestId = ++completionRequestCounter;
    const docs: Array<string | undefined> = [];
    items.forEach((item, index) => {
        const documentation = item.documentation;
        if (documentation === undefined) return;
        docs[index] = typeof documentation === 'string' ? documentation : documentation.value;
        delete item.documentation;
        item.data = { docRequest: requestId, docIndex: index };
    });
    completionDocStores.set(requestId, docs);
    for (const key of completionDocStores.keys()) {
        if (completionDocStores.size <= COMPLETION_DOC_STORES_KEPT) break;
        completionDocStores.delete(key);
    }
};

/** The label of a completion, whichever of the two forms it takes. */
const labelOf = (completion: Completion): string => (typeof completion === 'string' ? completion : completion.label);

/**
 * Narrows an over-cap list to the completions the typed prefix can still match. The prefix keeps its
 * `/` and `.`, because a localization key is one slash-joined value and a cross-file id one dotted
 * value, and narrowing those on just the last segment leaves the list over-cap. A reference instead
 * completes one path segment at a time and its labels are leaf segments (`a.rules>`, `parts/`), which
 * a slash-joined prefix can never occur in, so the whole-prefix filter would narrow such a list to
 * nothing and serve an empty response. Retry on the segment being typed there.
 *
 * @param completions the over-cap completions.
 * @param wordPrefix the value text immediately left of the cursor.
 * @returns the completions the prefix still matches.
 */
const narrowedToPrefix = (completions: Completion[], wordPrefix: string): Completion[] => {
    if (!wordPrefix) return completions;
    const matching = (prefix: string): Completion[] =>
        completions.filter((completion) => labelOf(completion).toLowerCase().includes(prefix));
    const matched = matching(wordPrefix.toLowerCase());
    if (matched.length > 0 || !wordPrefix.includes('/')) return matched;
    const segment = wordPrefix.slice(wordPrefix.lastIndexOf('/') + 1).toLowerCase();
    return segment ? matching(segment) : completions;
};

/**
 * Packs raw completions into the LSP response list. Lists over {@link COMPLETION_ITEM_CAP} are
 * narrowed to the word prefix at the cursor and truncated, and flagged `isIncomplete` so the
 * client asks again on the next keystroke with the narrower prefix.
 *
 * @param completions the raw completions of the matched strategy.
 * @param wordPrefix the identifier-like text immediately left of the cursor.
 * @returns the completion list to return to the client.
 */
export const finishCompletionList = (completions: Completion[], wordPrefix: string): CompletionList => {
    // An empty list is never authoritative. It can come from a still-warming index, a cancelled
    // cross-file walk, or a swallowed error, and the client caches a complete empty list for the
    // whole suggest session (typing then only refilters the cached nothing). Incomplete makes the
    // client re-request on the next keystroke, so a transient empty heals itself.
    let isIncomplete = completions.length === 0;
    if (completions.length > COMPLETION_ITEM_CAP) {
        completions = narrowedToPrefix(completions, wordPrefix).slice(0, COMPLETION_ITEM_CAP);
        // The served set depends on the typed prefix, so the client must re-request as it changes.
        isIncomplete = true;
    }
    const items = completions.map<CompletionItem>((completion) => toCompletionItem(completion, hasSnippetCapability));
    if (hasCompletionDocResolveCapability) deferCompletionDocumentation(items);
    return { isIncomplete, items };
};

/**
 * Reattaches the documentation deferred out of an earlier response, for the item the client is
 * about to show.
 *
 * @param item the item the client asked to resolve.
 * @returns the item, carrying its documentation when it had any deferred.
 */
export function resolveCompletionDocumentation(item: CompletionItem): CompletionItem {
    const data = item.data as { docRequest?: number; docIndex?: number } | undefined;
    if (data?.docRequest !== undefined && data.docIndex !== undefined) {
        const documentation = completionDocStores.get(data.docRequest)?.[data.docIndex];
        if (documentation !== undefined) {
            item.documentation = { kind: MarkupKind.Markdown, value: documentation };
        }
    }
    return item;
}
