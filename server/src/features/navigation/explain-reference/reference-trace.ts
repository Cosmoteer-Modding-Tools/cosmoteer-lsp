import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    ValueNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../../core/ast/ast';
import { getStartOfAstNode } from '../../../utils/ast.utils';
import { isNumber } from '../../../utils/utils';
import { closestMatch } from '../../../utils/did-you-mean';
import { splitVirtualColon } from '../../../utils/reference.utils';
import { extractSubstrings, filePathToDirectoryPath, stripReferenceWhitespace } from '../navigation-strategy';
import { relativeReferenceScope } from '../full.navigation-strategy';
import { isReferenceValue } from '../definition.service';
import { inheritanceEntriesOf, stepIntoNode } from '../../../semantics/reference-resolver';
import { resolveReference } from '../../../semantics/effective-member';
import { flattenGroup, flattenList } from '../../../semantics/effective-group';
import { resolveVirtualInheritanceTargets } from '../../../semantics/inheritor-resolver';
import {
    hasVirtualInheritanceSegment,
    inheritanceExtendsMissingMember,
    isInheritanceInSameFile,
    isRuntimeRootReference,
} from '../../diagnostics/validator.value';
import { isActionTargetValueNode } from '../../../mod/action';
import { parseModActions } from '../../../mod/action-parser';
import { normalizeTargetPath } from '../../../mod/action-target-resolver';
import { findModRoot } from '../../../mod/mod-root';
import { resolveFromModContextOnly } from '../../../mod/mod-context';
import {
    CosmoteerWorkspaceService,
    FileTree,
    FileWithPath,
    isFile,
} from '../../../workspace/cosmoteer-workspace.service';
import { getParsedFileDocument } from '../../../workspace/parsed-file-cache';

/**
 * Explaining one reference path, hop by hop.
 *
 * Go to definition answers "here" or nothing at all, and the value validator answers "this name is
 * not known" without saying which of six segments was the one that was not known. A path such as
 * `&<./Data/ships/terran/cannon_med/cannon_med.rules>/Part/Components/Turret/FireInterval` crosses a
 * file, a group and four members, and when it fails the only thing an author can do is take it apart
 * by hand. This walks it instead, says where it stopped, and lists what the game would have found at
 * the place it stopped.
 *
 * The verdict is never derived from a private copy of the segment loop. Each prefix of the written
 * path is resolved through the shared navigation, so the last prefix that resolves is by construction
 * the place go to definition lands on, and the trace cannot contradict the rest of the server.
 * {@link stepIntoNode} is then used only to label a hop, which is what it is the authority for.
 *
 * Two shapes are deliberately never judged, because the game decides them when it instantiates a
 * rule and the file alone cannot. A `~` path is rooted at the runtime object the rule is built into,
 * which the editor can only approximate with the declaring file's own root, and a `:` segment selects
 * whichever inheritor is being built. For both, a failed hop is reported as unresolvable rather than
 * as broken, and no member names and no correction are offered, because those names would come from
 * the wrong tree and would talk an author into rewriting a reference that works.
 */

/** What the whole walk amounts to. */
export type ReferenceTraceVerdict =
    | /** Every hop resolved. */ 'resolved'
    | /** Only the mod's own additions supply it, which is how the game reads it inside that mod. */ 'resolved-via-mod'
    | /** A `~` path the file cannot answer, so the game answers it when the rule is instantiated. */ 'runtime-only'
    | /** A `:` path, answered by whichever inheritor is being built. */ 'virtual'
    | /** An inheritance reference whose base is there and simply does not declare the member, which
       *  the game allows. */ 'extends-missing-member'
    | /** A mod action target the action itself says may be missing. */ 'optional-target'
    | /** A segment of a kind the resolver does not model, so nothing is claimed about it. */ 'unmodelled-segment'
    | /** An alias chain that comes back to itself, which the game treats as a load failure. */ 'cycle'
    | /** A hop the game would not find either. */ 'broken'
    | /** The walk was stopped before it finished. */ 'cancelled';

/** What one segment of a path does. */
export type HopKind =
    | /** The `<…>` file token, resolved as one hop the way the game resolves it. */ 'file'
    | /** A named member. */ 'member'
    | /** A list position. */ 'index'
    | /** A base position, the `N` of a `^/N`. */ 'base'
    | /** `^`, the node's own base list. */ 'baseAnchor'
    | /** `..`, the containing node. */ 'parent'
    | /** `~`, the runtime root, approximated by the declaring file's root. */ 'runtimeRoot'
    | /** `:`, the most derived inheritor. */ 'virtual'
    | /** A segment the path grammar allows but the resolver has no rule for. */ 'unmodelled';

/** What a hop landed on. */
export type LandedKind = 'file' | 'document' | 'group' | 'list' | 'value' | 'other';

/** A place in the project, as a file and an optional line. */
export interface TracePlace {
    /** The file's uri or on-disk path, whichever the resolved node carries. */
    readonly uri: string;
    /** The zero-based line, absent when the place is a whole file. */
    readonly line?: number;
}

/** One segment of the path, and what happened at it. */
export interface ReferenceHop {
    /** The segment as written, with the `<…>` file token kept whole. */
    readonly segment: string;
    readonly kind: HopKind;
    /** True when the prefix ending at this segment resolved. */
    readonly resolved: boolean;
    /** False for a segment the walk never got to, because an earlier one failed. */
    readonly reached: boolean;
    /** Where the hop landed, when it resolved. */
    readonly landedOn?: TracePlace;
    readonly landedKind?: LandedKind;
    /** True when the segment is not written where it was looked up but reached through that node's
     *  inheritance chain, which is how most of the game's own parts are written. */
    readonly inherited?: boolean;
    /** The reference the hop's member holds, when the walk had to follow it to continue. */
    readonly aliasText?: string;
    /** True when the member exists but the reference it holds could not be followed. */
    readonly aliasBroken?: boolean;
    /** Where the member itself is declared, which for an alias is not where the hop lands. */
    readonly memberAt?: TracePlace;
    /** For a failed `^/N`, how many bases the container really declares. */
    readonly baseCount?: number;
}

/** One name the game would find at the place the walk stopped. */
export interface AvailableMember {
    readonly name: string;
    /** Where the winning declaration lives. */
    readonly origin: TracePlace;
    /** True when the name comes from a base rather than from the container itself. */
    readonly inherited: boolean;
}

/** What the game would have found at the place the walk stopped. */
export type AvailableAt =
    | /** Named members, the common case. */ {
          readonly kind: 'members';
          readonly names: readonly AvailableMember[];
          /** How many there are in total, which may be more than the listed ones. */
          readonly total: number;
          /** True when a base could not be read, so the list is short of what the game reads. */
          readonly incomplete: boolean;
      }
    | /** A list, which is addressed by position rather than by name. */ {
          readonly kind: 'entries';
          readonly count: number;
          readonly incomplete: boolean;
      }
    | /** The bases of a container, for a failed `^/N`. */ { readonly kind: 'bases'; readonly count: number }
    | /** The member is there, and what fails is the reference it holds. */ {
          readonly kind: 'alias';
          readonly text: string;
          /** Where the member holding that reference is declared. */
          readonly declaredAt?: TracePlace;
      }
    | /** A value, which has no members at all. */ { readonly kind: 'value'; readonly text: string }
    | /** The file lookup itself failed, so the answer is the folder that was searched. */ {
          readonly kind: 'file';
          readonly directory: string;
      }
    | /** Withheld on purpose, because the names would come from the wrong tree. */ {
          readonly kind: 'withheld';
          readonly reason: 'runtime-root' | 'virtual';
      }
    | /** Nothing to say, either because the walk succeeded or because the place is unreadable. */ {
          readonly kind: 'none';
      };

/** The whole explanation of one reference. */
export interface ReferenceTrace {
    /** The reference exactly as written. */
    readonly written: string;
    /** The path actually walked, which differs from the written one for a mod action target. */
    readonly walked: string;
    /** Where the reference itself stands. */
    readonly at: TracePlace;
    readonly verdict: ReferenceTraceVerdict;
    /** One entry per segment, in order. */
    readonly hops: readonly ReferenceHop[];
    /** The index of the first segment that did not resolve, or -1 when the whole path resolved. */
    readonly failedAt: number;
    /** The last place the walk stood, which is where {@link ReferenceTrace.available} was read. */
    readonly lastGood?: TracePlace;
    readonly available: AvailableAt;
    /** The closest available name to the failing segment, when one is close enough to be a typo. */
    readonly suggestion?: string;
    /** The written reference with only the failing segment replaced by the suggestion. */
    readonly correctedValue?: string;
    /** For a `:` path, the concrete inheritors that give the member a value. */
    readonly virtualTargets: readonly TracePlace[];
    /** Where the mod declares what only the mod's own additions supply. */
    readonly modOrigin?: TracePlace;
    /** True when the path was walked from the game Data root as a mod action target. */
    readonly actionTarget: boolean;
}

/** A resolution result, which is an AST node or a whole file. */
type Resolved = AbstractNode | FileWithPath;

/** A container whose members can be enumerated. */
type Container = GroupNode | ListNode | AbstractNodeDocument;

/** A hop while it is still being filled in. */
type MutableHop = { -readonly [K in keyof ReferenceHop]: ReferenceHop[K] };

/** How many member names the trace carries before it only counts the rest. */
const MAX_NAMES = 40;

/** How many alias links the cycle probe follows before it gives up, so a chain it cannot decide
 *  still terminates. */
const MAX_ALIAS_LINKS = 32;

/**
 * Resolves one path through the shared navigation, so every verdict this module reaches is the one
 * go to definition and the value validator reach.
 *
 * @param path the path to resolve.
 * @param startNode the node the relative forms resolve against.
 * @param uri the referring file, which the `<…>` forms resolve against.
 * @param token cancels the resolution.
 * @returns the target, or null when the path does not resolve.
 */
const resolvePath = async (
    path: string,
    startNode: AbstractNode,
    uri: string,
    token: CancellationToken
): Promise<Resolved | null> => {
    const resolved = await resolveReference(path, startNode, uri, token).catch(() => null);
    return (resolved ?? null) as Resolved | null;
};

/**
 * The place a resolution result stands at.
 *
 * @param resolved the resolved node or file.
 * @returns the file and, for a node, its line.
 */
const placeOf = (resolved: Resolved): TracePlace => {
    if (isFile(resolved as unknown as FileTree)) return { uri: (resolved as FileWithPath).path };
    const node = resolved as AbstractNode;
    return { uri: getStartOfAstNode(node).uri, line: node.position?.line };
};

/**
 * What kind of thing a resolution result is, for the report's wording.
 *
 * @param resolved the resolved node or file.
 * @returns the kind.
 */
const landedKindOf = (resolved: Resolved): LandedKind => {
    if (isFile(resolved as unknown as FileTree)) return 'file';
    const node = resolved as AbstractNode;
    if (isDocumentNode(node)) return 'document';
    if (isGroupNode(node)) return 'group';
    if (isListNode(node)) return 'list';
    if (isValueNode(node)) return 'value';
    return 'other';
};

/**
 * The AST node a resolution result continues from. A whole-file target continues through its parsed
 * document, exactly as the segment walk continues through it.
 *
 * @param resolved the resolved node or file.
 * @returns the node, or null when the file could not be parsed.
 */
const asNode = async (resolved: Resolved): Promise<AbstractNode | null> => {
    if (!isFile(resolved as unknown as FileTree)) return resolved as AbstractNode;
    return await getParsedFileDocument(resolved as FileWithPath).catch(() => null);
};

/** True for a node whose members can be enumerated. */
const isContainer = (node: AbstractNode | null): node is Container =>
    !!node && (isGroupNode(node) || isListNode(node) || isDocumentNode(node));

/**
 * The parsed root `cosmoteer.rules`, which is where a super path (`&/…`) starts.
 *
 * @returns the document, or null before the workspace has found the game folder.
 */
const gameRootDocument = async (): Promise<AbstractNodeDocument | null> => {
    const rules = await CosmoteerWorkspaceService.instance.getCosmoteerRules().catch(() => undefined);
    return rules?.content.parsedDocument ?? null;
};

/** The parts of a written path: its sigil, whether it is super rooted, and its segments with the
 *  `<…>` file token kept whole. */
interface PathShape {
    readonly sigil: string;
    readonly superRooted: boolean;
    readonly segments: string[];
    /** True when the first segment is the `<…>` file token. */
    readonly hasFileToken: boolean;
}

/**
 * Splits a path into the hops the resolver walks.
 *
 * The `<…>` file path is one hop even though it contains slashes, which is how `navigateRules` reads
 * it: everything up to the last segment carrying a `>` is the file to open.
 *
 * @param path the whitespace-stripped path.
 * @returns the path's shape.
 */
const shapeOf = (path: string): PathShape => {
    const sigil = path.startsWith('&') ? '&' : '';
    const body = sigil ? path.slice(1) : path;
    const superRooted = body.startsWith('/');
    const parts = extractSubstrings(body);
    const fileIndex = parts.findLastIndex((part) => part.includes('>'));
    const segments = fileIndex >= 0 ? [parts.slice(0, fileIndex + 1).join('/'), ...parts.slice(fileIndex + 1)] : parts;
    return { sigil, superRooted, segments, hasFileToken: fileIndex >= 0 };
};

/**
 * The written path up to and including the nth hop, in the spelling the resolver accepts.
 *
 * @param shape the path's shape.
 * @param count how many hops to keep.
 * @returns the prefix.
 */
const prefixOf = (shape: PathShape, count: number): string =>
    shape.sigil + (shape.superRooted ? '/' : '') + shape.segments.slice(0, count).join('/');

/**
 * What one segment does.
 *
 * A `.` or a `#` standing alone is admitted by the game's own path grammar, but the resolver has no
 * rule for either, so such a segment is named as unmodelled rather than reported as a member that
 * does not exist. Claiming a defect there would be inventing one.
 *
 * @param shape the path's shape.
 * @param index the segment's position.
 * @returns the hop kind.
 */
const hopKindOf = (shape: PathShape, index: number): HopKind => {
    const segment = shape.segments[index];
    if (index === 0 && shape.hasFileToken) return 'file';
    if (segment === '..') return 'parent';
    if (segment === '^') return 'baseAnchor';
    if (segment === '~') return 'runtimeRoot';
    if (segment === ':') return 'virtual';
    if (segment === '.' || segment.startsWith('#')) return 'unmodelled';
    if (isNumber(segment)) return shape.segments[index - 1] === '^' ? 'base' : 'index';
    return 'member';
};

/**
 * The folder a failed `<…>` file token was searched in. The game resolves a `./Data` path against the
 * game folder and every other path against the folder of the file writing it, so the report names
 * whichever of the two was really searched.
 *
 * @param token the file token, angle brackets included.
 * @param uri the referring file.
 * @returns the folder.
 */
const searchedDirectory = (token: string, uri: string): string => {
    const inner = token.replace(/^</, '').replace(/>$/, '');
    if (/^\.\/data(\/|\\|$)/i.test(inner)) {
        return CosmoteerWorkspaceService.instance.dataRootPath ?? filePathToDirectoryPath(uri);
    }
    return filePathToDirectoryPath(uri);
};

/**
 * The member a reference names, without following it any further.
 *
 * The shared navigation dereferences an alias as it goes, which is right for resolving but hides the
 * links an alias chain is made of. This resolves everything but the last segment through the shared
 * navigation and takes the last one with {@link stepIntoNode}, so one link of a chain can be read on
 * its own.
 *
 * @param ref the reference value to read one link of.
 * @param token cancels the prefix resolution.
 * @returns the member node, or null when the link cannot be read.
 */
const rawTargetOf = async (ref: ValueNode, token: CancellationToken): Promise<AbstractNode | null> => {
    const text = stripReferenceWhitespace(String(ref.valueType.value));
    const shape = shapeOf(text);
    if (shape.segments.length === 0) return null;
    // A whole-file reference names no member, so there is no further link to read.
    if (shape.segments.length === 1 && shape.hasFileToken) return null;
    const last = shape.segments[shape.segments.length - 1];
    let container: AbstractNode | null;
    if (shape.segments.length === 1) {
        container = shape.superRooted
            ? await gameRootDocument()
            : shape.sigil
              ? (relativeReferenceScope(text, ref) ?? null)
              : ref;
    } else {
        const resolved = await resolvePath(
            prefixOf(shape, shape.segments.length - 1),
            ref,
            getStartOfAstNode(ref).uri,
            token
        );
        container = resolved ? await asNode(resolved) : null;
    }
    if (!container) return null;
    return stepIntoNode(container, last, shape.segments[shape.segments.length - 2] === '^') ?? null;
};

/**
 * Whether an alias chain comes back to a link it has already been through.
 *
 * The game fails the load on such a chain, and the resolver answers it with nothing at all, which
 * reads exactly like a name that does not exist. Telling the two apart is the reason the report says
 * so at all.
 *
 * @param start the first reference of the chain.
 * @param token cancels the walk.
 * @returns true when the chain closes on itself.
 */
const aliasChainCycles = async (start: ValueNode, token: CancellationToken): Promise<boolean> => {
    const seen = new Set<AbstractNode>([start]);
    let current: ValueNode = start;
    for (let link = 0; link < MAX_ALIAS_LINKS; link++) {
        if (token.isCancellationRequested) return false;
        const next = await rawTargetOf(current, token);
        if (!next || !isReferenceValue(next)) return false;
        if (seen.has(next)) return true;
        seen.add(next);
        current = next;
    }
    return false;
};

/**
 * The names the game would find in a container, with the inheritance chain folded in and whatever a
 * mod merges into it included.
 *
 * @param container the group, list or document the walk stopped at.
 * @param token cancels the cross-file fold.
 * @returns what is available there.
 */
const availableIn = async (container: Container, token: CancellationToken): Promise<AvailableAt> => {
    if (isListNode(container)) {
        const flattened = await flattenList(container, token).catch(() => null);
        return {
            kind: 'entries',
            count: flattened ? flattened.entries.length : container.elements.length,
            incomplete: flattened ? !flattened.complete : true,
        };
    }
    const flattened = await flattenGroup(container, token).catch(() => null);
    if (!flattened) return { kind: 'none' };
    const names = flattened.members.slice(0, MAX_NAMES).map((member) => ({
        name: member.name,
        origin: { uri: member.origin.uri, line: member.origin.node.position?.line },
        inherited: member.origin.inherited,
    }));
    return { kind: 'members', names, total: flattened.members.length, incomplete: !flattened.complete };
};

/**
 * The first hop before the failure that stood in a tree this file only approximates.
 *
 * @param hops the hops walked so far.
 * @param failedAt the index of the failing hop, or -1 when there was none.
 * @returns the reason names must be withheld, or undefined when they may be reported.
 */
const withheldReasonOf = (
    hops: readonly ReferenceHop[],
    failedAt: number
): 'runtime-root' | 'virtual' | undefined => {
    if (failedAt < 0) return undefined;
    for (const hop of hops.slice(0, failedAt)) {
        if (hop.kind === 'runtimeRoot') return 'runtime-root';
        if (hop.kind === 'virtual') return 'virtual';
    }
    return undefined;
};

/**
 * Whether the mod action owning a target says the target is allowed to be missing.
 *
 * `IgnoreIfNotExisting` tells the game to skip the action when the target is not there, and
 * `CreateIfNotExisting` tells it to create the target, so in both cases a target that resolves
 * nowhere is what the author asked for. The mod-action validator makes the same exemption.
 *
 * @param node the action target value.
 * @returns true when the action tolerates a target that is not there.
 */
const actionToleratesMissingTarget = (node: ValueNode): boolean => {
    for (const action of parseModActions(getStartOfAstNode(node))) {
        if (!action.targets.includes(node)) continue;
        return action.flags.IgnoreIfNotExisting === true || action.flags.CreateIfNotExisting === true;
    }
    return false;
};

/**
 * Explains one reference: which of its segments resolved, where the last one that did landed, and
 * what the game would have found there.
 *
 * @param node the reference value to explain.
 * @param token cancels every resolution the walk performs.
 * @returns the trace, or null when the node is not a reference.
 */
export const traceReference = async (node: ValueNode, token: CancellationToken): Promise<ReferenceTrace | null> => {
    if (node.valueType.type !== 'Reference') return null;
    const written = String(node.valueType.value);
    const uri = getStartOfAstNode(node).uri;
    // A mod action target names a place in the merged game tree rather than a path relative to the
    // manifest, and the game resolves it from the Data root. Walking the written form instead would
    // look for the target next to the file that writes it and call a correct target broken.
    const actionTarget = isActionTargetValueNode(node) && written.includes('<');
    const walked = stripReferenceWhitespace(actionTarget ? normalizeTargetPath(written) : written);
    // The value validator resolves an inheritance reference written as `..` from the inheriting
    // group's container, because that is the scope the game reads it in. Start where it starts.
    const startNode: AbstractNode = isInheritanceInSameFile(node) && node.parent?.parent ? node.parent.parent : node;
    const shape = shapeOf(walked);
    const at: TracePlace = { uri, line: node.position?.line };
    const runtimeRooted = isRuntimeRootReference(node);
    const virtualPath = hasVirtualInheritanceSegment(walked);

    // Every prefix, resolved through the shared navigation. Resolution is sequential, so the first
    // prefix that fails is the first hop that fails and everything past it is unreachable.
    const resolvedAt: Array<Resolved | null> = new Array<Resolved | null>(shape.segments.length).fill(null);
    let resolvedCount = 0;
    let cancelled = false;
    for (let count = 1; count <= shape.segments.length; count++) {
        if (token.isCancellationRequested) {
            cancelled = true;
            break;
        }
        const resolved = await resolvePath(prefixOf(shape, count), startNode, uri, token);
        if (token.isCancellationRequested) {
            cancelled = true;
            break;
        }
        if (!resolved) break;
        resolvedAt[count - 1] = resolved;
        resolvedCount = count;
    }
    const fullyResolved = shape.segments.length > 0 && resolvedCount === shape.segments.length;
    // A path with no segments at all (`&`, `&/`) has no hop to fail at, so there is nothing to
    // explain and nothing to index into.
    const failedAt = fullyResolved || cancelled || shape.segments.length === 0 ? -1 : resolvedCount;

    // Where the first hop is looked up. A relative `&Name` starts one scope up from the bearer, a
    // super path starts at the game's own cosmoteer.rules, and a `<…>` path starts at a folder rather
    // than at a node.
    const origin: Resolved | null = shape.hasFileToken
        ? null
        : shape.superRooted
          ? await gameRootDocument()
          : shape.sigil
            ? (relativeReferenceScope(walked, startNode) ?? null)
            : startNode;

    const hops: ReferenceHop[] = [];
    for (let index = 0; index < shape.segments.length; index++) {
        const segment = shape.segments[index];
        const after = resolvedAt[index];
        const hop: MutableHop = {
            segment,
            kind: hopKindOf(shape, index),
            resolved: !!after,
            reached: index <= resolvedCount,
        };
        if (after) {
            hop.landedOn = placeOf(after);
            hop.landedKind = landedKindOf(after);
        }
        if (hop.reached && hop.kind !== 'file') {
            const before = index === 0 ? origin : resolvedAt[index - 1];
            const beforeNode = before ? await asNode(before) : null;
            if (beforeNode) {
                const raw = stepIntoNode(beforeNode, segment, shape.segments[index - 1] === '^');
                if (after && !raw) hop.inherited = true;
                if (raw) hop.memberAt = placeOf(raw);
                if (raw && isReferenceValue(raw)) hop.aliasText = String(raw.valueType.value);
                if (!after && raw) hop.aliasBroken = true;
                if (!after && !raw && hop.kind === 'base' && (isGroupNode(beforeNode) || isListNode(beforeNode))) {
                    hop.baseCount = inheritanceEntriesOf(beforeNode).length;
                }
            }
        }
        hops.push(hop);
    }

    // The mod's own additions are a second resolver the validator and go to definition both consult,
    // so a global a mod inserts (`&/SW_SOUNDS/…`) resolves there and nowhere else. Without this the
    // trace would call a reference the game reads perfectly well broken, and would then go on to
    // offer a correction for it.
    let modOrigin: TracePlace | undefined;
    if (!fullyResolved && !cancelled && !runtimeRooted && !virtualPath && findModRoot(uri)) {
        const modResolved = await resolveFromModContextOnly(walked, startNode, token).catch(() => null);
        if (modResolved) modOrigin = placeOf(modResolved as Resolved);
    }

    // A group may inherit a base that does not declare the member it names (`Toggles : ^/0/Toggles`,
    // written all over the game's own files). The game reads that as the base contributing nothing,
    // not as an error, so the walk stopping on the last segment is expected there.
    const extendsMissingMember =
        !fullyResolved &&
        !cancelled &&
        !modOrigin &&
        !!node.parent &&
        (isGroupNode(node.parent) || isListNode(node.parent)) &&
        !!node.parent.inheritance?.includes(node) &&
        (await inheritanceExtendsMissingMember(node, startNode, uri, token).catch(() => false));

    // A mod action may say outright that its target need not exist, and then the game skips the
    // action or creates the target rather than failing.
    const optionalTarget =
        actionTarget && !fullyResolved && !cancelled && !modOrigin && actionToleratesMissingTarget(node);

    const lastGood = resolvedCount > 0 ? resolvedAt[resolvedCount - 1] : origin;
    // A hop past a `~` or a `:` stands in a tree this file only approximates, so nothing about what
    // is available there may be reported. Naming members of the wrong tree, or offering a correction
    // out of them, is how an author is talked into rewriting a reference that works in the game.
    const withheld = withheldReasonOf(hops, failedAt);

    let available: AvailableAt = { kind: 'none' };
    // Nothing is listed for a reference that resolves after all. The mod supplies it, and naming the
    // members of the file the vanilla walk stopped in would read as a defect where there is none.
    if (failedAt >= 0 && !modOrigin) {
        const failing = hops[failedAt];
        if (withheld) {
            available = { kind: 'withheld', reason: withheld };
        } else if (failing.aliasBroken) {
            // The member is there. Listing the names around it, or offering the nearest one as a
            // correction, would point at the wrong thing entirely: what fails is one step further on.
            available = { kind: 'alias', text: failing.aliasText ?? '', declaredAt: failing.memberAt };
        } else if (failing.kind === 'file') {
            available = { kind: 'file', directory: searchedDirectory(failing.segment, uri) };
        } else if (failing.baseCount !== undefined) {
            available = { kind: 'bases', count: failing.baseCount };
        } else {
            const stopped = lastGood ? await asNode(lastGood) : null;
            if (isContainer(stopped)) available = await availableIn(stopped, token);
            else if (stopped && isValueNode(stopped)) available = { kind: 'value', text: String(stopped.valueType.value) };
        }
    }

    // Only a plain name can be a typo of another plain name. An index, an operator or a file token
    // has no near miss worth offering.
    let suggestion: string | undefined;
    let correctedValue: string | undefined;
    if (available.kind === 'members' && failedAt >= 0 && !extendsMissingMember && !optionalTarget) {
        const failing = hops[failedAt].segment;
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(failing)) {
            suggestion = closestMatch(failing, available.names.map((member) => member.name)) ?? undefined;
            const cut = suggestion ? written.lastIndexOf(failing) : -1;
            if (suggestion && cut >= 0) {
                correctedValue = written.slice(0, cut) + suggestion + written.slice(cut + failing.length);
            }
        }
    }

    // A `:` path also points at every concrete inheritor, which is what the game picks between when
    // it builds one. Those are worth naming whether or not the base's own declaration resolved.
    let virtualTargets: TracePlace[] = [];
    if (virtualPath && !cancelled) {
        const split = splitVirtualColon(walked);
        if (split) {
            const base = split.basePath.replace(/^&$/, '')
                ? await resolvePath(split.basePath, node, uri, token)
                : (node.parent ?? null);
            if (base && !isFile(base as unknown as FileTree)) {
                const targets = await resolveVirtualInheritanceTargets(
                    base as AbstractNode,
                    split.memberPath,
                    token
                ).catch(() => []);
                virtualTargets = targets.map((target) => placeOf(target));
            }
        }
    }

    // An alias the walk could not follow is either a chain that closes on itself, which the game
    // treats as a load failure, or a plain dead end. They read the same from outside.
    let cycles = false;
    if (failedAt >= 0 && hops[failedAt].aliasBroken && !modOrigin && !cancelled) {
        const before = failedAt === 0 ? origin : resolvedAt[failedAt - 1];
        const beforeNode = before ? await asNode(before) : null;
        const raw = beforeNode
            ? stepIntoNode(beforeNode, hops[failedAt].segment, shape.segments[failedAt - 1] === '^')
            : null;
        if (raw && isReferenceValue(raw)) cycles = await aliasChainCycles(raw, token);
    }

    // The order is the order the reasons override one another: anything the game really resolves
    // comes first, then every shape the game decides for itself, and only what is left over is a
    // defect.
    let verdict: ReferenceTraceVerdict = 'broken';
    if (fullyResolved) verdict = 'resolved';
    else if (cancelled) verdict = 'cancelled';
    else if (modOrigin) verdict = 'resolved-via-mod';
    else if (extendsMissingMember) verdict = 'extends-missing-member';
    else if (optionalTarget) verdict = 'optional-target';
    else if (virtualPath) verdict = 'virtual';
    else if (runtimeRooted) verdict = 'runtime-only';
    else if (failedAt >= 0 && hops[failedAt].kind === 'unmodelled') verdict = 'unmodelled-segment';
    else if (cycles) verdict = 'cycle';

    return {
        written,
        walked,
        at,
        verdict,
        hops,
        failedAt,
        lastGood: lastGood ? placeOf(lastGood) : undefined,
        available,
        suggestion,
        correctedValue,
        virtualTargets,
        modOrigin,
        actionTarget,
    };
};
