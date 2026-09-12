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
} from '../../core/ast/ast';
import { listElementType } from '../../document/schema/schema-context';
import { Action, ACTION_VERBS, ActionSource, SourceShape, TargetShape, VERB_SCHEMA } from '../../mod/action';
import { normalizeTargetPath } from '../../mod/action-target-resolver';
import { resolveWithModContext } from '../../mod/mod-context';
import { isStringsFile } from '../../mod/strings-folder';
import { flattenGroup } from '../../semantics/effective-group';
import { FileTree, FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { foldPathCase } from '../../workspace/fs-cache';
import { uriToFsPath } from '../navigation/workspace-files';
import { getStartOfAstNode, namedMembersOf, parseFilePath } from '../../utils/ast.utils';
import { ValidationError } from './validator';
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
    const entries = target.elements.filter((element) => isGroupNode(element) || isListNode(element) || isValueNode(element));
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
        .map((line, index) => (index > 0 && line.startsWith(innerIndent) ? bodyIndent + line.slice(innerIndent.length) : line))
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
        const dropped = (flattened?.members ?? []).map((member) => member.name).filter((member) => !kept.has(member.toLowerCase()));
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
 */
export const validateModActions = async (
    actions: Action[],
    cancellationToken: CancellationToken,
    text?: string
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
        if (schema.sourceShape) {
            for (const source of action.sources) {
                if (!sourceMatchesShape(source, schema.sourceShape)) {
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
            }
        }

        // A flag that tolerates a missing target only excuses the target being missing. When it is
        // there, the game applies the action to it and every check below still decides whether it
        // can (`ModAddAction.ApplyAction` throws on a leaf whether or not CreateIfNotExisting is set).
        const toleratesMissing =
            action.flags.IgnoreIfNotExisting === true || action.flags.CreateIfNotExisting === true;

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
                continue;
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
            } else if (
                !wholeFile &&
                schema.targetShape &&
                !targetMatchesShape(resolved as AbstractNode, schema.targetShape)
            ) {
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
        }
    }

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
