import { dirname } from 'path';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    isGroupNode,
    isListNode,
} from '../../../core/ast/ast';
import { isTypableTargetPath } from '../../../mod/action-rooting.index';
import { memberPathOf } from '../../../semantics/node-path';
import { memberNameOf, memberValueOf, stepIntoNode } from '../../../semantics/reference-resolver';
import { reindent } from '../shared-base/base-file.emitter';
import { hasMultiLineString, memberSpanOf } from '../shared-base/member-record';
import { analyzeReferences, applyRebases } from '../shared-base/reference-safety';
import { overridesTargetPath } from './overrides-action.emitter';

/**
 * Locates the member a caret sits on in a file of the game's own `Data` tree and works out the one
 * `Overrides` entry that changes it from a mod, or the reason no such entry can be written.
 *
 * The shape is dictated by what the game does, decompiled from `Cosmoteer.Mods.ModOverridesAction`:
 * the action resolves `OverrideIn` and then, for every entry of its `Overrides` map, calls
 * `OTReferenceNode.Replace` on the child of that name. `Replace` swaps the whole child for a
 * reference to the mod's node, so an `Overrides` entry is a total replacement of that child rather
 * than a merge into it. A nested body would therefore delete every sibling under the node it nests
 * through. Exactly one level is emitted, against the deepest group that encloses the caret, which is
 * also the only way a single value can be changed without replacing the group around it.
 */

/** Why no override can be written for what the caret sits on. */
export type OverrideRefusal =
    /** The offset names no member of the file any more. */
    | 'stale'
    /** The caret sits in a `[ ]` body, whose elements the game addresses by position. */
    | 'insideList'
    /** A hop of the path is written as a number, which names a position rather than a name. */
    | 'indexSegment'
    /** The member, or a group around it, carries no name to address it by. */
    | 'unnamedMember'
    /** An earlier member of the same name is what the path would reach. */
    | 'shadowedName'
    /** The member has no value to copy. */
    | 'emptyMember'
    /** The member declares bases of its own, which a copy of its body would drop. */
    | 'inheritedMember'
    /** A quoted text in the member runs across a line break, so it cannot be re-indented. */
    | 'multiLineText'
    /** The member's value reaches outside itself, so it means something else from the mod. */
    | 'scopeRelativeValue'
    /** A path the member carries cannot be re-expressed against the game folder. */
    | 'unrebasablePath'
    /** The path that came out is not one the game addresses by plain member names. */
    | 'untypablePath';

/** The one `Overrides` entry that changes the member the caret sits on. */
export interface OverrideMember {
    /** The name of the member being changed, which is the entry's key. */
    name: string;
    /** The `OverrideIn` path of the group holding it, expressed against the game folder. */
    target: string;
    /** The member names from the file root down to that group, empty for the file itself. */
    targetPath: string[];
    /** The entry's source, one member deep, with every path it carries already re-expressed. */
    body: string;
    /** The byte span the member occupies in the file it was read from. */
    span: { start: number; end: number };
    /**
     * True when the member is a group or a list, so the entry replaces the whole of it. Worth saying,
     * because everything the game reads under that member then comes from the copy rather than from
     * the install, and a later game version changing it there no longer reaches the mod.
     */
    replacesContainer: boolean;
}

/** Either the override to write, or the reason there is none. */
export type OverrideMemberResult = { member: OverrideMember } | { refusal: OverrideRefusal };

/** The indentation the `Overrides` body is written with inside a manifest action entry. */
export const OVERRIDE_BODY_INDENT = '\t\t\t';

/**
 * The offset one past a container's body, treating an unclosed container as running to the end of
 * the file. A container's recorded end is one past its closing brace, and the parser leaves it at
 * zero while the brace is still missing, which reads as an empty span rather than as open ended.
 *
 * @param node the group or list.
 * @returns the exclusive end offset of the body.
 */
const bodyEnd = (node: GroupNode | ListNode): number =>
    node.position.end > node.position.start ? node.position.end : Number.MAX_SAFE_INTEGER;

/**
 * Whether an offset sits inside a container's braces or brackets.
 *
 * @param node the group or list.
 * @param offset the caret's byte offset.
 * @returns true when the offset is within the body.
 */
const insideBody = (node: GroupNode | ListNode, offset: number): boolean =>
    offset >= node.position.start && offset < bodyEnd(node);

/** The member a caret sits on, together with the container that keys it. */
interface Located {
    /** The member node, an assignment, a named container or a bare void field. */
    element: AbstractNode;
    /** The group or document the member is keyed by, which is what an override targets. */
    container: AbstractNodeDocument | GroupNode;
}

/**
 * The innermost named member the offset falls in, descending through groups so a caret on a field
 * deep inside a part finds that field rather than the part.
 *
 * A caret inside a `[ ]` stops the walk. A list element has no name, and the only way to address one
 * is by its position, which a `Remove` or an `Index` insertion of a mod loading earlier renumbers.
 *
 * @param container the group or document to search.
 * @param offset the caret's byte offset.
 * @returns the member and its container, the list refusal, or undefined when nothing holds the offset.
 */
const locateMember = (
    container: AbstractNodeDocument | GroupNode,
    offset: number
): Located | { refusal: OverrideRefusal } | undefined => {
    for (const element of container.elements) {
        const span = memberSpanOf(element);
        if (!span) {
            // A `{ … }` or `[ … ]` written with no name in front of it is a shape the game refuses
            // to load, but the caret can still sit in one. The walk carries on into it so the answer
            // names what is really wrong there rather than reporting nothing at that offset.
            if (isListNode(element) && insideBody(element, offset)) return { refusal: 'insideList' };
            if (isGroupNode(element) && insideBody(element, offset)) {
                const deeper = locateMember(element, offset);
                if (deeper) return deeper;
            }
            continue;
        }
        if (offset < span.start || offset >= span.end) continue;
        const value = memberValueOf(element);
        if (isListNode(value) && insideBody(value, offset)) return { refusal: 'insideList' };
        if (isGroupNode(value) && insideBody(value, offset)) {
            // A caret in the blank space of a group body names the group itself, which is a member
            // of its own container and can be overridden there.
            const deeper = locateMember(value, offset);
            if (deeper) return deeper;
        }
        return { element, container };
    }
    return undefined;
};

/**
 * Whether the container reaches the member under that name, rather than an earlier member of the
 * same name. The game's own lookup is first declaration wins (`OTGroupNode.LocalChildren`), so an
 * entry keyed by a shadowed name would replace somebody else's child.
 *
 * @param container the group or document holding the member.
 * @param name the member's name.
 * @param element the member itself.
 * @returns true when the name reaches this member.
 */
const nameReaches = (container: AbstractNodeDocument | GroupNode, name: string, element: AbstractNode): boolean => {
    for (const candidate of container.elements) {
        if (memberNameOf(candidate) !== name) continue;
        return candidate === element;
    }
    return false;
};

/**
 * Whether the emitted path walks back to the very node it was built from, checked segment by segment
 * with the same stepper a reference path is resolved by.
 *
 * The path is the one thing here that names a node in somebody else's file, so it is proven rather
 * than trusted. A name the container keys twice, or a hop the stepper reads differently from the way
 * the path was written, would otherwise hand the mod an action that changes the wrong node.
 *
 * @param document the parsed file the member lives in.
 * @param segments the member names from the file root down to the member.
 * @param element the member the path was built from.
 * @returns true when the walk lands on that member.
 */
const pathReaches = (document: AbstractNodeDocument, segments: readonly string[], element: AbstractNode): boolean => {
    let current: AbstractNode | null | undefined = document;
    for (const segment of segments) {
        if (!current) return false;
        current = stepIntoNode(current, segment);
    }
    return !!current && current === memberValueOf(element);
};

/**
 * The refusal a member path result carries, translated into this feature's own vocabulary.
 *
 * @param refusal the reason the path builder gave.
 * @returns the matching override refusal.
 */
const pathRefusal = (refusal: string | undefined): OverrideRefusal => {
    switch (refusal) {
        case 'listElement':
            return 'insideList';
        case 'indexName':
            return 'indexSegment';
        case 'shadowedName':
            return 'shadowedName';
        default:
            return 'unnamedMember';
    }
};

/**
 * The `Overrides` entry that changes the member the caret sits on, or the reason there is none.
 *
 * @param document the parsed file the caret is in.
 * @param text that file's source text, which the member is copied from.
 * @param offset the caret's byte offset.
 * @param fsPath the file's on-disk path.
 * @param dataRoot the game's `Data` directory, which the target path and every copied path are
 * expressed against.
 * @returns the entry, or the refusal.
 */
export const overrideMemberAt = (
    document: AbstractNodeDocument,
    text: string,
    offset: number,
    fsPath: string,
    dataRoot: string
): OverrideMemberResult => {
    const located = locateMember(document, offset);
    if (!located) return { refusal: 'stale' };
    if ('refusal' in located) return located;

    const { element, container } = located;
    const name = memberNameOf(element);
    if (name === undefined) return { refusal: 'unnamedMember' };
    // A digit for a name is read as a position by the game, so it carries the same load order hazard
    // a list element does even though no list is involved.
    if (/^\d+$/.test(name)) return { refusal: 'indexSegment' };
    if (!nameReaches(container, name, element)) return { refusal: 'shadowedName' };

    const value = memberValueOf(element);
    if (!value) return { refusal: 'emptyMember' };
    // A member with bases of its own is more than the body written under it, and the entry replaces
    // the whole child, so copying only the body would silently drop everything the bases supply.
    if ((isGroupNode(value) || isListNode(value)) && (value.inheritance?.length ?? 0) > 0) {
        return { refusal: 'inheritedMember' };
    }

    const path = memberPathOf(container);
    if (!path.segments) return { refusal: pathRefusal(path.refusal) };

    const target = overridesTargetPath(dataRoot, fsPath, path.segments);
    // The same gate the action rooting index applies, so nothing is written that the editor itself
    // would then refuse to follow. It comes before the walk below, since a navigation segment such
    // as `..` for a group name is stepped through as navigation rather than as that group's name.
    if (!isTypableTargetPath(target)) return { refusal: 'untypablePath' };
    if (!pathReaches(document, [...path.segments, name], element)) return { refusal: 'shadowedName' };

    const span = memberSpanOf(element);
    if (!span) return { refusal: 'stale' };
    const raw = text.slice(span.start, span.end);
    // Re-indenting a continuation line inside a quoted string would change the value rather than
    // just move it.
    if (hasMultiLineString(raw)) return { refusal: 'multiLineText' };

    const declaringDir = dirname(fsPath).replace(/\\/g, '/');
    const verdict = analyzeReferences(raw, declaringDir, declaringDir, { gameRootDir: dataRoot });
    if (!verdict.safe) {
        // Both refusals come out of the same pass. A scope relative form is the one that cannot be
        // rewritten at all, so it is named first when the source carries one.
        return { refusal: /[~^:]|&[A-Za-z_.]/.test(raw) ? 'scopeRelativeValue' : 'unrebasablePath' };
    }

    let indentStart = span.start;
    while (indentStart > 0 && (text[indentStart - 1] === ' ' || text[indentStart - 1] === '\t')) indentStart--;
    const body = reindent(applyRebases(raw, verdict.rebases), text.slice(indentStart, span.start), OVERRIDE_BODY_INDENT);

    return {
        member: {
            name,
            target,
            targetPath: [...path.segments],
            body,
            span,
            replacesContainer: isGroupNode(value) || isListNode(value),
        },
    };
};

/**
 * The name a generated fragment file gives the group holding the override, which is the last segment
 * of the target path, or the file's own base name when the whole file is the target.
 *
 * @param targetPath the member names from the file root down to the overridden group.
 * @param fsPath the on-disk path of the file being overridden.
 * @returns a name the game reads as a plain member name.
 */
export const overrideGroupName = (targetPath: readonly string[], fsPath: string): string => {
    const last = targetPath[targetPath.length - 1];
    if (last) return last;
    const base = fsPath.replace(/\\/g, '/').split('/').pop() ?? '';
    const stem = base.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]/g, '_');
    return /^[A-Za-z_]/.test(stem) ? stem : `Overrides_${stem}`;
};
