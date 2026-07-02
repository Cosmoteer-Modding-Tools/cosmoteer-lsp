import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isGroupNode, isValueNode } from '../../core/ast/ast';
import { namedMembersOf } from '../../utils/ast.utils';
import { isLocalizationKeyType } from '../../document/schema/schema';
import { normalizeUri } from '../navigation/reference-location';
import { WatchedDocumentIndex } from '../navigation/watched-document-index';
import { Completion } from './autocompletion.service';
import { fieldOfValueNode } from './autocompletion.schema';

/** A `strings/` (or `Strings/`) path segment — the reliable convention for language files. */
const STRINGS_PATH_SEGMENT = /(^|\/)strings\//;

/** One key's text in one language. */
export interface LocalizationText {
    /** The language label (`__Name`, e.g. `English`, or the file basename as a fallback). */
    language: string;
    /** The translated text for the key. */
    text: string;
}

/** The keys one strings file declares, tagged with its language. */
interface StringsFileKeys {
    language: string;
    /** key path (`Misc/Okay`) → its translated text. */
    keys: Map<string, string>;
}

/**
 * Whether `document` is a language strings file, whose leaf keys are localization keys. Two cheap
 * synchronous signals cover the field: a `strings/` path segment (the base game's `Data/strings` and
 * almost every mod) and a top-level `__Name` member (the required first line of a strings file, which
 * catches a mod placing them in a differently-named folder). Deliberately avoids the async
 * `StringsFolder` resolution `isStringsFile` does — this runs against every project file during the
 * one-time build, so it must not re-read manifests per file.
 */
const isStringsDocument = (document: AbstractNodeDocument): boolean =>
    STRINGS_PATH_SEGMENT.test(normalizeUri(document.uri)) ||
    namedMembersOf(document).some(([name]) => name === '__Name');

/** The language label of a strings file: its `__Name` value, else its basename without extension. */
const languageOf = (document: AbstractNodeDocument): string => {
    for (const [name, value] of namedMembersOf(document)) {
        if (name === '__Name' && isValueNode(value)) return String(value.valueType.value);
    }
    return normalizeUri(document.uri).split('/').pop()?.replace(/\.rules$/, '') ?? '';
};

/**
 * Collect the localization key paths a strings container declares into `out`. A key is the
 * slash-joined path from the file root to a leaf value (`Misc` group → `Okay` leaf → `Misc/Okay`),
 * mapped to that leaf's text. Meta members (`__Name`, `__DebugOnly`) are engine directives, not keys.
 */
const collectKeys = (container: { elements: AbstractNode[] }, prefix: string, out: Map<string, string>): void => {
    for (const [name, value] of namedMembersOf(container)) {
        if (name.startsWith('__')) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (isGroupNode(value)) collectKeys(value, path, out);
        else if (isValueNode(value)) out.set(path, String(value.valueType.value));
    }
};

/** English-ish languages sort first in hover output so the most-read text leads. */
const isEnglish = (language: string): boolean => /^en\b|english/i.test(language);

/**
 * Project-wide index of localization keys — the data behind strings-key completion, existence
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
        return [...this.bySource.entries()].map(([source, file]) => [source, file.language, [...file.keys.entries()]]);
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
        for (const entry of state as Array<[string, string, Array<[string, string]>]>) {
            if (
                !Array.isArray(entry) ||
                typeof entry[0] !== 'string' ||
                typeof entry[1] !== 'string' ||
                !Array.isArray(entry[2])
            ) {
                return false;
            }
            this.bySource.set(entry[0], { language: entry[1], keys: new Map(entry[2]) });
        }
        return true;
    }

    protected removeSource(source: string): void {
        this.bySource.delete(source);
    }

    protected indexDocument(document: AbstractNodeDocument): void {
        const source = normalizeUri(document.uri);
        this.bySource.delete(source);
        if (!isStringsDocument(document)) return;
        const keys = new Map<string, string>();
        collectKeys(document, '', keys);
        if (keys.size) this.bySource.set(source, { language: languageOf(document), keys });
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
     * the cross-file id index) so an unrelated value stays cheap — the strings index only builds when
     * the cursor is actually on a `KeyString` field.
     */
    public async keyCompletionsForNode(
        node: AbstractNode,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<Completion[]> {
        const field = await fieldOfValueNode(node, cancellationToken).catch(() => undefined);
        if (!isLocalizationKeyType(field?.valueType)) return [];
        return this.allKeyCompletions(folderPaths, cancellationToken);
    }

    /** Every localization key declared across the project's strings files, as completions. */
    public async allKeyCompletions(
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<Completion[]> {
        await this.ensureBuilt(folderPaths, cancellationToken);

        const seen = new Set<string>();
        const out: Completion[] = [];
        for (const { keys } of this.bySource.values()) {
            for (const [key, text] of keys) {
                if (seen.has(key)) continue;
                seen.add(key);
                // The translated text as `detail` lets the completion list read as key → meaning.
                out.push({ label: key, kind: CompletionItemKind.Text, detail: text || 'localization key' });
            }
        }
        return out;
    }

    /** The set of every localization key declared in the project — for existence validation. */
    public async allKeys(folderPaths: string[], cancellationToken: CancellationToken): Promise<Set<string>> {
        await this.ensureBuilt(folderPaths, cancellationToken);
        const keys = new Set<string>();
        for (const { keys: fileKeys } of this.bySource.values()) {
            for (const key of fileKeys.keys()) keys.add(key);
        }
        return keys;
    }

    /**
     * The text of `key` in each language that declares it, English first — for hover. Empty when the
     * key is undeclared.
     */
    public async textsForKey(
        key: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<LocalizationText[]> {
        await this.ensureBuilt(folderPaths, cancellationToken);
        const texts: LocalizationText[] = [];
        for (const { language, keys } of this.bySource.values()) {
            const text = keys.get(key);
            if (text !== undefined) texts.push({ language, text });
        }
        texts.sort((a, b) => Number(isEnglish(b.language)) - Number(isEnglish(a.language)));
        return texts;
    }
}
