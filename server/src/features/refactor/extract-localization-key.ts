import { CancellationToken, CodeAction, CodeActionKind, Position, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isDocumentNode,
    isGroupNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { isLocalizationKeyType, localizationKeyFieldNames } from '../../document/schema/schema';
import { findNodeAtPosition, namedMembersOf } from '../../utils/ast.utils';
import { fieldOfValueNode } from '../completion/autocompletion.schema';
import { LocalizationKeyIndex } from '../completion/localization-key.index';
import { buildInsertLocalizationKeyEdit, modStringsFiles } from '../diagnostics/localization-key-insert';
import { normalizeUri } from '../navigation/reference-location';
import { stringValueNodesOf } from '../navigation/schema-reference.navigation';
import { uriToFsPath } from '../navigation/workspace-files';
import * as l10n from '@vscode/l10n';

/**
 * The `workspace/executeCommand` id that performs the extraction: it writes the chosen key into every
 * language strings file of the mod and repoints the extracted value at it, as one edit.
 */
export const EXTRACT_LOCALIZATION_KEY_COMMAND = 'cosmoteer.extractLocalizationKey';

/**
 * The command the lightbulb's refactoring carries, deliberately absent from the server's
 * `executeCommandProvider` so that it is never executed here.
 *
 * The key path is a name the author owns, and a code action has no way to ask for one. A client
 * resolves a command against its own handlers only when the server does not claim it, so leaving
 * this one unclaimed is what hands the exchange to the client. Both clients implement it: they ask
 * for the key path, then invoke {@link EXTRACT_LOCALIZATION_KEY_COMMAND} with the answer.
 */
export const EXTRACT_LOCALIZATION_KEY_ACTION_COMMAND = 'cosmoteer.extractLocalizationKeyFromAction';

/** What the client sends once the author has named the key. */
export interface ExtractLocalizationKeyArgs {
    /** The file the extracted literal lives in. */
    uri: string;
    /** The literal's start offset in that file, opening quote included. */
    offset: number;
    /** The literal exactly as written, quotes included, which is also the text the strings files get. */
    literal: string;
    /** The key path to declare. The code action proposes one, the author may rewrite it. */
    key: string;
}

/** Why an extraction did nothing. */
type ExtractLocalizationKeyFailure = 'stale' | 'noStringsFiles' | 'editRejected';

/** What the extraction did, or why it did nothing. */
export interface ExtractLocalizationKeyResult {
    /** The key the value now points at. */
    key: string;
    /** The strings files the key was written into (absolute paths), for the client's tidy-up. */
    changedFiles: string[];
    /** Set when nothing was changed. */
    failure?: ExtractLocalizationKeyFailure;
}

/** The result plus the edit itself, which the server applies rather than sending to the client. */
interface ExtractLocalizationKeyPlan extends ExtractLocalizationKeyResult {
    edit?: WorkspaceEdit;
}

/** A key path as a strings file declares one: slash-joined member names, nothing a name cannot hold. */
const KEY_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

/** The leaf ending each of the three key fields an entity usually carries, which is how the game's own
 *  strings files spell the `Foo` / `FooIcon` / `FooDesc` triplet. */
const LEAF_SUFFIXES = new Map<string, string>([
    ['namekey', ''],
    ['iconnamekey', 'Icon'],
    ['descriptionkey', 'Desc'],
]);

/** The leaf ending a key derived for `fieldName` gets, e.g. `Desc` for `DescriptionKey`. */
const suffixFor = (fieldName: string): string =>
    LEAF_SUFFIXES.get(fieldName.toLowerCase()) ?? fieldName.replace(/Key$/, '');

/** `Parts/FooIcon` without the ending its own field's name asked for, so another field can spell its own. */
const stripSuffix = (key: string, suffix: string): string =>
    suffix.length > 0 && key.length > suffix.length && key.endsWith(suffix) ? key.slice(0, -suffix.length) : key;

/** `deposit_carbon_1x` -> `DepositCarbon1x`, the spelling strings files name an entity with. */
const pascalCase = (raw: string): string =>
    raw
        .split(/[^A-Za-z0-9]+/)
        .filter((part) => part.length > 0)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');

/** One localization key a document already points at, with the field and container carrying it. */
interface KeyLiteral {
    node: ValueNode;
    container: GroupNode | AbstractNodeDocument;
    name: string;
    key: string;
}

/**
 * Every key-path-shaped localization key literal in `document`, which is what a proposed key learns
 * its group path and its entity spelling from.
 *
 * @param document the parsed document being edited.
 * @returns the literals in document order.
 */
const keyLiteralsOf = (document: AbstractNodeDocument): KeyLiteral[] => {
    const fieldNames = localizationKeyFieldNames();
    const namesByContainer = new Map<object, Map<AbstractNode, string>>();
    const literals: KeyLiteral[] = [];
    for (const node of stringValueNodesOf(document)) {
        const container = node.parent;
        if (!container || !(isGroupNode(container) || isDocumentNode(container))) continue;
        let names = namesByContainer.get(container);
        if (!names) {
            names = new Map();
            for (const [name, member] of namedMembersOf(container)) names.set(member, name);
            namesByContainer.set(container, names);
        }
        const name = names.get(node);
        if (!name || !fieldNames.has(name.toLowerCase())) continue;
        const key = String(node.valueType.value).trim();
        if (KEY_PATH.test(key)) literals.push({ node, container, name, key });
    }
    return literals;
};

/** The group path (`Parts/`) most of a file's keys sit under, empty when it has none to learn from. */
const groupPathOf = (literals: readonly KeyLiteral[]): string => {
    const counts = new Map<string, number>();
    for (const { key } of literals) {
        const cut = key.lastIndexOf('/');
        if (cut <= 0) continue;
        const path = key.slice(0, cut + 1);
        counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [path, count] of counts) {
        if (count <= bestCount) continue;
        best = path;
        bestCount = count;
    }
    return best;
};

/** The entity a key is named after: the container's own `ID` without its author prefix, else the
 *  file name, both in the PascalCase spelling strings files use. */
const entityNameOf = (container: GroupNode | AbstractNodeDocument, uri: string): string => {
    for (const [name, member] of namedMembersOf(container)) {
        if (name.toLowerCase() !== 'id' || !isValueNode(member)) continue;
        const id = String(member.valueType.value).trim();
        // Ids are written `author.entity_name`, and only the entity name belongs in a key.
        const own = id.slice(id.lastIndexOf('.') + 1);
        if (own) return pascalCase(own);
    }
    const file = normalizeUri(uri).split('/').pop() ?? '';
    return pascalCase(file.replace(/\.[^.]*$/, ''));
};

/**
 * The key path proposed for the extracted literal, following what the file already does: a sibling
 * key names the same entity, so its own leaf ending comes off and this field's goes on (a group whose
 * `NameKey` reads `Parts/Foo` gets `Parts/FooDesc` for its description). With no sibling to follow,
 * the group path the file's other keys sit under is combined with the container's id or file name.
 * A key that is taken gets a counting suffix, so an extraction never silently points at somebody
 * else's string.
 *
 * @param document the parsed document being edited.
 * @param node the literal being extracted, skipped when reading the siblings.
 * @param container the group or document the field belongs to.
 * @param fieldName the field's written name, which decides the leaf ending.
 * @param uri the document uri, the fallback source of the entity name.
 * @param taken every key path the project already declares, lower-cased.
 * @returns the proposed key path.
 */
const proposeKey = (
    document: AbstractNodeDocument,
    node: ValueNode,
    container: GroupNode | AbstractNodeDocument,
    fieldName: string,
    uri: string,
    taken: ReadonlySet<string>
): string => {
    const literals = keyLiteralsOf(document);
    const siblings = literals.filter((literal) => literal.container === container && literal.node !== node);
    const anchor = siblings.find((sibling) => sibling.name.toLowerCase() === 'namekey') ?? siblings[0];
    const base = anchor
        ? stripSuffix(anchor.key, suffixFor(anchor.name))
        : `${groupPathOf(literals)}${entityNameOf(container, uri)}`;
    const leaf = suffixFor(fieldName);
    let key = `${base}${leaf}`;
    for (let index = 2; taken.has(key.toLowerCase()); index++) key = `${base}${leaf}${index}`;
    return key;
};

/**
 * The "extract this text into a localization key" refactoring: when the caret sits on a quoted literal
 * assigned to a `KeyString` field but the text is display text rather than a key path, offer to declare
 * it in the mod's language files and point the field at the new key. A value that is key-path shaped is
 * a key, right or wrong, and belongs to the "add the missing key" quick fix on the diagnostic instead.
 *
 * The action carries a command rather than an edit: the key path is the author's to name, and only the
 * editor can ask for one (see {@link EXTRACT_LOCALIZATION_KEY_ACTION_COMMAND}).
 *
 * @param document the parsed document the caret is in.
 * @param text that document's current source text, which the literal is read from verbatim.
 * @param cursor the caret position of the code-action request.
 * @param uri the document uri.
 * @param folderPaths the project folders the strings index is built from.
 * @param cancellationToken cancellation for the schema and index work.
 * @returns the code action, or undefined when the extraction does not apply.
 */
export const extractLocalizationKeyCodeAction = async (
    document: AbstractNodeDocument,
    text: string,
    cursor: Position,
    uri: string,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<CodeAction | undefined> => {
    const node = findNodeAtPosition(document, cursor);
    if (!node || !isValueNode(node) || !node.quoted || node.valueType.type !== 'String') return undefined;
    const literal = text.substring(node.position.start, node.position.end);
    // The literal is moved verbatim, which only works while it is one quoted run on one line. A
    // continued string carries its own indentation and would arrive in the strings file misaligned.
    if (!literal.startsWith('"') || !literal.endsWith('"') || literal.includes('\n')) return undefined;
    const written = String(node.valueType.value).trim();
    if (!written || KEY_PATH.test(written)) return undefined;

    const container = node.parent;
    if (!container || !(isGroupNode(container) || isDocumentNode(container))) return undefined;
    // Cheap pre-filter by field name, so the schema resolution only runs where a key can live.
    const fieldName = namedMembersOf(container).find(([, member]) => member === node)?.[0];
    if (!fieldName || !localizationKeyFieldNames().has(fieldName.toLowerCase())) return undefined;
    const field = await fieldOfValueNode(node, cancellationToken).catch(() => undefined);
    if (!isLocalizationKeyType(field?.valueType)) return undefined;

    // Nowhere to put the text: the file is not in a mod, or the mod ships no language file. Writing
    // one would mean inventing a language and a `StringsFolder` to declare it, which is the author's call.
    const stringsFiles = await modStringsFiles(uri, cancellationToken).catch(() => []);
    if (stringsFiles.length === 0) return undefined;

    const taken = await LocalizationKeyIndex.instance
        .allKeysLower(folderPaths, cancellationToken)
        .catch(() => new Set<string>());
    const key = proposeKey(document, node, container, fieldName, uri, taken);
    if (!KEY_PATH.test(key)) return undefined;

    const title = l10n.t('Extract text into a localization key "{0}"…', key);
    const args: ExtractLocalizationKeyArgs = { uri, offset: node.position.start, literal, key };
    return {
        title,
        kind: CodeActionKind.RefactorExtract,
        command: { title, command: EXTRACT_LOCALIZATION_KEY_ACTION_COMMAND, arguments: [args] },
    };
};

/**
 * The whole extraction as one edit: the key declared in every language file of the mod with the
 * literal as its text, plus the source value replaced by the key path. Writing the literal into every
 * language, rather than an empty placeholder, is what makes the extraction change nothing the player
 * sees: an unresolved key renders as its own path, so each language keeps showing the same words until
 * somebody translates them.
 *
 * @param args the file, span, literal, and the key the author settled on.
 * @param source the open document the literal lives in, whose current text decides the span.
 * @param cancellationToken cancellation for the folder resolution.
 * @param readOverride the unsaved text of an open strings file, preferred over its bytes on disk.
 * @returns the edit and the strings files it writes, or the reason nothing can be changed.
 */
export const buildExtractLocalizationKeyEdit = async (
    args: ExtractLocalizationKeyArgs,
    source: TextDocument,
    cancellationToken: CancellationToken,
    readOverride?: (absPath: string) => string | undefined
): Promise<ExtractLocalizationKeyPlan> => {
    const key = args.key.trim();
    const end = args.offset + args.literal.length;
    // The buffer moved on while the key was being typed. Never rewrite a span that is no longer there.
    if (!key || source.getText().slice(args.offset, end) !== args.literal) {
        return { key, changedFiles: [], failure: 'stale' };
    }
    const files = await modStringsFiles(args.uri, cancellationToken).catch(() => []);
    if (files.length === 0) return { key, changedFiles: [], failure: 'noStringsFiles' };

    const insert = await buildInsertLocalizationKeyEdit(args.uri, key, cancellationToken, args.literal, readOverride);
    // No insert means every language file already declares the key, which is a deliberate reuse of a
    // string that is already there. The value still has to start pointing at it.
    const changes: Record<string, TextEdit[]> = { ...(insert?.changes ?? {}) };
    const replacement: TextEdit = {
        range: { start: source.positionAt(args.offset), end: source.positionAt(end) },
        newText: `"${key}"`,
    };
    changes[args.uri] = [...(changes[args.uri] ?? []), replacement];
    const changedFiles = Object.keys(changes)
        .filter((uri) => uri !== args.uri)
        .map(uriToFsPath);
    return { key, changedFiles, edit: { changes } };
};
