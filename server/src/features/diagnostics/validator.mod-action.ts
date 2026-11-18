import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    ValueNode,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isGroupNode,
    isListNode,
    isMathExpressionNode,
    isValueNode,
} from '../../core/ast/ast';
import { basename } from 'path';
import { groupClassCandidates, listElementType, memberTypeIn } from '../../document/schema/schema-context';
import { documentRootClass } from '../../document/schema/document-root';
import { fieldOf, valueTypeLabel } from '../../document/schema/schema';
import {
    Action,
    ACTION_VERBS,
    ActionSource,
    isActionTargetValueNode,
    SourceShape,
    TargetShape,
    VERB_SCHEMA,
} from '../../mod/action';
import { normalizeTargetPath, resolveActionTargetMember } from '../../mod/action-target-resolver';
import { resolveWithModContext } from '../../mod/mod-context';
import { isStringsFile } from '../../mod/strings-folder';
import { flattenGroup } from '../../semantics/effective-group';
import { navigate } from '../../semantics/navigate-reference';
import { CosmoteerWorkspaceService, FileTree, FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { foldPathCase } from '../../workspace/fs-cache';
import { getParsedFileDocument } from '../../workspace/parsed-file-cache';
import { documentsMatching, uriToFsPath } from '../../workspace/workspace-files';
import {
    assignmentNameOf,
    getStartOfAstNode,
    memberValueNamed,
    namedMembersOf,
    parseFilePath,
} from '../../utils/ast.utils';
import { referenceNodesOf } from '../navigation/reference-nodes';
import { ValidationError } from './validator';
import { formLabel, FormSlot, landingFormOf, unreadableForm, valueFormOf } from './validator.schema';
import * as l10n from '@vscode/l10n';

/**
 * The rule id of the whole-group finding below. Its own rather than `mod-action`, since the game
 * loads such an action without complaint and a report has to be able to switch the warning off
 * apart from the errors.
 */
export const OVERRIDES_REPLACES_GROUP_RULE = 'overrides-replaces-group';

/** How many dropped members the finding names before it says how many more there are. */
const DROPPED_NAMES_SHOWN = 6;

/** A resolved action target is either a whole `.rules` file or a node inside one. */
type ResolvedTarget = AbstractNode | FileWithPath;

/** Whether a resolved target is a whole `.rules` file (rather than a node inside one). */
const targetsWholeFile = (resolved: ResolvedTarget): boolean => isFile(resolved as unknown as FileTree);

/** The on-disk path of the file a resolved target lives in (the file itself, or the node's document). */
const targetFilePath = (resolved: ResolvedTarget): string =>
    targetsWholeFile(resolved) ? (resolved as FileWithPath).path : getStartOfAstNode(resolved as AbstractNode).uri;

/** A `&` reference value. Its real shape is whatever it resolves to, so it satisfies any container constraint. */
const isReferenceValue = (node: AbstractNode): boolean => isValueNode(node) && node.valueType.type === 'Reference';

/**
 * Whether a source value node satisfies the AST shape the verb requires (see {@link SourceShape}).
 * A `&` reference is always accepted: it may resolve to the required group/list, and we don't
 * resolve it here. Only plain inline values (strings, numbers, …) are rejected where a container
 * is required.
 */
const sourceMatchesShape = (source: ActionSource, shape: SourceShape): boolean => {
    if (isReferenceValue(source)) return true;
    switch (shape) {
        case 'list':
            return isListNode(source);
        case 'group':
            return isGroupNode(source);
        case 'composite':
            return isGroupNode(source) || isListNode(source);
    }
};

/** Human-readable description of an allowed source shape, for the diagnostic detail. */
const shapeDescription = (shape: SourceShape): string => {
    switch (shape) {
        case 'list':
            return l10n.t('a list "[ ]"');
        case 'group':
            return l10n.t('a group "{ }"');
        case 'composite':
            return l10n.t('a reference "&", a group "{ }" or a list "[ ]" (not a plain value)');
    }
};

/**
 * Whether a resolved target node satisfies the AST shape the verb requires (see {@link TargetShape}).
 * A `&` reference is accepted (its real shape is whatever it resolves to, not resolved here);
 * a plain value node is rejected where a list/group is required.
 */
const targetMatchesShape = (node: AbstractNode, shape: TargetShape): boolean => {
    if (isReferenceValue(node)) return true;
    switch (shape) {
        case 'list':
            return isListNode(node);
        case 'container':
            // A file is one of the three shapes the game names here, and a target whose value is a
            // whole-file reference (`EditorGroups = &<editor_groups.rules>`) resolves to one.
            return isGroupNode(node) || isListNode(node) || isDocumentNode(node);
        case 'group':
            // The game throws while loading an `Overrides` whose target is not a group or a file,
            // so a list or a plain value there costs the user the whole mod rather than one action.
            // A document counts: `OTFile` derives from `OTGroupNode`, and a whole-file reference
            // such as `BASE_AUDIO = &<sounds/base_audio.rules>` resolves to one.
            return isGroupNode(node) || isDocumentNode(node);
    }
};

/** Human-readable description of an allowed target shape, for the diagnostic detail. */
const targetShapeDescription = (shape: TargetShape): string => {
    switch (shape) {
        case 'list':
            return l10n.t('a list "[ ]"');
        case 'container':
            return l10n.t('a group "{ }" or a list "[ ]"');
        case 'group':
            return l10n.t('a group "{ }"');
    }
};

/**
 * Whether a target list holds lists as its entries, read off its own elements first and its schema
 * type when it is empty. Undefined when neither says.
 *
 * @param target the resolved target list.
 * @returns true for a list of lists, false for a list of anything else, undefined when unknown.
 */
const targetHoldsLists = (target: ListNode): boolean | undefined => {
    const entries = target.elements.filter(
        (element) => isGroupNode(element) || isListNode(element) || isValueNode(element)
    );
    if (entries.length > 0) return entries.every((element) => isListNode(element));
    const element = listElementType(target);
    return element ? element.kind === 'list' : undefined;
};

/**
 * The entries an `Add` or `AddMany` action appends, as written: `ToAdd`'s own value, or each element
 * of a `ManyToAdd [ … ]` list. An assigned `ManyToAdd = &<…>` names the array itself, so its value is
 * not one entry and is left out.
 *
 * @param action the parsed action.
 * @returns the reference values that each become one entry of the target.
 */
const appendedReferences = (action: Action): ValueNode[] => {
    const source = action.sources[0];
    if (!source) return [];
    if (action.type === 'Add') return isReferenceValue(source) ? [source as ValueNode] : [];
    if (action.type === 'AddMany' && isListNode(source)) {
        return source.elements.filter((element): element is ValueNode => isReferenceValue(element));
    }
    return [];
};

/**
 * Findings for entries that are whole lists: the game reads `ToAdd` and each element of `ManyToAdd`
 * as one entry and appends it as it is (`ModAddManyAction.ApplyAction`), so a reference to a list
 * of entries lands as a single list-shaped entry the target's reader cannot read. The written idiom
 * for a list of entries is `ManyToAdd = &<file>/Member`, which makes the list the array itself. A
 * one-element `ManyToAdd [ … ]` is offered that rewrite.
 *
 * @param action the parsed action, an `Add` or an `AddMany`.
 * @param target the resolved target list.
 * @param cancellationToken cancels the source navigation.
 * @returns one finding per list-valued entry.
 */
const listAppendedAsEntry = async (
    action: Action,
    target: ListNode,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const references = appendedReferences(action);
    if (references.length === 0 || targetHoldsLists(target) !== false) return [];
    const errors: ValidationError[] = [];
    for (const reference of references) {
        // A source is an ordinary reference, resolved from the manifest as written, not a target path.
        const raw = String(reference.valueType.value);
        const landing = await resolveWithModContext(raw, reference, cancellationToken).catch(() => null);
        if (!landing || targetsWholeFile(landing) || !isListNode(landing as AbstractNode)) continue;
        const source = action.sources[0];
        const rewrite =
            action.type === 'AddMany' && isListNode(source) && source.elements.length === 1 && source.position
                ? {
                      title: l10n.t('Assign the list: ManyToAdd = {0}', raw),
                      edits: [{ start: source.position.start, end: source.position.end, newText: `= ${raw}` }],
                  }
                : undefined;
        errors.push({
            message: l10n.t('Mod action adds a whole list as one entry'),
            node: reference,
            additionalInfo:
                action.type === 'AddMany'
                    ? l10n.t(
                          'This reference names a list of entries, but each element of "ManyToAdd [ ]" is appended as one entry, so the game appends the list itself where an entry belongs and cannot read it. Assign the list instead, "ManyToAdd = {0}", so its entries are what is added.',
                          raw
                      )
                    : l10n.t(
                          'This reference names a list of entries, but "ToAdd" is appended as one entry, so the game appends the list itself where an entry belongs and cannot read it. Use an AddMany with "ManyToAdd = {0}" to add its entries.',
                          raw
                      ),
            ...(rewrite ? { data: { rewrite } } : {}),
        });
    }
    return errors;
};

/**
 * The group an `Overrides` target resolves to, with the game's own reading of a whole file: `OTFile`
 * derives from `OTGroupNode`, so a file target is a group whose members are the file's top-level
 * members.
 *
 * @param resolved the resolved target.
 * @param cancellationToken cancels the file read.
 * @returns the group or document, or null when the target is neither.
 */
const overridesTargetGroup = async (
    resolved: ResolvedTarget,
    cancellationToken: CancellationToken
): Promise<GroupNode | AbstractNodeDocument | null> => {
    if (targetsWholeFile(resolved)) {
        return parseFilePath((resolved as FileWithPath).path, cancellationToken).catch(() => null);
    }
    const node = resolved as AbstractNode;
    return isGroupNode(node) || isDocumentNode(node) ? node : null;
};

/**
 * One spelling of a file for identity, whichever form a uri or a path arrives in.
 *
 * @param uriOrPath the file's uri or path.
 * @returns the folded path.
 */
const fileKey = (uriOrPath: string): string => foldPathCase(uriToFsPath(uriOrPath).replace(/\\/g, '/'));

/**
 * The group a container holds under a name, read the way the game reads it, through the
 * container's bases and what other actions merged in, but before the manifest being checked has
 * its say. The injection index folds this manifest's own `Overrides` into the target too, and read
 * after it the target would already hold the body's group and nothing would look dropped. The
 * declaration that injection shadows is the one the game replaces.
 *
 * @param container the group or document.
 * @param name the member name.
 * @param manifest the folded path of the manifest being checked.
 * @param cancellationToken cancels the flattening.
 * @returns the group, or null when the container holds no group of that name.
 */
const groupMemberOf = async (
    container: GroupNode | AbstractNodeDocument,
    name: string,
    manifest: string,
    cancellationToken: CancellationToken
): Promise<GroupNode | null> => {
    const flattened = await flattenGroup(container, cancellationToken).catch(() => null);
    const lower = name.toLowerCase();
    const member = flattened?.members.find((entry) => entry.name.toLowerCase() === lower);
    if (!member) return null;
    if (member.origin.injected && fileKey(member.origin.uri) === manifest) {
        const shadowed = member.shadows.find((origin) => isGroupNode(origin.node));
        return shadowed ? (shadowed.node as GroupNode) : null;
    }
    return member.value && isGroupNode(member.value) ? member.value : null;
};

/**
 * A group written into an `Overrides` body that stands alone, with no base of its own. Such a group
 * is the whole of what the game puts in the target's place, so what it leaves out is gone.
 *
 * @param node a member of the body.
 * @returns true for a bare inline group.
 */
const isBareGroup = (node: AbstractNode): node is GroupNode => isGroupNode(node) && !(node.inheritance?.length ?? 0);

/**
 * The names a group declares itself, folded, which is what survives when it replaces another.
 *
 * @param group the group.
 * @returns its member names in lower case.
 */
const declaredNames = (group: GroupNode): Set<string> =>
    new Set(namedMembersOf(group).map(([name]) => name.toLowerCase()));

/**
 * The leading whitespace of the line an offset sits on.
 *
 * @param text the file's text.
 * @param offset an offset on the line.
 * @returns the indentation.
 */
const indentAt = (text: string, offset: number): string => {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? '';
};

/**
 * A target path as written, less the trailing slash some manifests end it with, so a segment can
 * be appended without doubling it.
 *
 * @param target the target value node.
 * @returns the path.
 */
const writtenTargetPath = (target: ValueNode): string => String(target.valueType.value).replace(/\/+$/, '');

/**
 * The edit that moves an `Overrides` one or more levels down: the target path gains the segments
 * and the body becomes the innermost group, moved up to the body's own indentation. The text is
 * the innermost group's as written, comments and all, so nothing the author wrote is lost.
 *
 * @param text the manifest's text.
 * @param target the target value node.
 * @param body the `Overrides` group.
 * @param inner the group the body becomes.
 * @param segments the member names the target path gains.
 * @returns the rewrite, with the title the code action shows.
 */
const deeperOverridesRewrite = (
    text: string,
    target: ValueNode,
    body: GroupNode,
    inner: GroupNode,
    segments: readonly string[]
): { title: string; edits: Array<{ start: number; end: number; newText: string }> } => {
    const path = `${writtenTargetPath(target)}/${segments.join('/')}`;
    const bodyIndent = indentAt(text, body.position.start);
    const innerIndent = indentAt(text, inner.position.start);
    const innerText = text
        .slice(inner.position.start, inner.position.end)
        .split('\n')
        .map((line, index) =>
            index > 0 && line.startsWith(innerIndent) ? bodyIndent + line.slice(innerIndent.length) : line
        )
        .join('\n');
    return {
        title: l10n.t('Target {0} and override only its members', path),
        edits: [
            {
                start: target.position.start,
                end: target.position.end,
                newText: target.quoted ? `"${path}"` : path,
            },
            { start: body.position.start, end: body.position.end, newText: innerText },
        ],
    };
};

/**
 * Findings for the groups an `Overrides` body puts in the target's place whole. The game does not
 * merge the body into the target: `ModOverridesAction.ApplyAction` walks the body's members one
 * level deep and `OTReferenceNode.Replace` swaps each named child of the target for the body's, so
 * `Overrides { Components { Damage = 6 } }` leaves the part with one component. Every other member
 * the target's group had, its own or inherited, is gone when the mod loads, and nothing says so at
 * load time. The fix targets the deepest group the body descends into alone and writes the members
 * beside it, which is the form the game's own example mod uses.
 *
 * A body written as a reference is left alone: its members live in another file, and a rewrite
 * here could not reach them. A body group with a base of its own is left alone too, since the base
 * may carry the members the group does not write.
 *
 * @param action the parsed `Overrides` action.
 * @param resolved the resolved target.
 * @param text the manifest's text, absent when no rewrite can be offered.
 * @param cancellationToken cancels the flattening.
 * @returns one finding per body group that drops members of the target.
 */
const overridesReplacingGroups = async (
    action: Action,
    resolved: ResolvedTarget,
    text: string | undefined,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const body = action.sources[0];
    const target = action.targets[0];
    if (!body || !target || !isBareGroup(body)) return [];
    const container = await overridesTargetGroup(resolved, cancellationToken);
    if (!container) return [];
    const manifest = fileKey(getStartOfAstNode(action.group).uri);
    const bodyMembers = namedMembersOf(body);
    const errors: ValidationError[] = [];
    for (const [name, node] of bodyMembers) {
        if (cancellationToken.isCancellationRequested) return errors;
        if (!isBareGroup(node)) continue;
        const replaced = await groupMemberOf(container, name, manifest, cancellationToken);
        if (!replaced) continue;
        const kept = declaredNames(node);
        const flattened = await flattenGroup(replaced, cancellationToken).catch(() => null);
        const dropped = (flattened?.members ?? [])
            .map((member) => member.name)
            .filter((member) => !kept.has(member.toLowerCase()));
        if (dropped.length === 0) continue;

        // The fix follows the body down while it holds one bare group that the target holds a group
        // for too, so a body three levels deep lands its edit in one step.
        let rewrite: ReturnType<typeof deeperOverridesRewrite> | undefined;
        if (text !== undefined && bodyMembers.length === 1) {
            const segments = [name];
            let inner = node;
            let innerTarget = replaced;
            for (;;) {
                const members = namedMembersOf(inner);
                if (members.length !== 1 || !isBareGroup(members[0][1])) break;
                const next = await groupMemberOf(innerTarget, members[0][0], manifest, cancellationToken);
                if (!next) break;
                segments.push(members[0][0]);
                inner = members[0][1];
                innerTarget = next;
            }
            rewrite = deeperOverridesRewrite(text, target, body, inner, segments);
        }

        const shown = dropped.slice(0, DROPPED_NAMES_SHOWN).join(', ');
        const rest = dropped.length - DROPPED_NAMES_SHOWN;
        errors.push({
            message: l10n.t('Overrides replaces the whole "{0}" group', name),
            node: node.identifier ?? node,
            code: OVERRIDES_REPLACES_GROUP_RULE,
            // Copying a vanilla group into an `Overrides` and editing it is a common idiom, and a
            // member left out of the copy may well be meant to go, so this informs rather than warns.
            severity: 'information',
            additionalInfo:
                rest > 0
                    ? l10n.t(
                          'The game does not merge an "Overrides" body into its target. It puts this "{0}" in the place of the target\'s whole "{0}" group, so the members it does not write are gone when the mod loads: {1} and {2} more. To change members alone, target "{3}" and write only those.',
                          name,
                          shown,
                          rest,
                          `${writtenTargetPath(target)}/${name}`
                      )
                    : l10n.t(
                          'The game does not merge an "Overrides" body into its target. It puts this "{0}" in the place of the target\'s whole "{0}" group, so the members it does not write are gone when the mod loads: {1}. To change members alone, target "{2}" and write only those.',
                          name,
                          shown,
                          `${writtenTargetPath(target)}/${name}`
                      ),
            ...(rewrite ? { data: { rewrite } } : {}),
        });
    }
    return errors;
};

/** One member of the game tree an action puts something else in place of, or takes away. */
interface MemberChange {
    /** The member name as the action writes it. */
    name: string;
    /** The group or file the member is written in. */
    container: GroupNode | AbstractNodeDocument;
    /** The member's value as the target file writes it. */
    old: AbstractNode;
    /** What the game reads there once the mod loads, absent for a removal. */
    incoming?: AbstractNode;
    /** Where the finding is reported. */
    reportAt: AbstractNode;
}

/**
 * The member an action's target path names, split into the container that writes it and the
 * member's own value there.
 *
 * @param target the written target value.
 * @param cancellationToken cancels the resolution.
 * @returns the container and value, or null when the container does not write the member itself.
 */
const targetMember = async (
    target: ValueNode,
    cancellationToken: CancellationToken
): Promise<{ container: GroupNode | AbstractNodeDocument; old: AbstractNode; name: string } | null> => {
    const split = await resolveActionTargetMember(target, cancellationToken).catch(() => null);
    if (!split) return null;
    const container = await overridesTargetGroup(split.container, cancellationToken);
    const old = container && memberValueNamed(container, split.member);
    return container && old ? { container, old, name: split.member } : null;
};

/**
 * The members of the game tree one action rewrites: each member an `Overrides` body writes over one
 * the target writes itself, the member a `Replace` names, and every member a `Remove` or `RemoveMany`
 * takes out. A member the target only inherits is left out, since the action then never touches the
 * declaration the target's readers land on.
 *
 * @param action the parsed action.
 * @param cancellationToken cancels the resolution.
 * @returns the changed members.
 */
const memberChangesOf = async (action: Action, cancellationToken: CancellationToken): Promise<MemberChange[]> => {
    const changes: MemberChange[] = [];
    if (action.type === 'Overrides') {
        const body = action.sources[0];
        const target = action.targets[0];
        if (!body || !target || !isGroupNode(body)) return [];
        const resolved = await resolveWithModContext(
            normalizeTargetPath(String(target.valueType.value)),
            target,
            cancellationToken
        ).catch(() => null);
        const container = resolved && (await overridesTargetGroup(resolved, cancellationToken));
        if (!container) return [];
        for (const [name, incoming] of namedMembersOf(body)) {
            const old = memberValueNamed(container, name);
            if (!old) continue;
            // `Name = { … }` is underlined at its name rather than across the whole group.
            const assignment = body.elements.find((element) => isAssignmentNode(element) && element.right === incoming);
            const reportAt = assignment && isAssignmentNode(assignment) ? assignment.left : incoming;
            changes.push({ name, container, old, incoming, reportAt });
        }
    } else if (action.type === 'Replace' || action.type === 'Remove' || action.type === 'RemoveMany') {
        for (const target of action.targets) {
            const member = await targetMember(target, cancellationToken);
            if (!member) continue;
            const incoming = action.type === 'Replace' ? action.sources[0] : undefined;
            changes.push({ ...member, incoming, reportAt: action.type === 'Replace' ? (incoming ?? target) : target });
        }
    }
    return changes;
};

/** Where a node is written, which identifies it across separate parses of the same file. */
interface Span {
    file: string;
    start: number;
    end: number;
}

/**
 * The span a node is written at, or undefined for a node the parser gives no position.
 *
 * @param node the node.
 * @returns its file and offsets.
 */
const spanOf = (node: AbstractNode | undefined): Span | undefined =>
    node?.position && {
        file: fileKey(getStartOfAstNode(node).uri),
        start: node.position.start,
        end: node.position.end,
    };

/**
 * Whether a node starts inside a span, the span's own node included.
 *
 * @param node the node.
 * @param span the span.
 * @returns true when the node is written within the span.
 */
const startsIn = (node: AbstractNode | null | undefined, span: Span | undefined): boolean => {
    const own = spanOf(node ?? undefined);
    return !!own && !!span && own.file === span.file && own.start >= span.start && own.start < span.end;
};

/**
 * Whether a node is the very node a span was taken from.
 *
 * @param node the node.
 * @param span the span.
 * @returns true when both start at the same place in the same file.
 */
const startsAt = (node: AbstractNode | null | undefined, span: Span | undefined): boolean => {
    const own = spanOf(node ?? undefined);
    return !!own && !!span && own.file === span.file && own.start === span.start;
};

/**
 * Whether the game reads a reference's target as a number: parenthesized, inside math or inside a
 * function call always (`ExpressionEvaluator` swaps each `(&path)` for its target's double), and as
 * a lone value where the slot it is assigned to holds a plain number. A slot that also takes the
 * group form (a `ModifiableValue`) copies a group across intact, so it is not a number reader. The
 * parser parents a value to the group its assignment sits in, so the assignment is looked up there.
 *
 * @param reference the reference value.
 * @returns true when the target has to be a number.
 */
const readsAsNumber = (reference: ValueNode): boolean => {
    if (reference.parenthesized) return true;
    const owner = reference.parent;
    if (!owner || !(isGroupNode(owner) || isDocumentNode(owner))) return false;
    const name = assignmentNameOf(reference);
    if (name === undefined) {
        return owner.elements.some(
            (element) =>
                isAssignmentNode(element) &&
                (isMathExpressionNode(element.right) || isFunctionCallNode(element.right)) &&
                [...referenceNodesOf(element.right)].includes(reference)
        );
    }
    const type = memberTypeIn(owner, name);
    return !!type && (type.kind === 'number' || type.kind === 'int' || type.kind === 'float') && !type.groupForm;
};

/**
 * The prefixes of a reference path that end on a segment named `name` and go on past it, such as
 * `&~/Weapon/FireInterval` of `&~/Weapon/FireInterval/BaseValue`. A segment inside a `<file>` is
 * not a member, so the search starts after the last `>`.
 *
 * @param path the reference path.
 * @param name the member name, matched ignoring case.
 * @returns each such prefix.
 */
const prefixesThrough = (path: string, name: string): string[] => {
    const lower = path.toLowerCase();
    const needle = `${name.toLowerCase()}/`;
    const prefixes: string[] = [];
    for (let at = lower.indexOf(needle, lower.lastIndexOf('>') + 1); at >= 0; at = lower.indexOf(needle, at + 1)) {
        if (at === 0 || '/&'.includes(path[at - 1])) prefixes.push(path.slice(0, at + name.length));
    }
    return prefixes;
};

/** How a change breaks the references that still read the member. */
type ChangeKind = 'removed' | 'number-to-group' | 'group-to-value';

/**
 * How a change breaks readers, or undefined when it leaves every reader readable.
 *
 * @param change the changed member.
 * @returns the kind of break.
 */
const changeKindOf = (change: MemberChange): ChangeKind | undefined => {
    const { old, incoming } = change;
    if (!incoming) return 'removed';
    const oldIsContainer = isGroupNode(old) || isListNode(old);
    if (!oldIsContainer && isGroupNode(incoming)) return 'number-to-group';
    if (oldIsContainer && isValueNode(incoming) && !isReferenceValue(incoming)) return 'group-to-value';
    return undefined;
};

/**
 * Whether one reference breaks under a change of the given kind. With the mod indexed a reference
 * lands on the mod's own body instead of the game's member, so both count as the member.
 *
 * @param reference the reference value.
 * @param kind how the change breaks readers.
 * @param old where the game writes the member.
 * @param incoming where the mod writes what replaces it.
 * @param name the member name.
 * @param cancellationToken cancels the resolution.
 * @returns true when the reference no longer reads.
 */
const breaksUnder = async (
    reference: ValueNode,
    kind: ChangeKind,
    old: Span | undefined,
    incoming: Span | undefined,
    name: string,
    cancellationToken: CancellationToken
): Promise<boolean> => {
    const path = String(reference.valueType.value);
    const land = async (to: string) =>
        (await navigate(to, reference, getStartOfAstNode(reference).uri, cancellationToken).catch(
            () => null
        )) as AbstractNode | null;
    if (kind === 'removed') return startsIn(await land(path), old);
    if (kind === 'number-to-group') {
        if (!readsAsNumber(reference)) return false;
        const landing = await land(path);
        return startsAt(landing, old) || startsAt(landing, incoming);
    }
    for (const prefix of prefixesThrough(path, name)) {
        const landing = await land(prefix);
        if (startsAt(landing, old) || startsAt(landing, incoming)) return true;
    }
    return false;
};

/** How many reading sites a finding names before it stops listing them. */
const READERS_SHOWN = 4;

/**
 * The place a reader is written, as `file:line`.
 *
 * @param reader the reference value.
 * @returns the site.
 */
const readerSite = (reader: AbstractNode): string =>
    `${basename(uriToFsPath(getStartOfAstNode(reader).uri))}:${reader.position.line + 1}`;

/** How many alias hops the global alias walk follows away from the root. */
const ALIAS_DEPTH = 8;

/**
 * The member path from `scope` down to the assignment a reference is the value of, or undefined
 * when a list or an unnamed group sits between them, since no reference path can be written
 * through one.
 *
 * @param reference the reference value.
 * @param scope the group or document the path starts at.
 * @returns the member names, outermost first.
 */
const memberPathWithin = (reference: ValueNode, scope: AbstractNode): string[] | undefined => {
    const name = assignmentNameOf(reference);
    if (name === undefined) return undefined;
    const segments = [name];
    let container = reference.parent;
    while (container && container !== scope) {
        if (!isGroupNode(container) || !container.identifier) return undefined;
        segments.unshift(container.identifier.name);
        container = container.parent;
    }
    return container === scope ? segments : undefined;
};

/** The global alias paths per file, built once per parse of the root `cosmoteer.rules`. */
const aliasMaps = new WeakMap<AbstractNodeDocument, Promise<Map<string, string[]>>>();

/**
 * Every global path that aliases a member of the game tree, keyed by the file it lands in. The root
 * `cosmoteer.rules` aliases files in by name (`INDICATORS = &<gui/game/indicators/indicators.rules>`),
 * and a file pulled in that way can alias on into another (`/CareerMode/…` stepping through
 * career.rules), so the walk follows each alias into the group or file it lands on and goes on from
 * there with the path that reached it.
 *
 * @param root the root `cosmoteer.rules`.
 * @returns the alias paths per folded file path, each starting with `/`.
 */
const buildAliasMap = async (root: AbstractNodeDocument): Promise<Map<string, string[]>> => {
    const aliases = new Map<string, string[]>();
    const visited = new Set<AbstractNode>([root]);
    const queue: Array<{ scope: AbstractNode; prefix: string; depth: number }> = [
        { scope: root, prefix: '', depth: 0 },
    ];
    for (let next = queue.shift(); next; next = queue.shift()) {
        for (const reference of referenceNodesOf(next.scope)) {
            const segments = memberPathWithin(reference, next.scope);
            if (!segments) continue;
            const alias = `${next.prefix}/${segments.join('/')}`;
            const landed = await navigate(
                String(reference.valueType.value),
                reference,
                getStartOfAstNode(reference).uri,
                CancellationToken.None
            ).catch(() => null);
            if (!landed) continue;
            const node = targetsWholeFile(landed as ResolvedTarget)
                ? await getParsedFileDocument(landed as FileWithPath).catch(() => null)
                : (landed as AbstractNode);
            if (!node) continue;
            const key = fileKey(getStartOfAstNode(node).uri);
            aliases.set(key, [...(aliases.get(key) ?? []), alias]);
            if (next.depth + 1 >= ALIAS_DEPTH || visited.has(node)) continue;
            if (!isGroupNode(node) && !isDocumentNode(node)) continue;
            visited.add(node);
            queue.push({ scope: node, prefix: alias, depth: next.depth + 1 });
        }
    }
    return aliases;
};

/**
 * The global paths that alias into a file, which a reference written through one never names.
 *
 * @param file the file's document.
 * @returns the alias paths, each starting with `/`.
 */
const globalAliasesOf = async (file: AbstractNodeDocument): Promise<string[]> => {
    const root = (await CosmoteerWorkspaceService.instance.getCosmoteerRules().catch(() => undefined))?.content
        .parsedDocument;
    if (!root) return [];
    let map = aliasMaps.get(root);
    if (!map) {
        map = buildAliasMap(root);
        aliasMaps.set(root, map);
    }
    return (await map).get(fileKey(file.uri)) ?? [];
};

/**
 * The documents that can hold a reference to a member of `file`: the file itself, then every project
 * file whose text names it or one of its global aliases, which is how a reference from another file
 * reaches it (a `<file>` path, a base it inherits, or `&/ALIAS/…`). Without project folders only the
 * file itself is read.
 *
 * @param file the target's document.
 * @param folderPaths the project folders, absent to read the target file alone.
 * @param cancellationToken cancels the sweep.
 * @returns the documents, the target's own first.
 */
async function* readerDocuments(
    file: AbstractNodeDocument,
    folderPaths: string[] | undefined,
    cancellationToken: CancellationToken
): AsyncGenerator<AbstractNodeDocument> {
    yield file;
    if (!folderPaths) return;
    const seen = new Set([fileKey(file.uri)]);
    const name = basename(uriToFsPath(file.uri));
    const needles = [name, ...(await globalAliasesOf(file))];
    const folded = needles.map((needle) => needle.toLowerCase());
    for (const needle of needles) {
        for await (const document of documentsMatching(folderPaths, needle, cancellationToken, (text) => {
            const lower = text.toLowerCase();
            return folded.some((mention) => lower.includes(mention));
        })) {
            const key = fileKey(document.uri);
            if (seen.has(key)) continue;
            seen.add(key);
            yield document;
        }
    }
}

/**
 * Findings for members an action changes under references that still read them. The game resolves
 * every reference against the tree the mods leave behind, and nothing at load time points back at the
 * action that broke one:
 *
 * - A number written over by a group (`FireInterval = 4` overridden or replaced with `{ BaseValue = 4
 *   BuffType = … }`) is still read as a number by `(&…/FireInterval) - 0.5` elsewhere in the part,
 *   and the game fails with "Cannot read double from non-Field node".
 * - A group written over by a plain value is still stepped into by `&…/Range/BaseValue`.
 * - A removed member is still referenced, and the reference lands on nothing.
 *
 * A reader the same manifest also rewrites or removes, or one written inside the changed member
 * itself, is gone with it and does not count. A removed member a base of its container also supplies
 * is what the readers land on afterwards, so that removal breaks nothing.
 *
 * @param actions every action of the manifest.
 * @param folderPaths the project folders to sweep for readers in other files, absent for the target
 *        files alone.
 * @param cancellationToken cancels the resolution.
 * @returns one finding per changed member that still has readers.
 */
const changedMembersStillRead = async (
    actions: Action[],
    folderPaths: string[] | undefined,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const changes: MemberChange[] = [];
    for (const action of actions) changes.push(...(await memberChangesOf(action, cancellationToken)));
    const rewritten = changes.map((change) => spanOf(change.old));
    const errors: ValidationError[] = [];
    for (const change of changes) {
        if (cancellationToken.isCancellationRequested) return errors;
        const kind = changeKindOf(change);
        if (!kind) continue;
        if (kind === 'removed') {
            const flattened = await flattenGroup(change.container, cancellationToken).catch(() => null);
            const member = flattened?.members.find((entry) => entry.name.toLowerCase() === change.name.toLowerCase());
            if (member && (member.origin.inherited || member.shadows.some((origin) => origin.inherited))) continue;
        }
        const old = spanOf(change.old);
        const incoming = spanOf(change.incoming);
        const lower = change.name.toLowerCase();
        // Two references on one line are one site. One past what the finding lists is enough to
        // know the list is cut off.
        const sites = new Set<string>();
        sweep: for await (const document of readerDocuments(
            getStartOfAstNode(change.old),
            folderPaths,
            cancellationToken
        )) {
            for (const reference of referenceNodesOf(document)) {
                if (!String(reference.valueType.value).toLowerCase().includes(lower)) continue;
                if (isActionTargetValueNode(reference)) continue;
                // A math reference's parent is its group rather than the expression, so a reader is
                // matched to a rewritten value by where it is written.
                if (rewritten.some((span) => startsIn(reference, span))) continue;
                if (!(await breaksUnder(reference, kind, old, incoming, change.name, cancellationToken))) continue;
                sites.add(readerSite(reference));
                if (sites.size > READERS_SHOWN) break sweep;
            }
        }
        if (sites.size === 0) continue;
        const shown = [...sites].slice(0, READERS_SHOWN).join(', ');
        errors.push(changeFinding(kind, change, sites.size > READERS_SHOWN ? `${shown}, …` : shown));
    }
    return errors;
};

/**
 * The finding for one changed member that still has readers.
 *
 * @param kind how the change breaks them.
 * @param change the changed member.
 * @param sites where the readers are, as text.
 * @returns the finding.
 */
const changeFinding = (kind: ChangeKind, change: MemberChange, sites: string): ValidationError => {
    const name = change.name;
    const base = { node: change.reportAt, severity: 'warning' as const };
    switch (kind) {
        case 'removed':
            return {
                ...base,
                message: l10n.t('This removes "{0}", which is still referenced', name),
                additionalInfo: l10n.t(
                    'References to "{0}" remain at {1}. Once the mod loads they point at nothing, and the game fails to read them. Override or remove them in this mod as well.',
                    name,
                    sites
                ),
            };
        case 'number-to-group':
            return {
                ...base,
                message: l10n.t('"{0}" becomes a group, but it is still read as a number', name),
                additionalInfo: l10n.t(
                    '"{0}" is read as a number at {1}. Once the mod loads "{0}" is a group, and the game fails with "Cannot read double from non-Field node". Override those readers too, pointing them at "{0}/BaseValue", or keep "{0}" a plain number.',
                    name,
                    sites
                ),
            };
        case 'group-to-value':
            return {
                ...base,
                message: l10n.t('"{0}" becomes a plain value, but members inside it are still read', name),
                additionalInfo: l10n.t(
                    'Members inside "{0}" are read at {1}. Once the mod loads "{0}" is a plain value with no members, and the game fails to find them. Override those readers too, or keep "{0}" a group.',
                    name,
                    sites
                ),
            };
    }
};

/** One verb's field schema, which is what every per-action check is held against. */
type VerbFieldSchema = (typeof VERB_SCHEMA)[keyof typeof VERB_SCHEMA];

/**
 * Judges one action's own fields: the ones its verb requires, the `Index` an `AddBase` writes, and
 * the AST shape its source value takes.
 *
 * @param errors the findings, in the order the pass produced them.
 * @param action the parsed action.
 * @param schema the verb's field schema.
 */
const checkActionFields = (errors: ValidationError[], action: Action, schema: VerbFieldSchema): void => {
    for (const required of schema.required) {
        if (!action.presentFields.has(required.toLowerCase())) {
            errors.push({
                message: l10n.t('Mod action is missing a required field'),
                node: action.verbNode ?? action.group,
                additionalInfo: l10n.t('The "{0}" action requires the field "{1}"', action.type, required),
            });
        }
    }

    // An `AddBase` that names an `Index` inserts mid-list instead of appending, which re-slots
    // every base behind it. The editor does not follow that, so it says so rather than leaving
    // the `^/N` references into this target unexplainedly unknown.
    if (action.type === 'AddBase' && action.presentFields.has('index')) {
        errors.push({
            message: l10n.t('This AddBase inserts at an index, which the editor does not follow'),
            node: action.verbNode ?? action.group,
            severity: 'information',
            additionalInfo: l10n.t(
                'The game inserts the base at that position and moves every base behind it one slot on. References that step into this target with "^/N" are resolved against the written inheritance only, so one of them may be reported as unknown even though the game resolves it.'
            ),
        });
    }

    // The source value must take the AST shape the verb allows (e.g. Overrides needs a `{}`,
    // AddMany needs a `[]`). A missing source is already reported by the required-field check.
    if (!schema.sourceShape) return;
    for (const source of action.sources) {
        if (sourceMatchesShape(source, schema.sourceShape)) continue;
        errors.push({
            message: l10n.t('Mod action source has the wrong shape'),
            node: source,
            additionalInfo: l10n.t(
                'The "{0}" action requires its "{1}" to be {2}',
                action.type,
                schema.sources[0],
                shapeDescription(schema.sourceShape)
            ),
        });
    }
};

/**
 * Judges one action target that did resolve: the file it landed in, the `Name` an `Add` into a
 * container needs, the shape the verb requires of it, and what the body writes into it.
 *
 * @param errors the findings, in the order the pass produced them.
 * @param action the parsed action.
 * @param schema the verb's field schema.
 * @param target the written target value.
 * @param resolved what the target resolved to.
 * @param text the manifest's text, which the rewrites read the written form from.
 * @param cancellationToken cancels the cross-file reads.
 */
const checkResolvedTarget = async (
    errors: ValidationError[],
    action: Action,
    schema: VerbFieldSchema,
    target: ValueNode,
    resolved: ResolvedTarget,
    text: string | undefined,
    cancellationToken: CancellationToken
): Promise<void> => {
    // Language string files can't be touched by actions at all, takes precedence over the
    // shape/Name checks below. The shared predicate also knows the base game's own language
    // files, which no manifest declares a `StringsFolder` for.
    if (await isStringsFile(targetFilePath(resolved), cancellationToken)) {
        errors.push({
            message: l10n.t('Mod action cannot target a language string file'),
            node: target,
            additionalInfo: l10n.t(
                'Files under the "StringsFolder" (such as "en.rules") are not modifiable by actions; provide your own per-language string file instead'
            ),
        });
        return;
    }

    const wholeFile = targetsWholeFile(resolved);

    if (action.type === 'Add') {
        // `Name` is mandatory when adding into a container (a whole `.rules` file, not
        // descending into it, or a `{}` group). Otherwise the added entry has no key.
        if ((wholeFile || isGroupNode(resolved as AbstractNode)) && !action.nameNode) {
            errors.push({
                message: l10n.t('Add action is missing the Name field'),
                node: action.verbNode ?? action.group,
                additionalInfo: l10n.t(
                    'Adding to a whole ".rules" file or a group "{ }" requires a "Name" for the new entry'
                ),
            });
        }
    }
    if (wholeFile && !schema.allowsWholeFileTarget) {
        // Most verbs operate on a node inside a file; a whole `.rules` file cannot itself
        // be replaced or removed. Overrides is the exception (its top level is a group).
        errors.push({
            message: l10n.t('Mod action cannot target a whole .rules file'),
            node: target,
            additionalInfo: l10n.t(
                'The "{0}" action must target a node inside a ".rules" file, not the file itself',
                action.type
            ),
        });
    } else if (!wholeFile && schema.targetShape && !targetMatchesShape(resolved as AbstractNode, schema.targetShape)) {
        // The resolved node must be the right container (e.g. AddMany needs a `[]`,
        // AddBase a `[]`/`{}`). You can't add list items to a scalar.
        errors.push({
            message: l10n.t('Mod action target has the wrong shape'),
            node: target,
            additionalInfo: l10n.t(
                'The "{0}" action must target {1}',
                action.type,
                targetShapeDescription(schema.targetShape)
            ),
        });
    }

    // An entry that is a whole list, which the game appends as one entry it cannot read.
    if ((action.type === 'Add' || action.type === 'AddMany') && !wholeFile && isListNode(resolved as AbstractNode)) {
        errors.push(...(await listAppendedAsEntry(action, resolved as ListNode, cancellationToken)));
    }

    // A body group that stands in for a whole group of the target, dropping the rest of it.
    if (action.type === 'Overrides') {
        errors.push(...(await overridesReplacingGroups(action, resolved, text, cancellationToken)));
    }
};

/**
 * The slot a member is read as: the field a class of its container declares, else the bare slot
 * type a map or range gives its members.
 *
 * @param container the group or document the member is written in.
 * @param name the member name.
 * @returns the slot, or undefined when the container cannot be typed.
 */
const memberSlot = (container: GroupNode | AbstractNodeDocument, name: string): FormSlot | undefined => {
    const classes = isDocumentNode(container) ? [documentRootClass(container)] : groupClassCandidates(container);
    for (const cls of classes) {
        const field = cls ? fieldOf(cls, name) : undefined;
        if (field) return field;
    }
    const valueType = memberTypeIn(container, name);
    return valueType && { valueType };
};

/**
 * A `Replace` whose `With` has a shape the replaced member's reader cannot read, such as a group
 * for a number. The game swaps the value in without looking, and the part then fails to load. A
 * reference is judged by what it lands on, the same table a member written in the file passes.
 *
 * @param actions the parsed actions.
 * @param cancellationToken cancels the resolution.
 * @returns one finding per unreadable `With`.
 */
const replacedWithUnreadable = async (
    actions: Action[],
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    for (const action of actions) {
        if (action.type !== 'Replace') continue;
        for (const { container, name, incoming } of await memberChangesOf(action, cancellationToken)) {
            if (!incoming) continue;
            const slot = memberSlot(container, name);
            if (!slot) continue;
            const written =
                isValueNode(incoming) && isReferenceValue(incoming)
                    ? await landingFormOf(incoming, cancellationToken)
                    : valueFormOf(incoming);
            const form = written && unreadableForm(slot, written);
            if (!form) continue;
            errors.push({
                message: l10n.t('Replace puts a value the game cannot read into this member'),
                node: incoming,
                additionalInfo: l10n.t(
                    "'{0}' is a {1} field, and the game cannot read a {2} value there.",
                    name,
                    valueTypeLabel(slot.valueType),
                    formLabel(form)
                ),
            });
        }
    }
    return errors;
};

/**
 * Validate a mod.rules manifest's actions: the verb must be known, required fields
 * must be present, and each target must resolve in the effective game tree (vanilla
 * plus the mod's own additions), unless `IgnoreIfNotExisting`/`CreateIfNotExisting`
 * is set.
 *
 * Sources are not checked here. The generic value validator handles them (they are
 * normal references resolved relative to the mod). Runs as a separate pass from the
 * AstType-keyed `Validator` (which allows only one callback per node type).
 *
 * @param actions the parsed actions of one manifest.
 * @param cancellationToken cancels the target resolution.
 * @param text the manifest's text, which the rewrites read the written form from. Absent, the
 *        findings carry no fix.
 * @param folderPaths the project folders, swept for references to a member an action changes. Absent,
 *        only the target files are read.
 */
export const validateModActions = async (
    actions: Action[],
    cancellationToken: CancellationToken,
    text?: string,
    folderPaths?: string[]
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];

    for (const action of actions) {
        if (action.type === 'Unknown') {
            errors.push({
                message: l10n.t('Unknown mod action verb'),
                node: action.verbNode ?? action.group,
                additionalInfo: l10n.t('Valid verbs are: {0}', ACTION_VERBS.join(', ')),
            });
            continue;
        }

        const schema = VERB_SCHEMA[action.type];
        checkActionFields(errors, action, schema);

        // A flag that tolerates a missing target only excuses the target being missing. When it is
        // there, the game applies the action to it and every check below still decides whether it
        // can (`ModAddAction.ApplyAction` throws on a leaf whether or not CreateIfNotExisting is set).
        const toleratesMissing = action.flags.IgnoreIfNotExisting === true || action.flags.CreateIfNotExisting === true;

        for (const target of action.targets) {
            if (cancellationToken.isCancellationRequested) return errors;
            const resolved = await resolveWithModContext(
                normalizeTargetPath(String(target.valueType.value)),
                target,
                cancellationToken
            ).catch(() => null);
            if (resolved === null) {
                if (toleratesMissing) continue;
                errors.push({
                    message: l10n.t('Action target not found'),
                    node: target,
                    additionalInfo: l10n.t(
                        'The target of this action could not be found in the game data (or in what this mod adds)'
                    ),
                });
                continue;
            }

            // The game reads a target as a string and dereferences an `&` reference first. One that lands
            // on a group, list or file stops the mod with "Cannot read string from non-Field node", and
            // one that lands on a field hands over that field's text (`90d`) as the target path, which
            // fails with "Unable to find node at path". Only a field holding a path itself is fine.
            const written = String(target.valueType.value).trim();
            const landing = targetsWholeFile(resolved) ? undefined : (resolved as AbstractNode);
            const landedText = landing && isValueNode(landing) ? String(landing.valueType.value).trim() : undefined;
            if (written.startsWith('&') && !landedText?.startsWith('<')) {
                const path = `"${written.slice(1).trim()}"`;
                errors.push({
                    message: l10n.t('Mod action target must be a quoted path, not a reference'),
                    node: target,
                    additionalInfo:
                        landedText === undefined
                            ? l10n.t(
                                  'The game reads the target as text and follows the "&" reference to what it names, which is not text, so the mod fails to load. Write the path as a string: {0}',
                                  path
                              )
                            : l10n.t(
                                  'The game reads the target as text and follows the "&" reference, so it takes the value "{0}" as the path and fails to find it. Write the path as a string: {1}',
                                  landedText,
                                  path
                              ),
                    data: {
                        rewrite: {
                            title: l10n.t('Write the target as {0}', path),
                            edits: [{ start: target.position.start, end: target.position.end, newText: path }],
                        },
                    },
                });
            }

            await checkResolvedTarget(errors, action, schema, target, resolved, text, cancellationToken);
        }
    }

    errors.push(...(await changedMembersStillRead(actions, folderPaths, cancellationToken)));
    errors.push(...(await replacedWithUnreadable(actions, cancellationToken)));
    return errors;
};

/**
 * The entries of an `Actions` list, checked against the shape the game's reader accepts.
 *
 * The list is read as a `List<ModAction>`, and each element supplies one action, whose verb the
 * reader takes from the element's own `Action` member. An element that is not a `{ }` group carries
 * no members, so the read fails and the game drops the whole mod with a load error. The shape this
 * catches is an action written into the list without its braces, which leaves its fields as loose
 * entries of the list. Nothing else reports it, because an entry that is not a group carries no
 * action for the other checks to look at.
 *
 * A `&` reference entry is left alone. It stands for whatever group it points at, which this pass
 * does not resolve. A run of adjacent bad entries is one unbraced action, so it is reported once.
 *
 * @param list the `Actions` list to check, or undefined when the file declares none.
 * @returns one finding per run of entries the reader cannot read as an action.
 */
export const validateActionEntries = (list: ListNode | undefined): ValidationError[] => {
    if (!list) return [];
    const errors: ValidationError[] = [];
    let inRun = false;
    for (const element of list.elements) {
        if (isGroupNode(element) || isReferenceValue(element)) {
            inRun = false;
            continue;
        }
        if (inRun) continue;
        inRun = true;
        errors.push({
            message: l10n.t('Mod action entry is not a group'),
            node: element,
            additionalInfo: l10n.t(
                'Every entry of an "Actions" list is one action and has to be written as its own "{ }" group. The game reads each entry as an action, so an entry of another shape makes the manifest unreadable and the mod is dropped with a load error.'
            ),
        });
    }
    return errors;
};
