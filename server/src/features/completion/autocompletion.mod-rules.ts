import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    ListNode,
    isListNode,
    isAssignmentNode,
    isIdentifierNode,
    isGroupNode,
    isValueNode,
    GroupNode,
} from '../../core/ast/ast';
import { getStartOfAstNode, namedMembersOf } from '../../utils/ast.utils';
import { isModRules } from '../../document/document-kind';
import { ACTION_VERBS, ActionVerb, FLAG_FIELDS, isActionVerb, isTargetField, TARGET_FIELDS, VERB_SCHEMA } from '../../mod/action';
import { normalizeTargetPath } from '../../mod/action-target-resolver';
import { AutoCompletion, Completion, CompletionSuggestion } from './autocompletion.service';
import { ReferenceAutoCompletionStrategy } from './strategy/reference.autocompletion-strategy';

const referenceStrategy = new ReferenceAutoCompletionStrategy();

const BOOLEAN_VALUES = ['true', 'false'];

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

/** One full-action-block suggestion per verb — offered at the `Actions [ … ]` list level. */
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

/**
 *  Checks if a given list node represents an `Actions` list.
 * @param list  The list node to check
 * @returns  `true` if the list node is an `Actions` list, `false` otherwise
 */
const isActionsList = (list: ListNode): boolean => list.identifier?.name.toLowerCase() === 'actions';

const verbOf = (actionGroup: GroupNode): string | undefined => {
    for (const element of actionGroup.elements) {
        if (isAssignmentNode(element) && element.left.name.toLowerCase() === 'action' && isValueNode(element.right))
            return String(element.right.valueType.value);
    }
    return undefined;
};

/**
 *  Get the set of lower-cased field names that are present in a given action group.
 * @param actionGroup  The action group to get the present field names from
 * @returns  A set of lower-cased field names that are present in the action group
 */
const presentFieldNames = (actionGroup: GroupNode): Set<string> =>
    new Set(namedMembersOf(actionGroup).map(([name]) => name.toLowerCase()));

/** All field names valid for a verb (target/source/flags/named + the verb field itself). */
const fieldNamesForVerb = (verb: ActionVerb): string[] => {
    const schema = VERB_SCHEMA[verb];
    return ['Action', ...schema.targets, ...schema.sources, ...schema.flags, ...(schema.named ? [schema.named] : [])];
};

/**
 * Field-name completions for an action entry: the names valid for its verb (or, if no
 * verb chosen yet, `Action` + the target fields), minus the fields already present.
 * `partial` filters the candidates (and always keeps the field currently being typed).
 */
export const fieldCompletionsForGroup = (actionGroup: GroupNode | undefined, partial = ''): string[] => {
    if (!actionGroup) return [];
    const verb = verbOf(actionGroup);
    const candidates = isActionVerb(verb) ? fieldNamesForVerb(verb) : ['Action', ...TARGET_FIELDS];
    const present = presentFieldNames(actionGroup);
    return candidates.filter((name) => name.startsWith(partial) && (name === partial || !present.has(name.toLowerCase())));
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
 * Completions at a byte offset inside a manifest (an empty insertion point, where no leaf node
 * matches): the remaining field names inside an action entry, or at the `Actions [ … ]` list
 * level itself, a full action block snippet per verb.
 */
export const modRulesOffsetCompletions = (document: AbstractNodeDocument, offset: number): Completion[] => {
    const entry = findActionGroupAtOffset(document, offset);
    if (entry) return fieldCompletionsForGroup(entry).map(fieldSuggestion);

    const container = deepestContainerAt(document, offset);
    if (container && isListNode(container) && isActionsList(container)) return verbSnippetSuggestions();
    return [];
};

/**
 * mod.rules-specific completion (only fires inside a manifest). It completes the verb
 * after `Action = ` (`Add`, `Overrides`, …); the target path inside an action target
 * field (`AddTo`/`OverrideIn`/… = "<./Data/…>"), reusing the cosmoteer/workshop traversal
 * against the game root; `true`/`false` for a boolean flag field (`IgnoreIfNotExisting`,
 * …); and field names inside an action entry (best-effort, on the field identifier).
 *
 * Source `&` references are completed by the generic reference completer, so they are left alone.
 */
export class AutoCompletionModRules implements AutoCompletion<AbstractNode> {
    public async getCompletions(node: AbstractNode, cancellationToken: CancellationToken): Promise<Completion[]> {
        if (!isModRules(getStartOfAstNode(node).uri)) return [];

        if (isValueNode(node)) {
            const field = owningFieldName(node);
            // Lower-cased for the membership checks below, since the game reads names ignoring case.
            const fieldKey = field?.toLowerCase();
            const partial = String(node.valueType.value ?? '');

            if (fieldKey && flagFieldKeys.has(fieldKey)) {
                return BOOLEAN_VALUES.filter((value) => value.startsWith(partial)).map((value) => ({
                    label: value,
                    kind: CompletionItemKind.Value,
                }));
            }
            // A non-flag boolean literal has nothing else to offer.
            if (node.valueType.type === 'Boolean') return [];

            if (fieldKey === 'action') {
                return ACTION_VERBS.filter((verb) => verb.startsWith(partial)).map((verb) => ({
                    label: verb,
                    kind: CompletionItemKind.Keyword,
                }));
            }
            if (field && isTargetField(field)) {
                if (!partial.includes('<')) return ['<./Data/', '<'];
                return referenceStrategy
                    .completeRawPath(normalizeTargetPath(partial), node, cancellationToken)
                    .catch(() => []);
            }
            return [];
        }

        // Field-name completion: the identifier being typed inside an action entry.
        if (isIdentifierNode(node)) {
            return fieldCompletionsForGroup(enclosingActionGroup(node), node.name).map(fieldSuggestion);
        }

        return [];
    }
}
