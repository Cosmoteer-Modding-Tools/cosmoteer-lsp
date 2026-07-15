import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import { basename } from 'path';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ListNode,
    ValueNode,
} from '../../core/ast/ast';
import {
    classOfGroup,
    memberTypeIn,
    registryForContainer,
    resolveGroupClass,
} from '../../document/schema/schema-context';
import { registryOf } from '../../document/schema/schema';
import { ReverseIncludeIndex } from '../navigation/reverse-include.index';
import { uriToFsPath } from '../navigation/workspace-files';
import { cachedParseFilePath } from '../../workspace/fs-cache';
import { ParserResultRegistrar } from '../../registrar/parser-result-registrar';
import { overrideTargetsOf } from '../../mod/override-sources';
import { resolveActionTarget } from '../../mod/action-target-resolver';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import {
    collectUnconditionalComponentIds,
    isComponentField,
    NON_SIBLING_FIELDS,
    PLAIN_ID,
    RUNTIME_INJECTED_IDS,
    targetsAnotherPart,
    tupleComponentTargetAt,
} from '../diagnostics/validator.schema-sibling';
import { Completion } from './autocompletion.service';
import { ValueType } from '../../document/schema/schema.types';

/** The registry whose ids the engine resolves part-wide (same constant the id-value completion uses). */
const PART_COMPONENT_REGISTRY = 'PartComponentRules';

/** Bounds the includer/override-target expansion, so a pathological include web stays cheap. */
const MAX_SCOPE_DOCUMENTS = 8;

/** A component id some field references, with where the expectation was written (for the detail). */
interface ReferenceSite {
    /** The id as written at the reference (its original casing, used as the completion label). */
    name: string;
    /** The component (enclosing group) that wrote the reference, e.g. `MissilesPrereqProxy`. */
    referencedBy?: string;
    /** The uri of the document the reference lives in. */
    sourceUri: string;
}

/**
 * Name completions inside a part's `Components` map: the component ids that are referenced somewhere
 * in the part's scope but not declared unconditionally, which are the names the part expects this
 * component set to provide.
 *
 * Component names are free-form map keys, so schema field completion rightly offers nothing for them.
 * But a name is not always arbitrary. A `ToggleProxy`'s `ComponentID = MissilesPrereq` on the base
 * part is a per-mode contract that each `ToggledComponents` set is meant to fulfill, and an
 * `OperationalToggle = IsOperational` written before the toggle exists is a component waiting to be
 * declared. Those dangling references are exactly the names worth offering.
 *
 * The scope spans the fragment's including context: the documents that `&<include>` this one (a mode
 * fragment's part file, via the reverse-include index) and the vanilla tree an `OverrideIn` action or
 * manifest override merges the content into. Ids declared unconditionally in any scope document
 * suppress a suggestion. Ids declared only inside sibling mode fragments do not, since those sets
 * are alternatives rather than merged, so each active set must bring its own.
 *
 * @param group the group the cursor is in, a candidate components container.
 * @param document the document being edited.
 * @param cancellationToken cancels the cross-file scope walk.
 * @returns the dangling-id completions (possibly empty), or undefined when `group` is not a
 *          part-component container, so the caller falls through to the normal field-name path.
 */
export const componentNameCompletions = async (
    group: GroupNode,
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<Completion[] | undefined> => {
    if (!isComponentsContainer(group)) return undefined;

    const scope = await scopeDocuments(document, cancellationToken);
    const declared = new Set<string>();
    const referenced = new Map<string, ReferenceSite>();
    for (const doc of scope) {
        if (cancellationToken.isCancellationRequested) return [];
        // The unconditional union covers this doc's own tree plus inherited bases and override
        // targets, but not the conditional component sets it includes. A sibling mode's declaration
        // must not suppress a suggestion for this set, while a template base's declaration must.
        const ids = await collectUnconditionalComponentIds(doc, cancellationToken);
        for (const id of ids.all) declared.add(id);
        collectComponentReferences(doc, referenced);
    }

    const completions: Completion[] = [];
    for (const [lower, site] of referenced) {
        if (declared.has(lower) || RUNTIME_INJECTED_IDS.has(lower)) continue;
        const from = site.sourceUri === document.uri ? undefined : basename(uriToFsPath(site.sourceUri));
        const context = [site.referencedBy, from].filter(Boolean).join(' · ');
        completions.push({
            label: site.name,
            kind: CompletionItemKind.Class,
            detail: `referenced by ${context || 'this part'}`,
            documentation:
                `\`${site.name}\` is referenced${site.referencedBy ? ` by \`${site.referencedBy}\`` : ''}` +
                `${from ? ` in \`${from}\`` : ''} but no component in scope declares it.`,
            insertText: `${site.name}\n{\n\tType = $0\n}`,
            isSnippet: true,
            triggerSuggest: true,
            sortText: `0_${site.name}`,
        });
    }
    return completions;
};

/**
 * Whether `group` is a part-component container, a map of free-form id → `Type=`-dispatched
 * component. True when its children dispatch into the part-component registry, or, for a
 * still-empty container, when its own slot is a map whose value is that registry.
 *
 * @param group the group the cursor is in.
 * @returns true when the group holds part components.
 */
const isComponentsContainer = (group: GroupNode): boolean => {
    if (registryForContainer(group)?.name === PART_COMPONENT_REGISTRY) return true;
    const parent = group.parent;
    const name = group.identifier?.name;
    if (!parent || !name || (!isGroupNode(parent) && !isDocumentNode(parent))) return false;
    return isComponentsMapType(memberTypeIn(parent, name));
};

/** Whether a schema slot type is a part-component map (free-form id → `Type=`-dispatched component). */
const isComponentsMapType = (slot: ValueType | undefined): boolean =>
    slot?.kind === 'map' &&
    slot.value.kind === 'polymorphicGroup' &&
    registryOf(slot.value.ref)?.name === PART_COMPONENT_REGISTRY;

/**
 * The documents whose component expectations apply to `document`: itself, the documents that include
 * it (reverse-include sources, e.g. the part file whose `ToggledComponents` pulls a mode fragment in),
 * the vanilla trees any of those merge into (manifest override actions, and inline `OverrideIn`
 * targets for actions declared outside a manifest), expanded transitively up to a small bound.
 *
 * @param document the document being edited.
 * @param token cancels the target navigation.
 * @returns the scope documents, the edited document first.
 */
const scopeDocuments = async (document: AbstractNodeDocument, token: CancellationToken): Promise<AbstractNodeDocument[]> => {
    const docs: AbstractNodeDocument[] = [];
    const seen = new Set<string>();
    const queue: Array<{ doc: AbstractNodeDocument; upward: boolean }> = [{ doc: document, upward: true }];
    while (queue.length > 0 && docs.length < MAX_SCOPE_DOCUMENTS) {
        if (token.isCancellationRequested) break;
        const { doc, upward } = queue.shift()!;
        const key = doc.uri.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        docs.push(doc);

        // Includers are followed only up the edited fragment's own chain, and only through includes
        // whose slot is a components map (a `ToggledComponents` pulling this set in), since a file
        // that merely reads one nested value out of the fragment is no component-set context.
        // Expanding includers from a part context reached sideways would pull in the sibling mode
        // fragments that include the same part, whose conditional declarations must not suppress
        // suggestions.
        if (upward) {
            for (const include of ReverseIncludeIndex.instance.includesOf(doc.uri)) {
                if (!isComponentsMapType(include.slot)) continue;
                const includer = await loadByNormalizedKey(include.source);
                if (includer) queue.push({ doc: includer, upward: true });
            }
        }
        for (const target of await overrideTargetsOf(doc.uri, token).catch(() => [])) {
            const root = documentRootOf(target);
            if (root) queue.push({ doc: root, upward: false });
        }
        for (const overrideIn of overrideInValuesOf(doc)) {
            const resolved = await resolveActionTarget(overrideIn, token).catch(() => null);
            const root = await documentOfResolved(resolved);
            if (root) queue.push({ doc: root, upward: false });
        }
    }
    return docs;
};

/** Loads a document from a reverse-include source key (a normalized, leading-slash-stripped path).
 *  Prefers the index's recorded real path, since the key is lower-cased and a case-sensitive
 *  filesystem would not find the file under it. Falls back to restoring the leading slash. */
const loadByNormalizedKey = async (key: string): Promise<AbstractNodeDocument | null> => {
    const path = ReverseIncludeIndex.instance.realPathFor(key) ?? (/^[a-z]:\//.test(key) ? key : `/${key}`);
    return ParserResultRegistrar.instance.getResultByPath(path) ?? (await cachedParseFilePath(path).catch(() => null));
};

/** The document root an AST node belongs to, by walking its parent chain. */
const documentRootOf = (node: AbstractNode): AbstractNodeDocument | undefined => {
    let current: AbstractNode | undefined = node;
    while (current && !isDocumentNode(current)) current = current.parent;
    return current && isDocumentNode(current) ? current : undefined;
};

/** The document a resolved action target lives in: parsed from a file, or the target node's root. */
const documentOfResolved = async (resolved: AbstractNode | FileWithPath | null): Promise<AbstractNodeDocument | null> => {
    if (!resolved) return null;
    if (isFile(resolved as FileWithPath)) {
        return cachedParseFilePath((resolved as FileWithPath).path).catch(() => null);
    }
    return documentRootOf(resolved as AbstractNode) ?? null;
};

/** Every `OverrideIn = "<…>"` value in the document, the targets of inline (non-manifest) actions. */
const overrideInValuesOf = (document: AbstractNodeDocument): ValueNode[] => {
    const out: ValueNode[] = [];
    const visit = (node: AbstractNode): void => {
        if (isAssignmentNode(node) && node.left.name === 'OverrideIn' && isValueNode(node.right)) {
            out.push(node.right);
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
                  : [];
        for (const child of children) visit(child);
    };
    visit(document);
    return out;
};

/**
 * Records every part-component id the document references, with the same gates the sibling-reference
 * validator applies (so completion and validation agree on what counts as a same-part reference):
 * assignments whose schema field targets the container's own part-component registry, and plain ids
 * in part-component tuple slots. Cross-part proxies and the known non-sibling fields are skipped.
 *
 * @param document the scope document whose references to record.
 * @param into the reference sites by lowercased id, first writer wins.
 */
const collectComponentReferences = (document: AbstractNodeDocument, into: Map<string, ReferenceSite>): void => {
    const record = (written: string, referencedBy: string | undefined): void => {
        if (!PLAIN_ID.test(written)) return;
        const lower = written.toLowerCase();
        if (!into.has(lower)) into.set(lower, { name: written, referencedBy, sourceUri: document.uri });
    };

    const checkGroup = (group: GroupNode): void => {
        const container = group.parent;
        if (!container || !isGroupNode(container)) return;
        if (targetsAnotherPart(group)) return;
        const registry = registryForContainer(container);
        if (registry?.name !== PART_COMPONENT_REGISTRY) return;
        const cls = classOfGroup(group, registry.name) ?? resolveGroupClass(group);
        if (!cls) return;
        for (const element of group.elements) {
            if (!isAssignmentNode(element)) continue;
            if (NON_SIBLING_FIELDS.has(element.left.name.toLowerCase())) continue;
            const value = element.right;
            if (!isValueNode(value) || value.valueType.type !== 'String') continue;
            if (!isComponentField(cls, element.left.name, registry)) continue;
            record(String(value.valueType.value), group.identifier?.name);
        }
    };

    const checkTupleList = (list: ListNode): void => {
        if (list.inheritance?.length) return;
        for (const [index, element] of list.elements.entries()) {
            if (!isValueNode(element) || element.valueType.type !== 'String') continue;
            if (!tupleComponentTargetAt(list, index)) continue;
            record(String(element.valueType.value), list.identifier?.name);
        }
    };

    const visit = (node: AbstractNode): void => {
        if (isGroupNode(node)) checkGroup(node);
        if (isListNode(node)) checkTupleList(node);
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
                  : [];
        for (const child of children) visit(child);
    };
    visit(document);
};
