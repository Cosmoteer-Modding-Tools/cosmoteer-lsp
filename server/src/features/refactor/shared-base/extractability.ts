import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../../core/ast/ast';
import { fieldOf } from '../../../document/schema/schema';
import { registryForGroup, resolveGroupClass } from '../../../document/schema/schema-context';
import { referencedSegments } from '../../diagnostics/validator.ignored-field';
import {
    commentRanges,
    hasMultiLineString,
    normalizeMemberText,
    overlapsComment,
    topLevelMembersOf,
} from './member-record';
import { analyzeReferences, applyRebases } from './reference-safety';
import { MemberRecord } from './plan.types';

/**
 * Fields that identify one particular thing rather than describe a kind of thing. Sharing them
 * through a base would give every deriver the same id, name or icon, which is never what a base file
 * is for. The corpus is unanimous: hand-written base files carry none of these.
 */
const LOCAL_IDENTITY_FIELDS = new Set([
    'id',
    'otherids',
    'namekey',
    'descriptionkey',
    'iconnamekey',
    'shortnamekey',
    'editoricon',
    'editorparentparts',
]);

/** A `^/1`-and-up path, which addresses an inheritance slot that inserting a base would renumber. */
const LATER_INHERITANCE_SLOT = /\^\s*\/\s*[1-9]/;

/**
 * Whether nothing but whitespace shares the member's first and last lines, so removing it takes its
 * lines with it. A member sharing a line with a sibling would leave the separator handling ambiguous
 * for both, and is left alone.
 *
 * @param text the file's full source text.
 * @param start the member's inclusive start offset.
 * @param end the member's exclusive end offset.
 * @returns true when the member occupies its lines alone.
 */
export const ownsItsLines = (text: string, start: number, end: number): boolean => {
    let before = start;
    while (before > 0 && text[before - 1] !== '\n') {
        if (text[before - 1] !== ' ' && text[before - 1] !== '\t' && text[before - 1] !== '\r') return false;
        before--;
    }
    let after = end;
    while (after < text.length && (text[after] === ' ' || text[after] === '\t')) after++;
    if (text[after] === ',' || text[after] === ';') after++;
    while (after < text.length && (text[after] === ' ' || text[after] === '\t' || text[after] === '\r')) after++;
    return after >= text.length || text[after] === '\n';
};

/** The single inheritance reference of a container, or undefined when it has none. */
const soleInheritance = (container: GroupNode): ValueNode | undefined => {
    const list = container.inheritance ?? [];
    if (list.length !== 1) return undefined;
    const reference = list[0];
    return isValueNode(reference) && reference.valueType.type === 'Reference' ? reference : undefined;
};

/** Why a container cannot take part, or undefined when it can. */
type ContainerRefusal =
    | 'unnamed'
    | 'noClass'
    | 'multipleBases'
    | 'unresolvableBase'
    | 'laterInheritanceSlot'
    | 'noSpan';

/** A container accepted for analysis, with the facts the later stages need. */
interface ContainerFacts {
    node: GroupNode;
    className: string;
    inheritance?: ValueNode;
    start: number;
    end: number;
}

/**
 * Judge a container as a whole, before any of its members are looked at.
 *
 * A container is refused when its schema class does not resolve (nothing can be reasoned about its
 * fields), when it lists more than one base (inserting a base at the front would re-prioritize every
 * inherited field, since an earlier base overrides a later one), or when anything inside it
 * addresses an inheritance slot past the first, which inserting a base would renumber.
 *
 * @param container the group to judge.
 * @param text the full source text of the file it lives in.
 * @returns the accepted container's facts, or the reason it was refused.
 */
export const judgeContainer = (container: GroupNode, text: string): ContainerFacts | ContainerRefusal => {
    if (!container.identifier) return 'unnamed';
    const start = container.identifier.position.start;
    const end = container.position.end;
    if (end <= start) return 'noSpan';
    const bases = container.inheritance ?? [];
    if (bases.length > 1) return 'multipleBases';
    const inheritance = bases.length === 1 ? soleInheritance(container) : undefined;
    if (bases.length === 1 && !inheritance) return 'unresolvableBase';
    if (LATER_INHERITANCE_SLOT.test(text.slice(start, end))) return 'laterInheritanceSlot';
    const className = resolveGroupClass(container);
    if (!className) return 'noClass';
    return { node: container, className, inheritance, start, end };
};

/** A member accepted for extraction, with the base-file spelling its references need. */
export interface ExtractableMember extends MemberRecord {
    /** {@link MemberRecord.raw} with every file path re-expressed relative to the base file. */
    rebased: string;
}

/**
 * The members of a container that may move into a base file without changing what the game loads.
 *
 * A member has to clear every one of these: the class declares the field, the field is not a
 * per-thing identity (an id, a name key, an icon), it is not the discriminator the schema resolves
 * the class by (moving `Type` cross-file blinds completion, hover and validation for the whole
 * group), it is not a list (an inherited list is prepended to the deriver's own, which shifts every
 * index a reference addresses), no reference in the file reads its name (the constant idiom stays
 * put), no comment touches it, it owns the lines it sits on, and every reference it carries still
 * names the same target from the base file.
 *
 * @param facts the accepted container, from {@link judgeContainer}.
 * @param document the parsed document the container lives in, for the file's own reference reads.
 * @param text the full source text of that file.
 * @param declaringDir the directory of that file.
 * @param anchorDir the directory every file path is re-expressed relative to, so the same member
 * written in two directories compares equal. The emitted base file re-expresses them once more,
 * against wherever the base file ends up.
 * @param comments the file's comment spans, so a caller judging several containers of one file scans
 * its text once rather than once per container.
 * @returns the extractable members, in document order, compared by their anchor-relative form.
 */
export const extractableMembers = (
    facts: ContainerFacts,
    document: AbstractNodeDocument,
    text: string,
    declaringDir: string,
    anchorDir: string,
    comments: ReadonlyArray<{ start: number; end: number }> = commentRanges(text)
): ExtractableMember[] => {
    const discriminator = (registryForGroup(facts.node)?.typeField ?? 'Type').toLowerCase();
    const readNames = referencedSegments(document);
    const out: ExtractableMember[] = [];
    // The gap before a member carries its banner comment, so it is judged with the member itself.
    // The first member's gap starts just after the container's `{`.
    let previousEnd = facts.node.position.start + 1;
    const seenKeys = new Set<string>();
    for (const member of topLevelMembersOf(facts.node, text)) {
        const gapStart = previousEnd;
        previousEnd = member.end;
        if (member.key === discriminator || member.key === 'type') continue;
        if (LOCAL_IDENTITY_FIELDS.has(member.key)) continue;
        if (holdsList(member.node)) continue;
        const field = fieldOf(facts.className, member.name);
        if (!field || field.dead === true) continue;
        if (isListLike(field.valueType.kind)) continue;
        if (readNames.has(member.key)) continue;
        if (overlapsComment(comments, gapStart, member.end)) continue;
        if (hasMultiLineString(member.raw)) continue;
        if (!ownsItsLines(text, member.start, member.end)) continue;
        // A name declared twice in one container would only have its last copy removed, and the base
        // file would receive one member for two. The duplicate-key check reports that separately.
        if (seenKeys.has(member.key)) continue;
        seenKeys.add(member.key);
        const verdict = analyzeReferences(member.raw, declaringDir, anchorDir);
        if (!verdict.safe) continue;
        const rebased = applyRebases(member.raw, verdict.rebases);
        // Built field by field rather than spread, so the member's node never reaches the record.
        out.push({
            key: member.key,
            name: member.name,
            start: member.start,
            end: member.end,
            raw: member.raw,
            norm: normalizeMemberText(rebased),
            line: member.line,
            indent: member.indent,
            rebased,
        });
    }
    return out;
};

/** The value kinds whose members the game concatenates rather than overrides on inheritance. */
export const isListLike = (kind: string): boolean =>
    kind === 'list' || kind === 'range' || kind === 'interpolated' || kind === 'tuple';

/**
 * Whether a member is, or holds anywhere below it, a list. An inherited list is prepended to the
 * deriver's own rather than replacing it, so moving one shifts every index a reference addresses.
 * Both spellings count: the bare `Resources [ … ]` the game's own files use, and the assigned
 * `Resources = [ … ]`, which wraps the list in an assignment and would otherwise slip through.
 *
 * @param node the member node to test.
 * @returns true when a list is anywhere in the member.
 */
export const holdsList = (node: AbstractNode | null | undefined): boolean => {
    if (!node) return false;
    if (isListNode(node)) return true;
    if (isAssignmentNode(node)) return holdsList(node.right);
    if (isGroupNode(node)) return node.elements.some(holdsList);
    return false;
};
