import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    IdentifierNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { namedMembersOf } from '../../utils/ast.utils';
import { isLocalizationKeyType } from '../../document/schema/schema';
import { buildMatchPool, MatchPool } from '../../utils/did-you-mean';
import { normalizeUri } from '../../document/reference-location';
import { WatchedDocumentIndex } from '../../workspace/watched-document-index';
import { Completion, CompletionSuggestion } from './autocompletion.service.types';
import { fieldOfValueNode } from './autocompletion.schema';
import { withValueEdit, writtenValueRange } from './completion-range';

/** A `strings/` (or `Strings/`) path segment, the reliable convention for language files. */
const STRINGS_PATH_SEGMENT = /(^|\/)strings\//;

/**
 * The shape of a language id the game can ask for. It loads a language by opening `<id>.rules` in
 * every registered strings folder, and the id reaches it from Steam, from the system culture or
 * from the settings picker, so it is always a language tag such as `en`, `pt-br` or `zh-cn`. A copy
 * a modder parks beside the translation, `en - Copy.rules` or `_shared.rules`, is no such tag and
 * is read by nothing.
 */
export const LANGUAGE_ID = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$/;

/** What one language declares under a folder, merged across the strings files that declare it. */
export interface LanguageTexts {
    /** The id the game loads the language under, the file name without the extension. */
    readonly id: string;
    /** The label to name the language by, from `__Name`, falling back to the file name. */
    readonly label: string;
    /** Key path (`Misc/Okay`) to the text the language renders for it. */
    readonly texts: ReadonlyMap<string, string>;
}

/** One key's text in one language. */
export interface LocalizationText {
    /** The language label (`__Name`, e.g. `English`, or the file basename as a fallback). */
    language: string;
    /** The translated text for the key. */
    text: string;
}

/** What one language declares under a folder, merged across the strings files that declare it. */
export interface LanguageKeyCoverage {
    /** The language label, from `__Name` or the file basename. */
    readonly language: string;
    /** Every key path that language declares. */
    readonly keys: ReadonlySet<string>;
    /** One strings file declaring the language, as the index's normalized source key. */
    readonly source: string;
}

/** The keys one strings file declares, tagged with its language. */
interface StringsFileKeys {
    /** The id the game loads the file under, its name without the extension. */
    id: string;
    language: string;
    /** Whether the file offers a language of its own, per {@link declaresLanguage}. */
    declares: boolean;
    /** key path (`Misc/Okay`) → its translated text. */
    keys: Map<string, string>;
    /** The members whose value is a reference, which a key path can continue through. */
    links: KeyLink[];
}

/**
 * A member of a strings file whose value is a reference. `Strings.TryFindString` looks a key up
 * with `OTFile.TryFindAtPath`, which walks through a reference like any other node, so every key
 * under the referenced node is reachable under the referring member's path as well.
 */
interface KeyLink {
    /** The key path the referring member itself declares (`Lore`). */
    path: string;
    /** The reference as written (`&<lore.rules>`, `&<lore.rules>/Inner`, `&Other/Title`). */
    ref: string;
}

/** A reference into another file, with the path inside it the reference points at. */
const FILE_REFERENCE = /^&<([^<>]+)>(?:\/(.*))?$/;

/**
 * A reference to a node of the same file, with the root marker it opens with captured: `~` and `/`
 * start at the file root, and nothing at all makes the path relative to the member's own group,
 * which is where `OTReferenceNode.GetFindRoot` starts the walk.
 */
const LOCAL_REFERENCE = /^&([~/]?)\/?([A-Za-z_]\w*(?:\/[^<>&]*)?)$/;

/**
 * Whether `document` is a language strings file, whose leaf keys are localization keys. Two cheap
 * synchronous signals cover the field: a `strings/` path segment (the base game's `Data/strings` and
 * almost every mod) and a top-level `__Name` member (the required first line of a strings file, which
 * catches a mod placing them in a differently-named folder). Deliberately avoids the async
 * `StringsFolder` resolution `isStringsFile` does. This runs against every project file during the
 * one-time build, so it must not re-read manifests per file.
 */
export const isStringsDocument = (document: AbstractNodeDocument): boolean =>
    STRINGS_PATH_SEGMENT.test(normalizeUri(document.uri)) ||
    namedMembersOf(document).some(([name]) => name === '__Name');

/** The language label of a strings file: its `__Name` value, else its basename without extension. */
export const languageOf = (document: AbstractNodeDocument): string => {
    for (const [name, value] of namedMembersOf(document)) {
        if (name === '__Name' && isValueNode(value)) return String(value.valueType.value);
    }
    return (
        normalizeUri(document.uri)
            .split('/')
            .pop()
            ?.replace(/\.rules$/i, '') ?? ''
    );
};

/**
 * The id the game would load a strings file under: its file name without the extension, folded to
 * lower case the way the file system matches it.
 *
 * @param uri the strings file's uri.
 * @returns the language id, empty for a uri with no file name.
 */
export const languageIdOfUri = (uri: string): string =>
    (normalizeUri(uri).split('/').pop() ?? '').replace(/\.rules$/i, '').toLowerCase();

/**
 * The id the game would load `document` under, per {@link languageIdOfUri}.
 *
 * @param document the parsed strings file.
 * @returns the language id, empty for a document with no file name.
 */
export const languageIdOf = (document: AbstractNodeDocument): string => languageIdOfUri(document.uri);

/**
 * Whether the file offers a language of its own. The game reads the first two lines of every
 * `.rules` in a strings folder and lists the file as a language only when they open `__Name` and
 * `__DebugOnly` with `__DebugOnly` false, taking the id from the file name and `__Name` as the
 * label the picker shows.
 *
 * @param document the parsed strings file.
 * @returns true when the file declares a language the player can choose.
 */
export const declaresLanguage = (document: AbstractNodeDocument): boolean => {
    const members = namedMembersOf(document);
    if (members[0]?.[0] !== '__Name' || members[1]?.[0] !== '__DebugOnly') return false;
    // Two raw reads, so the two lines are the first two lines of the file. A comment or a blank
    // line above them, or between them, puts the header out of the game's reach.
    if (members[0][1].position.line !== 0 || members[1][1].position.line !== 1) return false;
    const debugOnly = members[1][1];
    return !(isValueNode(debugOnly) && String(debugOnly.valueType.value).toLowerCase() === 'true');
};

/**
 * Whether the game would read `document` as a language. Either the file declares one of its own, or
 * its name is an id the game can ask for, which is how a mod's `en.rules` is merged over the base
 * game's without repeating the header. Everything else in a strings folder is a backup, a note or a
 * fragment, and the game opens none of it.
 *
 * @param document the parsed strings file.
 * @returns true when the file is one of the languages its folder ships.
 */
export const isLanguageFile = (document: AbstractNodeDocument): boolean =>
    declaresLanguage(document) || LANGUAGE_ID.test(languageIdOf(document));

/** One path a strings file declares, at the node that spells the path's last segment. */
export interface LocalizationKeyDeclaration {
    /** The path the game looks a string up by (`Misc/Okay`). */
    path: string;
    /** The identifier spelling the last segment, absent when that segment is a list position. */
    nameNode?: IdentifierNode;
    /** The list position the last segment stands for, absent for a named member. */
    listIndex?: number;
    /** The declared node, a leaf value or the group/list that holds the keys below this path. */
    node: AbstractNode;
    /** The translated text, present only for a leaf. A group holds further keys instead. */
    text?: string;
}

/**
 * Every path a strings container declares, in document order. A key is the slash-joined path from the
 * file root to a leaf value (`Misc` group → `Okay` leaf → `Misc/Okay`). Groups and lists are yielded
 * alongside the leaves, because a group's name is a segment every key beneath it carries, which is
 * what lets a rename move a whole branch. Meta members (`__Name`, `__DebugOnly`) are engine
 * directives, not keys.
 */
function* declarationsIn(
    container: { elements: AbstractNode[] },
    prefix: string
): Generator<LocalizationKeyDeclaration> {
    for (const element of container.elements) {
        let name: string | undefined;
        let nameNode: IdentifierNode | undefined;
        let member: AbstractNode | null | undefined;
        if (isAssignmentNode(element)) {
            name = element.left.name;
            nameNode = element.left;
            member = element.right;
        } else if ((isGroupNode(element) || isListNode(element)) && element.identifier) {
            name = element.identifier.name;
            nameNode = element.identifier;
            member = element;
        }
        if (!name || !nameNode || !member || name.startsWith('__')) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (isGroupNode(member)) {
            yield { path, nameNode, node: member };
            yield* declarationsIn(member, path);
        } else if (isListNode(member)) {
            yield { path, nameNode, node: member };
            yield* listDeclarationsIn(member, path);
        } else if (isValueNode(member)) {
            yield { path, nameNode, node: member, text: String(member.valueType.value) };
        }
    }
}

/**
 * The paths of a strings list, addressed by element index: vanilla's `FameTitles [ "WHO??" … ]` is
 * referenced as `FameTitles/0`, `FameTitles/1`, … by `career.rules`. Such a segment is a position
 * rather than a name, which is why the declaration carries an index and no identifier.
 */
function* listDeclarationsIn(
    list: { elements: AbstractNode[] },
    prefix: string
): Generator<LocalizationKeyDeclaration> {
    for (let index = 0; index < list.elements.length; index++) {
        const element = list.elements[index];
        const path = `${prefix}/${index}`;
        if (isGroupNode(element)) {
            yield { path, listIndex: index, node: element };
            yield* declarationsIn(element, path);
        } else if (isListNode(element)) {
            yield { path, listIndex: index, node: element };
            yield* listDeclarationsIn(element, path);
        } else if (isValueNode(element)) {
            yield { path, listIndex: index, node: element, text: String(element.valueType.value) };
        }
    }
}

/**
 * Every localization key path `document` declares, leaves and the groups above them alike. One rule
 * decides what a path is, so the index and the rename can never disagree about which key a line of a
 * strings file declares.
 *
 * @param document the parsed strings file to read.
 * @returns each declared path with the node spelling its last segment.
 */
export function keyDeclarationsOf(document: AbstractNodeDocument): Generator<LocalizationKeyDeclaration> {
    return declarationsIn(document, '');
}

/**
 * The uri a `<…>` file token names, resolved the way the game resolves it: against the folder the
 * declaring file sits in. A token that leaves that folder's frame of reference, an absolute path or
 * one rooted at the game install (`./Data/…`) or at the mod (`~/…`), is left unresolved rather than
 * guessed at, so it contributes nothing instead of contributing the wrong file.
 *
 * @param source the normalized uri of the file the reference is written in.
 * @param token the path inside the `<…>`.
 * @returns the target's normalized uri, or undefined when it is not a sibling-relative path.
 */
const siblingUri = (source: string, token: string): string | undefined => {
    if (/^[/~]|^\.\/|^[A-Za-z]:/.test(token) || token.includes('<')) return undefined;
    let base = source.slice(0, source.lastIndexOf('/') + 1);
    let rest = token;
    while (rest.startsWith('../')) {
        const parent = base.lastIndexOf('/', base.length - 2);
        if (parent < 'file:///'.length) return undefined;
        base = base.slice(0, parent + 1);
        rest = rest.slice(3);
    }
    return rest ? base + rest : undefined;
};

/** English-ish languages sort first in hover output so the most-read text leads. */
/** Whether a language label names English, the language a mod's other languages are written from. */
export const isEnglish = (language: string): boolean => /^en\b|english/i.test(language);

/**
 * The English entry among the languages of one folder, the text the translations were written from.
 * The game keeps `en` loaded behind whatever language is in play and renders it for a key that
 * language is missing, so the id decides, with the label standing in for a folder that ships an
 * English file under another id.
 *
 * @param languages the languages of the folder.
 * @returns the English entry, or undefined when the folder ships none.
 */
export const englishOf = (languages: readonly LanguageTexts[]): LanguageTexts | undefined =>
    languages.find((entry) => entry.id === 'en') ?? languages.find((entry) => isEnglish(entry.label));

/**
 * Project-wide index of localization keys, the data behind strings-key completion, existence
 * validation, and hover (a `KeyString` field such as `NameKey = "…"`). Built once over
 * {@link WatchedDocumentIndex.buildFromProject} (only the strings files among the walked documents
 * contribute) and kept current by the file watcher, so features never re-read the strings tree per
 * keystroke. All languages share one key tree, so key paths are de-duplicated across the per-language
 * files (`en.rules`, `de.rules`, …); each key's per-language texts are kept for hover.
 */
export class LocalizationKeyIndex extends WatchedDocumentIndex {
    private static _instance: LocalizationKeyIndex;

    /** normalized source uri → the language + key texts that strings file declares. */
    private readonly bySource = new Map<string, StringsFileKeys>();

    private constructor() {
        super();
    }

    public static get instance(): LocalizationKeyIndex {
        if (!LocalizationKeyIndex._instance) LocalizationKeyIndex._instance = new LocalizationKeyIndex();
        return LocalizationKeyIndex._instance;
    }

    /** This index's slot in the persistent game-tree cache. */
    public readonly cacheId = 'localizationKeys';

    protected clear(): void {
        this.bySource.clear();
    }

    /**
     * Serializes the per-source language and key texts for the persistent game-tree cache.
     *
     * @returns the JSON-safe state.
     */
    public saveState(): unknown {
        // The id is the source's own file name, so it is derived on the way back in rather than
        // written out a second time.
        // The links are written out beside the keys: they are read off the tree, and the tree is
        // what a primed index does not have.
        return [...this.bySource.entries()].map(([source, file]) => [
            source,
            file.language,
            [...file.keys.entries()],
            file.declares,
            file.links.map((link) => [link.path, link.ref]),
        ]);
    }

    /**
     * Primes the index from a previously saved state.
     *
     * @param state the value a prior {@link saveState} returned.
     * @returns true when the state had the expected shape and was loaded.
     */
    public loadState(state: unknown): boolean {
        if (!Array.isArray(state)) return false;
        this.clear();
        for (const entry of state as Array<
            [string, string, Array<[string, string]>, boolean, Array<[string, string]>]
        >) {
            if (
                !Array.isArray(entry) ||
                typeof entry[0] !== 'string' ||
                typeof entry[1] !== 'string' ||
                !Array.isArray(entry[2])
            ) {
                return false;
            }
            this.bySource.set(entry[0], {
                id: languageIdOfUri(entry[0]),
                language: entry[1],
                declares: entry[3] === true,
                keys: new Map(entry[2]),
                links: (Array.isArray(entry[4]) ? entry[4] : []).map(([path, ref]) => ({ path, ref })),
            });
        }
        return true;
    }

    protected removeSource(source: string): void {
        this.bySource.delete(source);
    }

    protected indexDocument(document: AbstractNodeDocument): boolean {
        const source = normalizeUri(document.uri);
        const prior = this.bySource.get(source);
        this.bySource.delete(source);
        if (!isStringsDocument(document)) return prior !== undefined;
        const keys = new Map<string, string>();
        const links: KeyLink[] = [];
        for (const declaration of keyDeclarationsOf(document)) {
            if (declaration.text === undefined) continue;
            keys.set(declaration.path, declaration.text);
            // A reference leaf is a key of its own and a door to every key under what it points at.
            // Both halves are kept: the text is what the file writes, the link is what the game
            // walks through, and the two are put together per index revision rather than here,
            // because the file the link names is indexed on its own and can change without this one.
            if (isValueNode(declaration.node) && declaration.node.valueType.type === 'Reference')
                links.push({ path: declaration.path, ref: declaration.text });
        }
        const language = languageOf(document);
        const declares = declaresLanguage(document);
        if (keys.size) this.bySource.set(source, { id: languageIdOf(document), language, declares, keys, links });
        if (!prior) return keys.size > 0;
        if (prior.language !== language || prior.declares !== declares || prior.keys.size !== keys.size) return true;
        for (const [key, text] of keys) {
            if (prior.keys.get(key) !== text) return true;
        }
        return false;
    }

    /** The reference-resolved view of the index, memoized against the index revision. */
    private linkedMemo?: {
        revision: number;
        keysBySource: Map<string, ReadonlyMap<string, string>>;
        pulled: Set<string>;
    };

    /**
     * The index with every reference walked: each strings file's own keys plus the keys of what its
     * reference members point at, carried under the referring path, and the set of files that are
     * only reached that way.
     *
     * A file pulled in by a reference is a fragment, not a language. The game never opens it by
     * name, so its keys exist at the path the referring file gives them and nowhere else. Leaving it
     * out of the merged view is what keeps a key that only reads at the truncated path from
     * validating clean.
     *
     * Resolution happens here rather than while indexing, because the file a reference names is
     * indexed on its own and can be edited without the referring file moving. Keying the result on
     * the index revision means any edit to either side rebuilds it.
     *
     * @returns the resolved keys per source, and the sources that are only reached by a reference.
     */
    private linkedKeys(): { keysBySource: Map<string, ReadonlyMap<string, string>>; pulled: Set<string> } {
        if (this.linkedMemo?.revision === this.revision) return this.linkedMemo;
        const byFoldedUri = new Map<string, string>();
        for (const source of this.bySource.keys()) byFoldedUri.set(source.toLowerCase(), source);
        const keysBySource = new Map<string, ReadonlyMap<string, string>>();
        const pulled = new Set<string>();

        /** The file and the path inside it a reference written at `link.path` in `source` points at. */
        const targetOf = (source: string, link: KeyLink): { source: string; path: string } | undefined => {
            const file = FILE_REFERENCE.exec(link.ref);
            if (file) {
                const uri = siblingUri(source, file[1]);
                const target = uri && byFoldedUri.get(uri.toLowerCase());
                return target ? { source: target, path: file[2] ?? '' } : undefined;
            }
            const local = LOCAL_REFERENCE.exec(link.ref);
            if (!local) return undefined;
            // An unrooted reference names a member of the group the reference itself sits in, so
            // vanilla's `GameSetupScreen { CantStartTip = &CantReadyTip }` points at the sentence
            // beside it. Read from the file root it would point at nothing.
            const group = local[1] ? '' : link.path.slice(0, link.path.lastIndexOf('/') + 1);
            return { source, path: group + local[2] };
        };

        /** The keys of one file with its own references walked, `chain` guarding against a cycle. */
        const resolve = (source: string, chain: Set<string>): ReadonlyMap<string, string> => {
            const done = keysBySource.get(source);
            if (done) return done;
            const file = this.bySource.get(source);
            if (!file) return new Map();
            if (chain.has(source)) return file.keys;
            chain.add(source);
            const keys = new Map(file.keys);
            for (const link of file.links) {
                const target = targetOf(source, link);
                if (!target) continue;
                if (target.source !== source) pulled.add(target.source);
                const reached = target.source === source ? file.keys : resolve(target.source, chain);
                const wanted = target.path.toLowerCase();
                const branch = wanted ? `${wanted}/` : '';
                for (const [key, text] of reached) {
                    const folded = key.toLowerCase();
                    if (!wanted) keys.set(`${link.path}/${key}`, text);
                    else if (folded === wanted) keys.set(link.path, text);
                    else if (folded.startsWith(branch)) keys.set(`${link.path}/${key.slice(branch.length)}`, text);
                }
            }
            chain.delete(source);
            keysBySource.set(source, keys);
            return keys;
        };

        for (const source of this.bySource.keys()) resolve(source, new Set());
        this.linkedMemo = { revision: this.revision, keysBySource, pulled };
        return this.linkedMemo;
    }

    /**
     * The strings files the merged views read, each with its references walked. A file only reached
     * through a reference is left out, since its keys already appear under the path that reaches it.
     *
     * @returns one entry per contributing source, with the source uri, its indexed record and its
     * resolved keys.
     */
    private contributingSources(): Array<{ source: string; file: StringsFileKeys; keys: ReadonlyMap<string, string> }> {
        const { keysBySource, pulled } = this.linkedKeys();
        const out: Array<{ source: string; file: StringsFileKeys; keys: ReadonlyMap<string, string> }> = [];
        for (const [source, file] of this.bySource) {
            if (pulled.has(source)) continue;
            out.push({ source, file, keys: keysBySource.get(source) ?? file.keys });
        }
        return out;
    }

    private async ensureBuilt(folderPaths: string[], cancellationToken: CancellationToken): Promise<void> {
        await this.ensureFresh(
            (progress) => this.buildFromProject(folderPaths, progress),
            cancellationToken,
            'Indexing strings'
        );
    }

    /**
     * Completions for a value node that is a localization-key field, else `[]`. Gated internally (like
     * the cross-file id index) so an unrelated value stays cheap. The strings index only builds when
     * the cursor is actually on a `KeyString` field. A key is one slash-joined value, so each pick
     * replaces the whole written one rather than the part left of the caret.
     *
     * @param node the value node the caret is on.
     * @param folderPaths the project folders the strings index is built from.
     * @param cancellationToken cancellation for the index build.
     * @returns the project's keys, ranged onto the written value.
     */
    public async keyCompletionsForNode(
        node: AbstractNode,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<Completion[]> {
        const field = await fieldOfValueNode(node, cancellationToken).catch(() => undefined);
        if (!isLocalizationKeyType(field?.valueType)) return [];
        const keys = await this.allKeyCompletions(folderPaths, cancellationToken);
        return isValueNode(node) ? withValueEdit(keys, writtenValueRange(node)) : keys;
    }

    /**
     * Every localization key declared across the project's strings files, as completions.
     *
     * The sources take turns rather than being read out one after the other, because the list is
     * capped before it is sent and the game's own strings files come first in the index. Read in
     * index order the cap fell entirely inside vanilla's table, so a mod's own keys, the ones being
     * written, were never in the popup until most of the key had been typed.
     *
     * @param folderPaths the project folders the strings index is built from.
     * @param cancellationToken cancellation for the index build.
     * @returns one completion per distinct key, the sources interleaved.
     */
    public async allKeyCompletions(folderPaths: string[], cancellationToken: CancellationToken): Promise<Completion[]> {
        await this.ensureBuilt(folderPaths, cancellationToken);

        const readers = this.contributingSources().map((entry) => ({
            english: isEnglish(entry.file.language),
            rows: entry.keys[Symbol.iterator](),
        }));
        const offered = new Map<string, { item: CompletionSuggestion; english: boolean }>();
        const out: Completion[] = [];
        let reading = readers.length > 0;
        while (reading) {
            reading = false;
            for (const reader of readers) {
                const next = reader.rows.next();
                if (next.done) continue;
                reading = true;
                const [key, text] = next.value;
                const detail = text || 'localization key';
                const seen = offered.get(key);
                if (seen) {
                    // A key every language declares takes its text from the English one, which is
                    // the spelling the mod is written from. Without that the detail read as
                    // whichever language the walk happened to index first.
                    if (reader.english && !seen.english) {
                        seen.item.detail = detail;
                        seen.english = true;
                    }
                    continue;
                }
                // The translated text as `detail` lets the completion list read as key → meaning.
                const item: CompletionSuggestion = { label: key, kind: CompletionItemKind.Text, detail };
                offered.set(key, { item, english: reader.english });
                out.push(item);
            }
        }
        return out;
    }

    /** The merged key set (original and lowercased casing, plus the index-aligned suggestion pool),
     *  memoized against the index revision. The whole-workspace scan asks for all keys once per
     *  validated file, and re-merging (and re-lowercasing) tens of thousands of keys per file
     *  dominated the localization pass. */
    private allKeysMemo?: { revision: number; keys: Set<string>; keysLower: Set<string>; pool: MatchPool };

    /**
     * The merged key sets behind {@link allKeys}/{@link allKeysLower}/{@link allKeysMatchPool},
     * rebuilt only when the index content changed since the last call. Callers must not mutate
     * the returned sets.
     *
     * @param folderPaths the project folders the strings index is built from.
     * @param cancellationToken cancellation for the index build.
     * @returns the shared key set, its lowercased counterpart, and the suggestion pool.
     */
    private async mergedKeys(
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<{ keys: Set<string>; keysLower: Set<string>; pool: MatchPool }> {
        await this.ensureBuilt(folderPaths, cancellationToken);
        if (this.allKeysMemo && this.allKeysMemo.revision === this.revision) return this.allKeysMemo;
        const keys = new Set<string>();
        const keysLower = new Set<string>();
        for (const { keys: fileKeys } of this.contributingSources()) {
            for (const key of fileKeys.keys()) {
                keys.add(key);
                keysLower.add(key.toLowerCase());
            }
        }
        this.allKeysMemo = { revision: this.revision, keys, keysLower, pool: buildMatchPool(keys) };
        return this.allKeysMemo;
    }

    /** The set of every localization key declared in the project, for existence validation. The
     *  returned set is shared and must not be mutated. */
    public async allKeys(folderPaths: string[], cancellationToken: CancellationToken): Promise<Set<string>> {
        return (await this.mergedKeys(folderPaths, cancellationToken)).keys;
    }

    /** The lowercased counterpart of {@link allKeys}, for the game's case-insensitive key lookup.
     *  The returned set is shared and must not be mutated. */
    public async allKeysLower(folderPaths: string[], cancellationToken: CancellationToken): Promise<Set<string>> {
        return (await this.mergedKeys(folderPaths, cancellationToken)).keysLower;
    }

    /** The prepared did-you-mean pool over {@link allKeys}, in the same iteration order, so
     *  suggestion queries skip re-lowercasing the whole key set per broken key. */
    public async allKeysMatchPool(folderPaths: string[], cancellationToken: CancellationToken): Promise<MatchPool> {
        return (await this.mergedKeys(folderPaths, cancellationToken)).pool;
    }

    /**
     * The strings files that declare `path`, as normalized source uris. With `prefix` the answer
     * covers every key the path stands above, which is what a group rename moves. Matching folds
     * case, because the game keys a node's children with an invariant case-insensitive comparer and
     * vanilla itself relies on that (`doodad_asteroid_gold_s.rules` asks for `Doodads/Asteroidgold_S`
     * while the strings file spells it `AsteroidGold_S`).
     *
     * The rename uses this to see whether anything outside the mod being edited already declares the
     * key. The base game and another mod's strings cannot be written, so a key they also declare
     * cannot be renamed from here without leaving the two spellings out of step.
     *
     * @param path the key path, or the group path when `prefix` is set.
     * @param prefix whether every key beneath `path` counts, not just `path` itself.
     * @param folderPaths the project folders the strings index is built from.
     * @param cancellationToken cancellation for the index build.
     * @returns the normalized uris of the declaring strings files, in index order.
     */
    public async sourcesDeclaring(
        path: string,
        prefix: boolean,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<string[]> {
        await this.ensureBuilt(folderPaths, cancellationToken);
        const wanted = path.toLowerCase();
        const branch = `${wanted}/`;
        const sources: string[] = [];
        for (const [source, file] of this.bySource) {
            for (const key of file.keys.keys()) {
                const folded = key.toLowerCase();
                if (folded !== wanted && !(prefix && folded.startsWith(branch))) continue;
                sources.push(source);
                break;
            }
        }
        return sources;
    }

    /**
     * The language ids some strings file declares outright, which is the list the game's own picker
     * offers. A file whose name is one of them is loaded for that language wherever it sits, which
     * is what lets a mod translate a language another mod introduced.
     *
     * @returns the declared ids, folded to lower case.
     */
    private declaredLanguageIds(): Set<string> {
        const ids = new Set<string>();
        for (const file of this.bySource.values()) if (file.declares) ids.add(file.id);
        return ids;
    }

    /**
     * The language ids the project's strings files declare, which is the list the game's picker
     * offers. An id missing from it is a language the player cannot choose, however complete the
     * file behind it is.
     *
     * @param folderPaths the project folders the strings index is built from.
     * @param cancellationToken cancellation for the index build.
     * @returns the declared ids, folded to lower case.
     */
    public async declaredLanguages(
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<ReadonlySet<string>> {
        await this.ensureBuilt(folderPaths, cancellationToken);
        return this.declaredLanguageIds();
    }

    /**
     * Whether the game loads an indexed strings file as a language rather than leaving it unread.
     *
     * @param file the indexed strings file.
     * @param declaredIds the ids {@link declaredLanguageIds} collected.
     * @returns true when the file is one of the languages its folder ships.
     */
    private static isLanguage(file: StringsFileKeys, declaredIds: ReadonlySet<string>): boolean {
        return file.declares || declaredIds.has(file.id) || LANGUAGE_ID.test(file.id);
    }

    /**
     * What each language declares under one folder, for a reader comparing the languages a mod ships
     * against each other. {@link allKeys} merges every language into one set, which answers whether a
     * key exists anywhere and says nothing about the language that is missing it.
     *
     * Only the files the game loads as a language take part, keyed by the id it loads them under, so
     * a backup copy beside a translation is neither compared nor counted against it.
     *
     * @param rootPath the folder the strings files must sit under.
     * @param folderPaths the project folders the strings index is built from.
     * @param cancellationToken cancellation for the index build.
     * @returns one entry per language found under the folder, the fullest key set first.
     */
    public async coverageUnder(
        rootPath: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<LanguageKeyCoverage[]> {
        await this.ensureBuilt(folderPaths, cancellationToken);
        const prefix = `${normalizeUri(rootPath).replace(/\/+$/, '')}/`;
        const declaredIds = this.declaredLanguageIds();
        const byLanguage = new Map<string, { label: string; keys: Set<string>; source: string }>();
        for (const { source, file, keys } of this.contributingSources()) {
            if (!source.startsWith(prefix) || !LocalizationKeyIndex.isLanguage(file, declaredIds)) continue;
            const entry = byLanguage.get(file.id) ?? { label: file.language, keys: new Set<string>(), source };
            for (const key of keys.keys()) entry.keys.add(key);
            byLanguage.set(file.id, entry);
        }
        return [...byLanguage.values()]
            .map((entry) => ({ language: entry.label, keys: entry.keys, source: entry.source }))
            .sort((a, b) => b.keys.size - a.keys.size || a.language.localeCompare(b.language));
    }

    /**
     * What each language declares under one folder, with the translated text of every key. The
     * coverage view answers which keys a language is missing. Comparing the texts themselves, which
     * is what a placeholder check does, needs the strings as well.
     *
     * A language can be split across several files, and a later file overrides an earlier one the
     * way the game loads them, so the merged map holds the text the game renders. Only the files it
     * loads as a language are read, keyed by the id it loads them under.
     *
     * @param rootPath the folder the strings files must sit under.
     * @param folderPaths the project folders the strings index is built from.
     * @param cancellationToken cancellation for the index build.
     * @returns one entry per language found under the folder, in index order.
     */
    public async languageTextsUnder(
        rootPath: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<LanguageTexts[]> {
        await this.ensureBuilt(folderPaths, cancellationToken);
        const prefix = `${normalizeUri(rootPath).replace(/\/+$/, '')}/`;
        const declaredIds = this.declaredLanguageIds();
        const byId = new Map<string, { label: string; texts: Map<string, string> }>();
        for (const { source, file, keys } of this.contributingSources()) {
            if (!source.startsWith(prefix) || !LocalizationKeyIndex.isLanguage(file, declaredIds)) continue;
            const entry = byId.get(file.id) ?? { label: file.language, texts: new Map<string, string>() };
            byId.set(file.id, entry);
            for (const [key, text] of keys) entry.texts.set(key, text);
        }
        return [...byId].map(([id, entry]) => ({ id, label: entry.label, texts: entry.texts }));
    }

    /**
     * What one language already renders from outside `rootPath`: the texts the strings files of the
     * same id elsewhere declare. The game opens `<id>.rules` in every registered strings folder and
     * takes the last declaration of a key, so a mod's `en.rules` is merged over the base game's and
     * every key it leaves out still reaches the player.
     *
     * This is what keeps a mod language from being measured against a full copy of the base game's
     * table that happens to sit beside it.
     *
     * @param id the language id, as {@link languageIdOf} spells it.
     * @param rootPath the folder whose own strings files are left out.
     * @param folderPaths the project folders the strings index is built from.
     * @param cancellationToken cancellation for the index build.
     * @returns the key texts the language carries in from outside the folder.
     */
    public async inheritedTextsFor(
        id: string,
        rootPath: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<ReadonlyMap<string, string>> {
        await this.ensureBuilt(folderPaths, cancellationToken);
        const prefix = `${normalizeUri(rootPath).replace(/\/+$/, '')}/`;
        const texts = new Map<string, string>();
        for (const { source, file, keys } of this.contributingSources()) {
            if (file.id !== id || source.startsWith(prefix)) continue;
            for (const [key, text] of keys) texts.set(key, text);
        }
        return texts;
    }

    /** One source's keys folded to lower case, built on the first lookup that needs them. */
    private foldedMemo?: { revision: number; bySource: Map<string, ReadonlyMap<string, string>> };

    /**
     * One strings file's resolved keys, folded to lower case, for a lookup that has to match the way
     * the game matches. Built per source on demand and kept until the index changes, because the
     * whole strings tree folded is large and most lookups never need it.
     *
     * @param source the normalized source uri the keys belong to.
     * @param keys that source's resolved keys.
     * @returns the same texts under their lowercased key paths.
     */
    private foldedKeysOf(source: string, keys: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
        if (this.foldedMemo?.revision !== this.revision)
            this.foldedMemo = { revision: this.revision, bySource: new Map() };
        const done = this.foldedMemo.bySource.get(source);
        if (done) return done;
        const folded = new Map<string, string>();
        for (const [path, text] of keys) folded.set(path.toLowerCase(), text);
        this.foldedMemo.bySource.set(source, folded);
        return folded;
    }

    /**
     * The text of `key` in each language that declares it, one line per language, English first, for
     * hover. Empty when the key is undeclared. A language can declare a key in several strings files
     * (the base game splits English across files, and a mod can redeclare a vanilla key). The game
     * loads the game `Data` tree before the mod, so a later declaration overrides an earlier one.
     * {@link bySource} iterates in that same order, so keeping the last value seen per language makes
     * hover show the string the game actually renders, not the shadowed vanilla one.
     */
    public async textsForKey(
        key: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<LocalizationText[]> {
        await this.ensureBuilt(folderPaths, cancellationToken);
        const sources = this.contributingSources();
        const byLanguage = new Map<string, string>();
        for (const { file, keys } of sources) {
            const text = keys.get(key);
            if (text !== undefined) byLanguage.set(file.language, text);
        }
        // The game keys a node's children case-insensitively, and vanilla itself relies on it, so a
        // key that matches nothing as written is looked up again folded. Otherwise hover calls a key
        // undeclared that the membership check, which folds, deliberately passes. A key some
        // language spells exactly is answered from that language alone.
        if (byLanguage.size === 0) {
            const wanted = key.toLowerCase();
            for (const { source, file, keys } of sources) {
                const text = this.foldedKeysOf(source, keys).get(wanted);
                if (text !== undefined) byLanguage.set(file.language, text);
            }
        }
        const texts = [...byLanguage].map(([language, text]) => ({ language, text }));
        texts.sort((a, b) => Number(isEnglish(b.language)) - Number(isEnglish(a.language)));
        return texts;
    }
}
