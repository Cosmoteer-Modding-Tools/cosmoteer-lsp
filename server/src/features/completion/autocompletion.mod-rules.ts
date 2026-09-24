import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    ListNode,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isIdentifierNode,
    isGroupNode,
    isValueNode,
    GroupNode,
    IdentifierNode,
} from '../../core/ast/ast';
import { getStartOfAstNode, namedMembersOf } from '../../utils/ast.utils';
import { isModRules } from '../../document/document-kind';
import {
    ACTION_VERBS,
    ActionVerb,
    FLAG_FIELDS,
    isActionVerb,
    isTargetField,
    TARGET_FIELDS,
    VERB_SCHEMA,
} from '../../mod/action';
import { normalizeTargetPath } from '../../mod/action-target-resolver';
import { MANIFEST_MEMBERS, ManifestMember, manifestMemberFor, SHIP_LIBRARY_MEMBERS } from '../../mod/mod-manifest';
import { AutoCompletion, Completion, CompletionSuggestion } from './autocompletion.service.types';
import { completeRawPath } from './autocompletion.reference-path';
import { caretInValue, withValueEdit, writtenValueRange } from './completion-range';

const BOOLEAN_VALUES = ['true', 'false'];

/** A manifest assignment whose value is still being written: `Key = `, with whatever has been typed
 *  of the value. `=` is a completion trigger character, so this is the popup a modder sees on every
 *  field of every action they write. */
const MOD_VALUE_POSITION = /(?:^|[\s{;[])([A-Za-z_]\w*)\s*=\s*("?[^"]*)$/;

/** The reference-start prefixes a source field's value can take (`ToAdd = &<…>`). */
const SOURCE_PREFIXES = ['&<', '&<./Data/', '&/', '&~/'];

/** The source fields of every verb, whose value supplies the data the action adds. */
const SOURCE_FIELDS = new Set(
    Object.values(VERB_SCHEMA).flatMap((schema) => schema.sources.map((n) => n.toLowerCase()))
);

const flagFieldKeys = new Set([...FLAG_FIELDS].map((name) => name.toLowerCase()));

/** A field-name suggestion, tagged `Keyword` for the `Action` verb key and `Field` for the rest. */
const fieldSuggestion = (name: string): CompletionSuggestion => ({
    label: name,
    kind: name === 'Action' ? CompletionItemKind.Keyword : CompletionItemKind.Field,
});

/**
 * Render one action field as a snippet line, indented one level inside the entry block. Container
 * fields open their `[ ]`/`{ }` on their own lines. The tab stop `$index` lands where data goes.
 */
const fieldSnippetLine = (field: string, body: string): string => '\t' + `${field}${body}`.replace(/\n/g, '\n\t');

/** The snippet body for a verb's target field (a quoted path, or a `[ ]` list of paths for RemoveMany). */
const targetSnippet = (verb: ActionVerb, index: number): string => {
    const field = VERB_SCHEMA[verb].targets[0];
    if (verb === 'RemoveMany') return fieldSnippetLine(field, `\n[\n\t"$${index}"\n]`);
    return fieldSnippetLine(field, ` = "$${index}"`);
};

/** The snippet body for a verb's source field, shaped per its `sourceShape` (list/group/plain). */
const sourceSnippet = (verb: ActionVerb, index: number): string | undefined => {
    const schema = VERB_SCHEMA[verb];
    const field = schema.sources[0];
    if (!field) return undefined;
    if (schema.sourceShape === 'list') return fieldSnippetLine(field, `\n[\n\t$${index}\n]`);
    if (schema.sourceShape === 'group') return fieldSnippetLine(field, `\n{\n\t$${index}\n}`);
    return fieldSnippetLine(field, ` = $${index}`);
};

/** A complete `{ … }` action entry as an LSP snippet, with the required target/source as tab stops. */
export const buildActionSnippet = (verb: ActionVerb): string => {
    const lines = [`\tAction = ${verb}`, targetSnippet(verb, 1)];
    const source = sourceSnippet(verb, 2);
    if (source) lines.push(source);
    return `{\n${lines.join('\n')}\n}`;
};

/** One full-action-block suggestion per verb, offered at the `Actions [ … ]` list level. */
export const verbSnippetSuggestions = (): CompletionSuggestion[] =>
    ACTION_VERBS.map((verb) => ({
        label: verb,
        kind: CompletionItemKind.Snippet,
        insertText: buildActionSnippet(verb),
        isSnippet: true,
        detail: `${verb} action`,
    }));

/** The field name owning `node`: the assignment key whose value is `node`, or a named list's identifier. */
const owningFieldName = (node: AbstractNode): string | undefined => {
    const parent = node.parent;
    if (parent && isGroupNode(parent)) {
        for (const element of parent.elements) {
            if (isAssignmentNode(element) && element.right === node) return element.left.name;
        }
    }
    if (parent && isListNode(parent) && parent.identifier) return parent.identifier.name;
    return undefined;
};

/** The nearest enclosing `Actions [ ... ]` entry group, if any. */
const enclosingActionGroup = (node: AbstractNode): GroupNode | undefined => {
    let current: AbstractNode | undefined = node;
    while (current) {
        if (isGroupNode(current) && current.parent && isListNode(current.parent) && isActionsList(current.parent))
            return current;
        current = current.parent;
    }
    return undefined;
};

/** Whether `list` is an `Actions` list, matched case-insensitively. */
const isActionsList = (list: ListNode): boolean => list.identifier?.name.toLowerCase() === 'actions';

/** Whether `list` is the manifest's `ShipLibraries` list, matched the way the game reads names. */
const isShipLibrariesList = (list: ListNode): boolean => list.identifier?.name.toLowerCase() === 'shiplibraries';

/**
 * The manifest members legal inside a container: the top level takes what `ModInfo` declares, a
 * `ShipLibraries [ { … } ]` entry takes the library members, and everything else (an action entry,
 * a version list, a group a manifest grows later) is served elsewhere or not at all.
 *
 * @param container the document or the container the caret sits in.
 * @returns the member model for that scope, or undefined when the scope takes no manifest member.
 */
const manifestScopeOf = (container: AbstractNode | AbstractNodeDocument | undefined): ManifestMember[] | undefined => {
    if (!container) return undefined;
    if (isDocumentNode(container)) return MANIFEST_MEMBERS;
    if (isGroupNode(container) && container.parent && isListNode(container.parent))
        return isShipLibrariesList(container.parent) ? SHIP_LIBRARY_MEMBERS : undefined;
    return undefined;
};

/**
 * The manifest members a scope does not carry yet, as completions. The names the game binds to the
 * same member are folded together, so a manifest already carrying the legacy `ModifiesMultiplayer`
 * is not offered `ModifiesGameplay` beside it, and only the declared spelling is ever suggested.
 * `partial` filters the candidates, and the one name in `exempt` survives the present-set filter,
 * because a name the caret is writing over is not a name the manifest keeps.
 *
 * @param scope the document or entry group the caret sits in.
 * @param members the member model for that scope.
 * @param partial the name text typed so far, empty to offer them all.
 * @param exempt the written name the caret is about to overwrite, defaulting to `partial`.
 * @returns one suggestion per member the scope can still take.
 */
const manifestMemberCompletions = (
    scope: { elements: AbstractNode[] },
    members: ManifestMember[],
    partial: string,
    exempt = partial
): CompletionSuggestion[] => {
    const present = new Set<string>();
    for (const [name] of namedMembersOf(scope)) {
        const member = manifestMemberFor(name, members);
        present.add((member?.name ?? name).toLowerCase());
    }
    const typed = partial.toLowerCase();
    const written = manifestMemberFor(exempt, members)?.name.toLowerCase() ?? exempt.toLowerCase();
    return members
        .map((member, order) => ({ member, order }))
        .filter(({ member }) => {
            const key = member.name.toLowerCase();
            return key.startsWith(typed) && (key === written || !present.has(key));
        })
        .map(({ member, order }) => ({
            label: member.name,
            kind: CompletionItemKind.Field,
            detail: member.required ? 'required' : 'optional',
            // Required members first, and inside each bucket the order `ModInfo` declares them,
            // which is the order a hand-written manifest reads in.
            sortText: `${member.required ? '0' : '1'}_${String(order).padStart(2, '0')}_${member.name}`,
        }));
};

const verbOf = (actionGroup: GroupNode): string | undefined => {
    for (const element of actionGroup.elements) {
        if (isAssignmentNode(element) && element.left.name.toLowerCase() === 'action' && isValueNode(element.right))
            return String(element.right.valueType.value);
    }
    return undefined;
};

/** The lower-cased field names present in `actionGroup`. */
const presentFieldNames = (actionGroup: GroupNode): Set<string> =>
    new Set(namedMembersOf(actionGroup).map(([name]) => name.toLowerCase()));

/** All field names valid for a verb (target/source/flags/named/optionals + the verb field itself). */
const fieldNamesForVerb = (verb: ActionVerb): string[] => {
    const schema = VERB_SCHEMA[verb];
    return [
        'Action',
        ...schema.targets,
        ...schema.sources,
        ...schema.flags,
        ...(schema.named ? [schema.named] : []),
        ...(schema.optionals ?? []),
    ];
};

/**
 * Field-name completions for an action entry: the names valid for its verb (or, if no
 * verb chosen yet, `Action` + the target fields), minus the fields already present.
 * `partial` filters the candidates, and the one name in `exempt` survives the present-set
 * filter, because a name the caret is writing over is not a name the entry keeps.
 *
 * @param actionGroup the entry the names are offered in.
 * @param partial the name text typed so far, empty to offer them all.
 * @param exempt the written name the caret is about to overwrite, defaulting to `partial`.
 * @returns the field names the entry can still take.
 */
export const fieldCompletionsForGroup = (
    actionGroup: GroupNode | undefined,
    partial = '',
    exempt = partial
): string[] => {
    if (!actionGroup) return [];
    const verb = verbOf(actionGroup);
    const candidates = isActionVerb(verb) ? fieldNamesForVerb(verb) : ['Action', ...TARGET_FIELDS];
    const present = presentFieldNames(actionGroup);
    // The game reads these names ignoring case, so a half-typed `addt` must still reach `AddTo`.
    const typed = partial.toLowerCase();
    const written = exempt.toLowerCase();
    return candidates.filter((name) => {
        const key = name.toLowerCase();
        return key.startsWith(typed) && (key === written || !present.has(key));
    });
};

const containerChildren = (node: GroupNode | ListNode | AbstractNodeDocument): (GroupNode | ListNode)[] => {
    const containers: (GroupNode | ListNode)[] = [];
    for (const child of node.elements) {
        if (isGroupNode(child) || isListNode(child)) containers.push(child);
        else if (isAssignmentNode(child) && (isGroupNode(child.right) || isListNode(child.right)))
            containers.push(child.right);
    }
    return containers;
};

/** The deepest group/list whose byte span strictly contains `offset`. */
const deepestContainerAt = (
    node: GroupNode | ListNode | AbstractNodeDocument,
    offset: number
): GroupNode | ListNode | undefined => {
    for (const container of containerChildren(node)) {
        if (offset > container.position.start && offset < container.position.end) {
            return deepestContainerAt(container, offset) ?? container;
        }
    }
    return isGroupNode(node) || isListNode(node) ? node : undefined;
};

/**
 * The `Actions [ ... ]` entry group directly containing `offset` (a byte offset),
 * or undefined if `offset` is outside an entry or inside one of its nested groups.
 * Used for completion at an empty insertion point where no leaf node matches.
 */
export const findActionGroupAtOffset = (document: AbstractNodeDocument, offset: number): GroupNode | undefined => {
    const deepest = deepestContainerAt(document, offset);
    if (
        deepest &&
        isGroupNode(deepest) &&
        deepest.parent &&
        isListNode(deepest.parent) &&
        isActionsList(deepest.parent)
    )
        return deepest;
    return undefined;
};

/**
 * Completions for the value of one manifest action field.
 *
 * Without this the value position fell through to the field-name completion, so `Action = ` offered
 * `AddTo` and `OverrideIn` instead of the verbs, and a flag field offered field names instead of
 * `true` and `false`.
 *
 * @param fieldName the field being assigned.
 * @param typed the value text typed so far.
 * @param node a node of the manifest, for resolving a target path against the game root.
 * @param cancellationToken cancels the path walk.
 * @returns the values that fit, empty when the field takes free text (a `Name`, an `Index`).
 */
const valueCompletionsForField = async (
    fieldName: string,
    typed: string,
    node: AbstractNode,
    cancellationToken: CancellationToken
): Promise<Completion[]> => {
    const fieldKey = fieldName.toLowerCase();
    if (fieldKey === 'action') {
        return ACTION_VERBS.map((verb) => ({ label: verb, kind: CompletionItemKind.Keyword }));
    }
    if (flagFieldKeys.has(fieldKey)) {
        return BOOLEAN_VALUES.map((value) => ({ label: value, kind: CompletionItemKind.Value }));
    }
    if (isTargetField(fieldName)) {
        // A target path is rooted at the game's Data folder, written inside the `<…>` file token.
        if (!typed.includes('<')) return ['<./Data/', '<'];
        return completeRawPath(normalizeTargetPath(typed.replace(/^"/, '')), node, cancellationToken).catch(() => []);
    }
    if (SOURCE_FIELDS.has(fieldKey)) {
        if (!typed.includes('&')) return SOURCE_PREFIXES;
        return completeRawPath(typed.replace(/^"/, ''), node, cancellationToken).catch(() => []);
    }
    return [];
};

/**
 * The member name the caret is retyping: the name of an assignment or of a written block in
 * `scope` whose own span holds the offset. A name with a value behind it is no AST leaf, so the
 * request lands on this offset path rather than on the node path, and the name has to be read back
 * off the tree or the field being edited counts as one the entry already has.
 *
 * The caret on the name's first character is left out. Nothing is being retyped there, the caret is
 * in front of the name, and a suggestion accepted there is an insert.
 *
 * @param scope the container whose members are being written.
 * @param offset the cursor byte offset.
 * @returns the identifier the caret sits in, or undefined when it sits in no member name.
 */
const editedMemberNameIn = (scope: { elements: AbstractNode[] }, offset: number): IdentifierNode | undefined => {
    for (const element of scope.elements) {
        const name = isAssignmentNode(element)
            ? element.left
            : (isGroupNode(element) || isListNode(element)) && element.identifier
              ? element.identifier
              : undefined;
        if (name?.position && offset > name.position.start && offset <= name.position.end) return name;
    }
    return undefined;
};

/**
 * Tags member-name suggestions with the span of the name the caret is retyping, so accepting one
 * overwrites that name instead of being spliced into it (`Add<caret>To` taking `ManyToAdd` wrote
 * `AddManyToAddTo`). Every suggestion offered at such a caret carries the span, not only the one
 * that spells the same name.
 *
 * @param completions the member-name suggestions.
 * @param name the identifier the caret sits in.
 * @param offset the cursor byte offset, which bounds the insert range.
 * @returns the tagged suggestions.
 */
const withNameEdit = (completions: Completion[], name: IdentifierNode, offset: number): Completion[] => {
    const position = name.position;
    if (!position || position.characterEnd - position.characterStart !== name.name.length) return completions;
    const range = {
        start: { line: position.line, character: position.characterStart },
        end: { line: position.line, character: position.characterEnd },
    };
    const caret = { line: position.line, character: position.characterStart + (offset - position.start) };
    return withValueEdit(completions, range, caret);
};

/**
 * Completions at a byte offset inside a manifest (an empty insertion point, where no leaf node
 * matches): the value of the field being assigned, else the remaining field names inside an action
 * entry, at the `Actions [ … ]` list level itself a full action block snippet per verb, and at the
 * manifest's own top level or inside a `ShipLibraries` entry the members that scope still takes.
 *
 * @param document the parsed manifest.
 * @param offset the cursor byte offset.
 * @param linePrefix the current line's text up to the cursor.
 * @param cancellationToken cancels a target-path walk.
 * @returns the completions for that position.
 */
export const modRulesOffsetCompletions = async (
    document: AbstractNodeDocument,
    offset: number,
    linePrefix: string,
    cancellationToken: CancellationToken
): Promise<Completion[]> => {
    const entry = findActionGroupAtOffset(document, offset);
    const assignment = MOD_VALUE_POSITION.exec(linePrefix);
    if (assignment) {
        return valueCompletionsForField(assignment[1], assignment[2], entry ?? document, cancellationToken);
    }
    if (entry) {
        const edited = editedMemberNameIn(entry, offset);
        const names = fieldCompletionsForGroup(entry, '', edited?.name ?? '').map(fieldSuggestion);
        return edited ? withNameEdit(names, edited, offset) : names;
    }

    const container = deepestContainerAt(document, offset);
    if (container && isListNode(container) && isActionsList(container)) return verbSnippetSuggestions();
    const scope = container ?? document;
    const members = manifestScopeOf(container ?? document);
    if (!members) return [];
    const edited = editedMemberNameIn(scope, offset);
    const names = manifestMemberCompletions(scope, members, '', edited?.name ?? '');
    return edited ? withNameEdit(names, edited, offset) : names;
};

/**
 * mod.rules-specific completion (only fires inside a manifest). It completes the verb
 * after `Action = ` (`Add`, `Overrides`, …), the target path inside an action target
 * field (`AddTo`/`OverrideIn`/… = "<./Data/…>"), reusing the cosmoteer/workshop traversal
 * against the game root, `true`/`false` for a boolean flag field (`IgnoreIfNotExisting`,
 * …), and field names inside an action entry (best-effort, on the field identifier).
 *
 * Source `&` references are completed by the generic reference completer, so they are left alone.
 */
export class AutoCompletionModRules implements AutoCompletion<AbstractNode> {
    public async getCompletions(
        node: AbstractNode,
        cancellationToken: CancellationToken,
        cursorOffset?: number
    ): Promise<Completion[]> {
        if (!isModRules(getStartOfAstNode(node).uri)) return [];

        if (isValueNode(node)) {
            const value = node;
            // A verb and a flag are complete values, so the pick replaces the whole written one
            // rather than landing in front of the tail a caret inside it left standing.
            const ranged = (completions: Completion[]): Completion[] =>
                withValueEdit(completions, writtenValueRange(value), caretInValue(value, cursorOffset));
            const field = owningFieldName(node);
            // Lower-cased for the membership checks below, since the game reads names ignoring case.
            const fieldKey = field?.toLowerCase();
            const partial = String(node.valueType.value ?? '');

            // The game reads a written value ignoring case, so the typed prefix is matched that way
            // too: an `Action = ov` must still reach `Overrides`.
            const typed = partial.toLowerCase();

            if (fieldKey && flagFieldKeys.has(fieldKey)) {
                return ranged(
                    BOOLEAN_VALUES.filter((flag) => flag.startsWith(typed)).map((flag) => ({
                        label: flag,
                        kind: CompletionItemKind.Value,
                    }))
                );
            }
            // A non-flag boolean literal has nothing else to offer.
            if (node.valueType.type === 'Boolean') return [];

            if (fieldKey === 'action') {
                return ranged(
                    ACTION_VERBS.filter((verb) => verb.toLowerCase().startsWith(typed)).map((verb) => ({
                        label: verb,
                        kind: CompletionItemKind.Keyword,
                    }))
                );
            }
            if (field && isTargetField(field)) {
                if (!partial.includes('<')) return ['<./Data/', '<'];
                return completeRawPath(normalizeTargetPath(partial), node, cancellationToken).catch(() => []);
            }
            return [];
        }

        // Field-name completion: the identifier being typed inside an action entry, or, outside
        // one, the manifest member being typed at the top level or in a ShipLibraries entry. A
        // half-typed name is an AST leaf, so it never reaches the offset path that serves the
        // empty line beside it.
        if (isIdentifierNode(node)) {
            const actionGroup = enclosingActionGroup(node);
            if (actionGroup) return fieldCompletionsForGroup(actionGroup, node.name).map(fieldSuggestion);
            const scope = node.parent;
            const members = manifestScopeOf(scope);
            if (!scope || !members || !('elements' in scope)) return [];
            return manifestMemberCompletions(scope as { elements: AbstractNode[] }, members, node.name);
        }

        return [];
    }
}
