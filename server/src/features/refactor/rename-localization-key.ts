import { readFile } from 'fs/promises';
import { CancellationToken, Position, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, IdentifierNode, isValueNode, ValueNode } from '../../core/ast/ast';
import { isLocalizationKeyType, localizationKeyFieldNames } from '../../document/schema/schema';
import { assignmentNameOf, findNodeAtPosition, getStartOfAstNode, parseText } from '../../utils/ast.utils';
import { CancellationError } from '../../utils/cancellation';
import { ParserResultRegistrar } from '../../registrar/parser-result-registrar';
import { fieldOfValueNode } from '../completion/autocompletion.schema';
import { isStringsDocument, keyDeclarationsOf, LocalizationKeyIndex } from '../completion/localization-key.index';
import { modStringsFiles } from '../diagnostics/localization-key-insert';
import { findModRoot } from '../../mod/mod-root';
import { isUnderFolder } from '../../mod/strings-folder';
import { MentionIndex } from '../navigation/mention.index';
import { filePathToUri } from '../navigation/navigation-strategy';
import { normalizeUri } from '../navigation/reference-location';
import { stringValueNodesOf } from '../navigation/schema-reference.navigation';
import { collectRulesFiles, modFolderPaths, readFilesAhead, uriToFsPath } from '../navigation/workspace-files';
import * as l10n from '@vscode/l10n';

/**
 * Why a rename was turned down. The message is written for the author, so an editor that surfaces the
 * request error tells them what stands in the way instead of the generic "this cannot be renamed".
 */
export class RenameRefusedError extends Error {
    /**
     * @param message the reason to show the author.
     */
    constructor(message: string) {
        super(message);
        this.name = 'RenameRefusedError';
    }
}

/** What a localization-key rename rewrites: one segment of a key path, everywhere it is written. */
interface LocalizationKeyRenameTarget {
    /** The key path down to the segment being renamed (`Parts/Foo`, or `Parts` for a group). */
    path: string;
    /** The segment's current text, which the new name replaces. */
    segment: string;
    /** How many segments come before the one being renamed, which is where it sits in a written key. */
    segmentIndex: number;
    /** True when the path names a group, so every key beneath it moves along with the rename. */
    isPrefix: boolean;
    /** The segment's span in the document the rename was started from. */
    range: Range;
}

/**
 * What a segment of a localization key may be called. The game resolves a key by walking the path one
 * segment at a time, and a segment that is all digits addresses a list position while `.`, `..`, `^`
 * and `~` are navigation steps, so any of those stops being a name and sends the lookup elsewhere.
 * Every key segment the base game ships is inside this charset.
 */
const VALID_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A `/`-delimited segment of a key path and its character span within the written key. */
interface KeySegment {
    text: string;
    start: number;
    end: number;
}

/** Split a written key into its `/`-delimited segments, each with its offset inside the key. */
const keySegmentsOf = (key: string): KeySegment[] => {
    const segments: KeySegment[] = [];
    const regex = /[^/]+/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(key)) !== null) {
        segments.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    }
    return segments;
};

/** The document range covering an identifier's text. */
const identifierRange = (node: IdentifierNode): Range => {
    const { line, characterStart, characterEnd } = node.position;
    return Range.create(line, characterStart, line, characterEnd);
};

/** Whether `position` sits within the node span `span`, its closing character included. */
const covers = (span: AbstractNode['position'], position: Position): boolean =>
    position.line === span.line && position.character >= span.characterStart && position.character <= span.characterEnd;

/**
 * The character offset on the line where a value's written text begins, or undefined when the value
 * is not one plain run of source text. A quoted value's span takes in its quotes, and a value
 * assembled from several pieces (a `\` continuation, a concatenation, a verbatim `@"…"` string) has
 * text that no longer lines up with the span it was read from. Renaming one segment of such a value
 * would write over the wrong characters, so those are left alone instead.
 *
 * @param node the string value node the key is written in.
 * @returns the offset the key's first character sits at, or undefined when it cannot be measured.
 */
const literalContentStart = (node: ValueNode): number | undefined => {
    const { characterStart, characterEnd, start, end } = node.position;
    const width = characterEnd - characterStart;
    // A span whose byte width differs from its character width covers more than one line.
    if (end - start !== width) return undefined;
    const written = String(node.valueType.value);
    if (node.quoted) return width === written.length + 2 ? characterStart + 1 : undefined;
    return width === written.length ? characterStart : undefined;
};

/**
 * The rename target for a caret inside a strings file: the key name it sits on. Anything else in such
 * a file is turned down rather than handed to the general member rename, which would rewrite the key
 * in this one language file and leave every other language, and every field pointing at it, behind.
 *
 * @param document the parsed strings file.
 * @param position the caret position.
 * @returns the target under the caret.
 */
const declarationTargetAt = (document: AbstractNodeDocument, position: Position): LocalizationKeyRenameTarget => {
    const declarations = [...keyDeclarationsOf(document)];
    for (const declaration of declarations) {
        if (!declaration.nameNode || !covers(declaration.nameNode.position, position)) continue;
        if (!VALID_SEGMENT.test(declaration.nameNode.name)) {
            throw new RenameRefusedError(
                l10n.t(
                    '"{0}" is not a plain name, so the game does not read it as one step of a key path.',
                    declaration.nameNode.name
                )
            );
        }
        return {
            path: declaration.path,
            segment: declaration.nameNode.name,
            segmentIndex: declaration.path.split('/').length - 1,
            isPrefix: declaration.text === undefined,
            range: identifierRange(declaration.nameNode),
        };
    }
    // A list entry is found by its position, so there is no name anywhere to rewrite. Renaming it
    // would mean moving the entry, which changes what every entry after it is called.
    const listEntry = declarations.some((d) => d.listIndex !== undefined && covers(d.node.position, position));
    if (listEntry) {
        throw new RenameRefusedError(
            l10n.t('This string is found by its position in the list, so it has no name that can be renamed.')
        );
    }
    throw new RenameRefusedError(l10n.t('Put the caret on the name of a localization key to rename it.'));
};

/**
 * The rename target for a caret inside a written key (`NameKey = "Parts/Foo"`): the path segment the
 * caret sits on. A caret before the last segment renames the group, the same as starting from the
 * group's own line in the strings file.
 *
 * @param node the string value the key is written in.
 * @param position the caret position.
 * @returns the target under the caret, or undefined when the caret is on no segment.
 */
const usageTargetAt = (node: ValueNode, position: Position): LocalizationKeyRenameTarget | undefined => {
    const written = String(node.valueType.value);
    if (!written.trim()) return undefined;
    const base = literalContentStart(node);
    if (base === undefined) {
        throw new RenameRefusedError(
            l10n.t('This value is not written as one plain piece of text, so the key inside it cannot be renamed.')
        );
    }
    // Any padding stays where it is, so the segment offsets are measured from the key itself.
    const lead = written.length - written.trimStart().length;
    const segments = keySegmentsOf(written.trim());
    const relative = position.character - base - lead;
    const index = segments.findIndex((segment) => relative >= segment.start && relative <= segment.end);
    if (index < 0) return undefined;
    const segment = segments[index];
    if (!VALID_SEGMENT.test(segment.text)) {
        throw new RenameRefusedError(
            l10n.t('"{0}" is not a plain name, so the game does not read it as one step of a key path.', segment.text)
        );
    }
    return {
        path: segments
            .slice(0, index + 1)
            .map((each) => each.text)
            .join('/'),
        segment: segment.text,
        segmentIndex: index,
        isPrefix: index < segments.length - 1,
        range: Range.create(
            node.position.line,
            base + lead + segment.start,
            node.position.line,
            base + lead + segment.end
        ),
    };
};

/**
 * The localization key the caret sits on, from either side: the name a strings file declares, or a
 * segment of a key a `KeyString` field is pointed at. Returns undefined when the caret is on neither,
 * which is what lets the other rename kinds take over. Throws a {@link RenameRefusedError} when the
 * caret is on a key that cannot be renamed, so the author is told why rather than left with a rename
 * that quietly does the wrong thing.
 *
 * @param document the parsed document the caret is in.
 * @param position the caret position.
 * @param cancellationToken cancellation for the schema lookup that confirms the field.
 * @returns the target, or undefined when this is not a localization-key rename.
 */
export const localizationKeyRenameTargetAt = async (
    document: AbstractNodeDocument,
    position: Position,
    cancellationToken: CancellationToken
): Promise<LocalizationKeyRenameTarget | undefined> => {
    if (isStringsDocument(document)) return declarationTargetAt(document, position);

    const node = findNodeAtPosition(document, position);
    if (!node || !isValueNode(node) || node.valueType.type !== 'String') return undefined;
    // Cheap pre-filter by field name, so the schema resolution only runs where a key can live.
    const name = assignmentNameOf(node);
    if (!name || !localizationKeyFieldNames().has(name.toLowerCase())) return undefined;
    const field = await fieldOfValueNode(node, cancellationToken).catch(() => undefined);
    if (!isLocalizationKeyType(field?.valueType)) return undefined;
    return usageTargetAt(node, position);
};

/**
 * Every project document whose raw text mentions `needle`, matched without regard to case. The game
 * resolves a key path one case-insensitive step at a time, so a field may point at `Doodads/Foo`
 * while the strings file spells it `doodads/foo`, and a case-sensitive filter would never even read
 * that file. Candidate files come from the word index, which already folds case, and every candidate
 * is re-read and checked before it is parsed, so the pre-filter can only save work and never change
 * which documents are found. Open buffers are yielded unfiltered, so unsaved edits are included.
 *
 * @param folderPaths the folders to search.
 * @param needle the text a file must contain to be worth parsing.
 * @param cancellationToken cancels the search.
 * @returns each parsed document that may write the key.
 */
async function* documentsMentioningFolded(
    folderPaths: string[],
    needle: string,
    cancellationToken: CancellationToken
): AsyncGenerator<AbstractNodeDocument> {
    const seen = new Set<string>();
    for (const document of ParserResultRegistrar.instance.allResults()) {
        const norm = normalizeUri(document.uri);
        if (seen.has(norm)) continue;
        seen.add(norm);
        yield document;
    }
    const candidates = await MentionIndex.instance
        .candidateFiles(needle, folderPaths, cancellationToken)
        .catch(() => undefined);
    let toRead: string[];
    if (candidates) {
        toRead = candidates.filter((file) => !seen.has(normalizeUri(file)));
    } else {
        // Not a pure-word needle (or the index failed): fall back to walking every folder file.
        toRead = [];
        for (const folder of folderPaths) {
            for await (const file of collectRulesFiles(uriToFsPath(folder))) {
                if (cancellationToken.isCancellationRequested) throw new CancellationError();
                const norm = normalizeUri(file);
                if (seen.has(norm)) continue;
                seen.add(norm);
                toRead.push(file);
            }
        }
    }
    const folded = needle.toLowerCase();
    for await (const { file, text } of readFilesAhead(toRead)) {
        if (cancellationToken.isCancellationRequested) throw new CancellationError();
        if (text === undefined || !text.toLowerCase().includes(folded)) continue;
        // One unparseable file must not abort the whole sweep, the same way find-all-references
        // skips it rather than losing every other hit in the project.
        try {
            yield parseText(text, file);
        } catch {
            /* unparseable, skip */
        }
    }
}

/** Drop duplicate edits within each file, so a document reached twice contributes one rewrite. */
const dedupeEdits = (changes: { [uri: string]: TextEdit[] }): void => {
    for (const uri of Object.keys(changes)) {
        const seen = new Set<string>();
        changes[uri] = changes[uri].filter((edit) => {
            const key = `${edit.range.start.line}:${edit.range.start.character}-${edit.range.end.line}:${edit.range.end.character}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
};

/** The path a key ends up at once its `segmentIndex`th segment is called `newName`. */
const renamedPath = (target: LocalizationKeyRenameTarget, newName: string): string => {
    const segments = target.path.split('/');
    segments[target.segmentIndex] = newName;
    return segments.join('/');
};

/**
 * Whether `written` is the key being renamed, or one of the keys below it when a group is renamed.
 * Compared segment by segment, so renaming `Doodads` never touches `OtherDoodads`, and folded,
 * because the game finds a key regardless of how its path is capitalized.
 *
 * @param written the key a field is pointed at.
 * @param target the key segment being renamed.
 * @returns true when the field has to be rewritten.
 */
const writesTarget = (written: string, target: LocalizationKeyRenameTarget): boolean => {
    const folded = written.toLowerCase();
    const wanted = target.path.toLowerCase();
    if (folded === wanted) return true;
    return target.isPrefix && folded.startsWith(`${wanted}/`);
};

/**
 * The whole rename as one edit: the key's declaration rewritten in every language file the mod ships,
 * plus every `KeyString` field in the project that points at it. Renaming a group rewrites the group's
 * own name and leaves the keys beneath it alone, since only the shared first part of their paths
 * changes.
 *
 * A language file that does not declare the key contributes nothing, which is the normal state of a
 * half-translated mod. Every language that does declare it has to be rewritten though: the game falls
 * back to the English file when a key is missing, so rewriting only some of them leaves English
 * readers looking at the raw path and everyone else at the English text.
 *
 * @param target the key segment being renamed.
 * @param newName the segment's new spelling.
 * @param documentUri the file the rename was started from, which decides the mod being edited.
 * @param folderPaths the project folders to search for fields pointing at the key.
 * @param cancellationToken cancels the search.
 * @param readOverride the unsaved text of an open strings file, preferred over its bytes on disk.
 * @returns the edit to apply.
 */
export const buildLocalizationKeyRenameEdit = async (
    target: LocalizationKeyRenameTarget,
    newName: string,
    documentUri: string,
    folderPaths: string[],
    cancellationToken: CancellationToken,
    readOverride?: (absPath: string) => string | undefined
): Promise<WorkspaceEdit> => {
    if (!VALID_SEGMENT.test(newName)) {
        throw new RenameRefusedError(
            l10n.t('A localization key name has to start with a letter and hold only letters, digits and underscores.')
        );
    }

    const files = await modStringsFiles(documentUri, cancellationToken).catch(() => []);
    if (files.length === 0) {
        throw new RenameRefusedError(
            l10n.t('This file is not inside a mod that ships language files, so there is no declaration to rename.')
        );
    }

    const changes: { [uri: string]: TextEdit[] } = {};
    const add = (uri: string, range: Range, text: string): void => {
        (changes[uri] ??= []).push(TextEdit.replace(range, text));
    };

    // The declarations, one language file at a time. The mod's own files are the only ones this can
    // write, which is what keeps the read-only game install out of every rename.
    const own = new Set(files.map((file) => normalizeUri(file)));
    let declared = false;
    for (const file of files) {
        if (cancellationToken.isCancellationRequested) throw new CancellationError();
        const text = readOverride?.(file) ?? (await readFile(file, 'utf-8').catch(() => undefined));
        if (text === undefined) continue;
        let document: AbstractNodeDocument;
        try {
            document = parseText(text, file);
        } catch {
            continue;
        }
        for (const declaration of keyDeclarationsOf(document)) {
            if (!declaration.nameNode || declaration.path.toLowerCase() !== target.path.toLowerCase()) continue;
            declared = true;
            add(filePathToUri(file), identifierRange(declaration.nameNode), newName);
        }
    }
    // A key the base game or another mod also declares cannot be renamed from here: those files are
    // not this mod's to write, and rewriting only this mod's half would leave the game finding the
    // old key in one place and the new one in the other. Checked before the mod's own declaration,
    // so a mod merely using somebody else's key is told whose it is.
    const sources = await LocalizationKeyIndex.instance
        .sourcesDeclaring(target.path, target.isPrefix, folderPaths, cancellationToken)
        .catch(() => [] as string[]);
    const foreign = sources.find((source) => !own.has(source));
    if (foreign) {
        throw new RenameRefusedError(
            l10n.t('"{0}" is also declared in "{1}", which this rename cannot change.', target.path, foreign)
        );
    }
    if (!declared) {
        throw new RenameRefusedError(
            l10n.t('No language file of this mod declares "{0}", so there is nothing to rename.', target.path)
        );
    }

    // Renaming onto a path that is already in use would merge two strings into one with nothing to
    // show for it, so it is turned down. The whole branch under the new path counts, since a key and
    // a group cannot share a name. A change of capitalization is the one safe case, because the game
    // reads both spellings as the same key anyway.
    if (newName.toLowerCase() !== target.segment.toLowerCase()) {
        const taken = renamedPath(target, newName).toLowerCase();
        const keysLower = await LocalizationKeyIndex.instance
            .allKeysLower(folderPaths, cancellationToken)
            .catch(() => new Set<string>());
        for (const key of keysLower) {
            if (key !== taken && !key.startsWith(`${taken}/`)) continue;
            throw new RenameRefusedError(
                l10n.t('"{0}" is already used by another localization key.', renamedPath(target, newName))
            );
        }
    }

    // The fields pointing at the key. The search skips the game tree, which is read-only, and the
    // rewrite stays inside the mod that declares the key: another mod's files are not this one's to
    // change, and the mod being edited is the whole of what an author expects a rename to touch.
    const modRoot = findModRoot(documentUri);
    const searchFolders = modFolderPaths(folderPaths);
    const fieldNames = localizationKeyFieldNames();
    for await (const document of documentsMentioningFolded(
        searchFolders.length > 0 ? searchFolders : folderPaths,
        target.path,
        cancellationToken
    )) {
        // A strings file holds the declarations, which were rewritten above. Its values are display
        // text, never a key pointing anywhere.
        if (isStringsDocument(document)) continue;
        if (modRoot && !isUnderFolder(document.uri, modRoot)) continue;
        for (const node of stringValueNodesOf(document)) {
            if (cancellationToken.isCancellationRequested) throw new CancellationError();
            const written = String(node.valueType.value);
            const trimmed = written.trim();
            if (!trimmed || !writesTarget(trimmed, target)) continue;
            const name = assignmentNameOf(node);
            if (!name || !fieldNames.has(name.toLowerCase())) continue;
            const field = await fieldOfValueNode(node, cancellationToken).catch(() => undefined);
            if (!isLocalizationKeyType(field?.valueType)) continue;
            const base = literalContentStart(node);
            if (base === undefined) continue;
            const lead = written.length - written.trimStart().length;
            const segment = keySegmentsOf(trimmed)[target.segmentIndex];
            if (!segment) continue;
            add(
                filePathToUri(getStartOfAstNode(node).uri),
                Range.create(
                    node.position.line,
                    base + lead + segment.start,
                    node.position.line,
                    base + lead + segment.end
                ),
                newName
            );
        }
    }

    dedupeEdits(changes);
    return { changes };
};
