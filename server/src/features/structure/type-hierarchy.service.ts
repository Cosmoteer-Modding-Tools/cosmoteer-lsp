import {
    CancellationToken,
    CancellationTokenSource,
    Position,
    Range,
    SymbolKind,
    TypeHierarchyItem,
    WorkDoneProgressReporter,
} from 'vscode-languageserver';
import * as l10n from '@vscode/l10n';
import {
    AbstractNode,
    AbstractNodeDocument,
    AstPosition,
    GroupNode,
    ListNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { AddBaseIndex } from '../../mod/add-base.index';
import { findInheritorsOf } from '../../semantics/inheritor-resolver';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { workspaceRelativePath } from '../../utils/relative-path';
import { FileTree, isFile } from '../../workspace/cosmoteer-workspace.service';
import { cachedParseFilePath } from '../../workspace/fs-cache';
import { atOrBefore, enclosingRange, orderRange, unionRange } from '../navigation/ast-range';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { filePathToUri } from '../navigation/navigation-strategy';
import { normalizeUri, rangeOf } from '../navigation/reference-location';
import { uriToFsPath } from '../navigation/workspace-files';

/**
 * Type hierarchy (`textDocument/prepareTypeHierarchy` and its two expansions) over `Foo : Bar`
 * inheritance.
 *
 * A container's supertypes are the bases it writes, plus whatever a mod's `AddBase` action appends
 * to it, each resolved through the navigation go-to-definition already uses. Its subtypes are every
 * container in the project naming it as a base, which {@link findInheritorsOf} answers by narrowing
 * to the files mentioning the name and confirming each candidate by resolving it back. Only the
 * direct level is answered per request, which is what the protocol asks for and what keeps a chain
 * like `Part` (177 vanilla files name it, 14 inherit it directly) out of a single response.
 *
 * The file sits outside the cache-build-id seed dirs on purpose (see `esbuild.cache-id.mjs`): it
 * reads the indexes and feeds no cache, so shipping it keeps every user's on-disk caches valid.
 * That is also why the subtype scan is bounded with a budget token handed to the existing resolver
 * rather than with a limit argument added to it, which would have edited a seed.
 */

/** A named or positional group/list: the only shape that can take part in an inheritance chain. */
type Container = GroupNode | ListNode;

/** The shared resolver that turns one written inheritance reference into the node it names. */
const navigation = new FullNavigationStrategy();

/**
 * How many subtypes one expansion answers with. The largest real subtype set in the vanilla tree is
 * 182 (`AudioExterior` in `common_effects/sounds/base_sounds.rules`) and the 99th percentile over
 * 180 sampled vanilla bases is 129, so no genuine base is cut short. The cap only bounds the payload
 * of a generated mod that derives one base thousands of times.
 */
const SUBTYPE_LIMIT = 400;

/**
 * How long one subtype expansion may scan before answering with what it has. Cost tracks the number
 * of files naming the base, not the number of subtypes: the worst measured case is `Components` with
 * the largest published mod open (846 candidate files, 1912 ms cold, 1185 ms warm), so this budget is
 * a little over twice the worst real workspace and truncates nothing that exists today.
 */
const SUBTYPE_BUDGET_MS = 4000;

/** One AST position as a protocol range. An {@link AstPosition} records a single line. */
const posToRange = (position: AstPosition): Range =>
    Range.create(position.line, position.characterStart, position.line, position.characterEnd);

/**
 * Visits every group and list of a document, outermost first. Descends through container elements
 * only, matching what the inheritor resolver walks, so prepare never offers a hierarchy for a node
 * the subtype search could not reach.
 *
 * @param root the node to walk.
 * @param visit called for each container found.
 */
const forEachContainer = (root: AbstractNode, visit: (container: Container) => void): void => {
    if (isGroupNode(root) || isListNode(root)) visit(root);
    if (isGroupNode(root) || isListNode(root) || isDocumentNode(root)) {
        for (const child of root.elements) forEachContainer(child, visit);
    }
};

/**
 * The name a hierarchy row carries: the container's identifier, or its index in its parent for an
 * anonymous list element, the way the outline names the same nodes. The vanilla virtual-inheritance
 * files derive entirely through anonymous elements (`Missions [ : ~/BaseExploration { … } ]`), so
 * dropping those would leave that hierarchy empty. The parser sets a parent on every element it
 * produced, so the lookup only misses for a node built by hand.
 *
 * @param container the group or list the row stands for.
 * @returns the row's name.
 */
const nameOf = (container: Container): string =>
    container.identifier?.name ?? `[${container.parent?.elements.indexOf(container) ?? -1}]`;

/**
 * The hierarchy item for one container. The selection range is what {@link rangeOf} gives, the
 * identifier for a named container and the declaration itself for an anonymous one, which is the
 * same range the item is resolved back through. The file path is the detail, since a hierarchy of
 * `Part` rows is otherwise fourteen identically named lines.
 *
 * @param container the group or list the item stands for.
 * @param folderPaths the project folders, used to shorten the path shown as the detail.
 * @returns the item.
 */
const itemFor = (container: Container, folderPaths: readonly string[]): TypeHierarchyItem => {
    const fsPath = getStartOfAstNode(container).uri;
    const selectionRange = orderRange(rangeOf(container));
    return {
        name: nameOf(container),
        kind: isListNode(container) ? SymbolKind.Array : SymbolKind.Object,
        uri: filePathToUri(fsPath),
        range: unionRange(orderRange(enclosingRange(container)), selectionRange),
        selectionRange,
        detail: workspaceRelativePath(fsPath, folderPaths),
    };
};

/** The identity of an item, so two resolutions of one declaration are not listed twice. */
const itemKey = (item: TypeHierarchyItem): string =>
    `${normalizeUri(item.uri)}#${item.selectionRange.start.line}:${item.selectionRange.start.character}`;

/**
 * The container the caret names: the one whose own name is under the caret, or the one declaring the
 * inheritance reference under it. Deliberately narrow, since a caret anywhere inside a group would
 * otherwise open a hierarchy for it. `findNodeAtPosition` cannot serve this, as it descends past a
 * container into its members and never answers with the container itself.
 *
 * @param document the parsed document.
 * @param position the caret.
 * @returns the container, or null when the caret names none.
 */
const containerAt = (document: AbstractNodeDocument, position: Position): Container | null => {
    const covers = (range: Range): boolean =>
        atOrBefore(range.start.line, range.start.character, position.line, position.character) &&
        atOrBefore(position.line, position.character, range.end.line, range.end.character);
    const matches: Container[] = [];
    forEachContainer(document, (container) => {
        if (container.identifier && covers(orderRange(posToRange(container.identifier.position)))) {
            matches.push(container);
            return;
        }
        for (const reference of container.inheritance ?? []) {
            if (isValueNode(reference) && covers(orderRange(posToRange(reference.position)))) {
                matches.push(container);
                return;
            }
        }
    });
    // Containers are visited outermost first, so the last match is the innermost covering the caret.
    return matches[matches.length - 1] ?? null;
};

/**
 * The container an item stands for, found again in its own file. The item round-trips through the
 * client, so only its protocol fields can be trusted: the file is parsed from the cache the rest of
 * the server reads and the container whose own range is the item's selection range is the one it
 * named. An exact range match rather than containment, so a nested container inside the declaration
 * is never mistaken for it.
 *
 * @param item the item the client handed back.
 * @param cancellationToken cancels the re-parse.
 * @returns the container, or null when the file or the declaration is gone.
 */
const containerForItem = async (
    item: TypeHierarchyItem,
    cancellationToken: CancellationToken
): Promise<Container | null> => {
    const document = await cachedParseFilePath(uriToFsPath(item.uri), cancellationToken).catch(() => null);
    if (!document) return null;
    const wanted = item.selectionRange;
    const matches: Container[] = [];
    forEachContainer(document, (container) => {
        const range = orderRange(rangeOf(container));
        if (
            range.start.line === wanted.start.line &&
            range.start.character === wanted.start.character &&
            range.end.line === wanted.end.line &&
            range.end.character === wanted.end.character
        ) {
            matches.push(container);
        }
    });
    return matches[0] ?? null;
};

/**
 * A token cancelled by the client or by the elapsed budget, whichever comes first. The inheritor
 * search checks its token once per candidate file and answers with what it confirmed so far rather
 * than throwing, so handing it a budget turns an unbounded scan into a bounded partial answer.
 *
 * @param cancellationToken the client's token.
 * @param budgetMs how long the work may run.
 * @returns the derived token and the disposal that clears the timer and the subscription.
 */
const budgeted = (
    cancellationToken: CancellationToken,
    budgetMs: number
): { token: CancellationToken; dispose: () => void } => {
    const source = new CancellationTokenSource();
    const timer = setTimeout(() => source.cancel(), budgetMs);
    const subscription = cancellationToken.onCancellationRequested(() => source.cancel());
    return {
        token: source.token,
        dispose: (): void => {
            clearTimeout(timer);
            subscription.dispose();
            source.dispose();
        },
    };
};

/**
 * The hierarchy root for the caret (`textDocument/prepareTypeHierarchy`). Both a container's own name
 * and the inheritance reference it writes start the hierarchy at that container, so the base a
 * reference names is one supertype expansion away rather than the root itself. Anything else answers
 * null, which leaves the client's hierarchy action inert instead of opening an empty view.
 *
 * @param document the parsed document under the caret.
 * @param position the caret.
 * @param folderPaths the project folders, for the item detail.
 * @returns the single root item, or null when the caret names no container.
 */
export const prepareTypeHierarchy = (
    document: AbstractNodeDocument,
    position: Position,
    folderPaths: readonly string[]
): TypeHierarchyItem[] | null => {
    const container = containerAt(document, position);
    return container ? [itemFor(container, folderPaths)] : null;
};

/**
 * The bases one container declares: every written inheritance reference resolved to its target, plus
 * the bases a mod's `AddBase` action appends to it. A reference resolving to a whole file or to
 * nothing contributes no item, so a broken base is silently absent rather than a wrong parent.
 *
 * @param item the item whose bases are wanted.
 * @param folderPaths the project folders, for the item detail.
 * @param cancellationToken cancels the re-parse and the reference resolutions.
 * @returns the base items, in the order the container declares them.
 */
export const supertypesOf = async (
    item: TypeHierarchyItem,
    folderPaths: readonly string[],
    cancellationToken: CancellationToken
): Promise<TypeHierarchyItem[]> => {
    const container = await containerForItem(item, cancellationToken);
    if (!container) return [];
    const references: AbstractNode[] = [...(container.inheritance ?? [])];
    const appendedCount = AddBaseIndex.instance.appendedBaseCount(container);
    for (let extra = 0; extra < appendedCount; extra++) {
        const appended = AddBaseIndex.instance.appendedBaseAt(container, extra);
        if (appended) references.push(appended);
    }
    const items: TypeHierarchyItem[] = [];
    const seen = new Set<string>();
    for (const reference of references) {
        if (cancellationToken.isCancellationRequested) break;
        if (!isValueNode(reference)) continue;
        // An appended base is written in the manifest, so each reference is resolved against the file
        // it is written in rather than against the container it was appended to.
        const target = await navigation
            .navigate(
                String(reference.valueType.value),
                reference,
                getStartOfAstNode(reference).uri,
                cancellationToken
            )
            .catch(() => null);
        if (!target || isFile(target as FileTree)) continue;
        const base = target as AbstractNode;
        if (!isGroupNode(base) && !isListNode(base)) continue;
        const next = itemFor(base, folderPaths);
        const key = itemKey(next);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(next);
    }
    return items;
};

/**
 * The direct subtypes of one container: every group or list in the project naming it as a base.
 * Direct only, matching the protocol's one level per expansion, so a deep `Part` chain is walked by
 * expanding rows rather than paid for in one request.
 *
 * Bounded twice over. The scan costs one parse and one resolution per file naming the base, not per
 * subtype, so a budget token stops it and answers with what it has instead of holding the connection,
 * and the result is capped so a generated mod cannot ship a list no view can show. Both bounds sit
 * well above anything the real trees produce, see the constants. There is no protocol field saying a
 * result was cut short, so a truncated expansion simply shows fewer rows.
 *
 * @param item the item whose subtypes are wanted.
 * @param folderPaths the project folders, for the item detail.
 * @param cancellationToken cancels the whole scan.
 * @param progress reports the search while it runs, as find-all-references does.
 * @returns the subtype items, in no particular order.
 */
export const subtypesOf = async (
    item: TypeHierarchyItem,
    folderPaths: readonly string[],
    cancellationToken: CancellationToken,
    progress?: WorkDoneProgressReporter
): Promise<TypeHierarchyItem[]> => {
    const container = await containerForItem(item, cancellationToken);
    if (!container) return [];
    const budget = budgeted(cancellationToken, SUBTYPE_BUDGET_MS);
    progress?.begin(l10n.t('Searching subtypes'), 0, '', false);
    try {
        const inheritors = await findInheritorsOf(container, budget.token);
        const items: TypeHierarchyItem[] = [];
        for (const inheritor of inheritors) {
            items.push(itemFor(inheritor, folderPaths));
            if (items.length >= SUBTYPE_LIMIT) break;
        }
        return items;
    } finally {
        progress?.done();
        budget.dispose();
    }
};
