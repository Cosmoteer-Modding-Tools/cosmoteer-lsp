import { CancellationToken } from 'vscode-languageserver';
import { join } from 'path';
import {
    AbstractNode,
    AbstractNodeDocument,
    isDocumentNode,
    isGroupNode,
    isListNode,
    ValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { documentRootClass } from '../../document/schema/document-root';
import { fieldOf, typeDef } from '../../document/schema/schema';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { ValueType } from '../../document/schema/schema.types';
import { isStringsFile } from '../../mod/strings-folder';
import { assignmentNameOf } from '../../utils/ast.utils';
import { closestMatch } from '../../utils/did-you-mean';
import { resolveAssetPath } from '../navigation/asset-resolver';
import { stringValueNodesOf } from '../navigation/schema-reference.navigation';
import { normalizeDir } from './asset-base-path';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { cachedReaddir } from '../../workspace/fs-cache';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/** What a path field names on disk. The wording of the finding is the only thing this decides. */
type PathKind = 'file' | 'folder';

/**
 * What each path-typed field names on disk, taken from the prose in `docs/fields`. Three of them
 * name a folder the game scans for whatever it finds inside, the rest name one file it loads.
 *
 * A path field the table does not name is left alone. That keeps a path field a code mod's own
 * assembly contributes out of the check, since how that mod's C# reads its path is nothing the
 * schema records. The table is pinned against the shipped schema in the tests, so a path field a
 * future game version adds fails there rather than going quietly unchecked.
 */
export const PATH_FIELD_KINDS: ReadonlyMap<string, PathKind> = new Map<string, PathKind>([
    // Folders the game scans, taking every `*.png` it finds inside them.
    ['rooftexturesfolders', 'folder'],
    ['folders', 'folder'],
    // The folder the game reads its built-in ship blueprints from.
    ['builtinshipsfolder', 'folder'],
    // Single files the game loads: a music track, a markov chain, a decal or background image, a
    // stasis icon, and a ship blueprint written under either of the two names it is written under.
    ['file', 'file'],
    ['filepath', 'file'],
    ['markovfile', 'file'],
    ['stasisicon', 'file'],
    ['decalfiles', 'file'],
    ['texturefiles', 'file'],
    ['ship', 'file'],
    ['logoship', 'file'],
]);

/** The class owning the fields of a member-bearing container (a group, or a whole-file-root document). */
const ownerClassOf = (container: AbstractNode): string | undefined =>
    isDocumentNode(container)
        ? documentRootClass(container)
        : isGroupNode(container)
          ? resolveGroupClass(container)
          : undefined;

/**
 * Whether a value type is a path the game resolves against the filesystem. The scalar form of a
 * class counts too: a ship blueprint field is typed as a `ShipFile`, and a bare value written for
 * one lands in that class's own path member.
 *
 * @param valueType the type to judge.
 * @returns true when a value written for this type is a path.
 */
const isPathType = (valueType: ValueType | undefined): boolean => {
    if (!valueType) return false;
    if (valueType.kind === 'string') return valueType.semantic === 'path';
    if (valueType.kind === 'group') {
        const valueForm = typeDef(valueType.ref)?.valueForm;
        return valueForm?.kind === 'string' && valueForm.semantic === 'path';
    }
    return false;
};

/**
 * The kind of path a value node is written for, or nothing when it is not a path at all. Two
 * positions are recognized, so that both spellings of a list field are read the way the game reads
 * them:
 *  - a direct field value, `MarkovFile = "latin.markov"`, and
 *  - a list element, `Folders = ["straights"]` and `DecalFiles [ glow1.png ]` alike, where the
 *    element type carries the path and the field name comes from the list rather than from a `=`.
 *
 * The written name is tested against {@link PATH_FIELD_KINDS} before any class is resolved, since
 * `File` alone is written thousands of times in the game tree and only a handful of those are paths.
 *
 * @param node the string value node to judge.
 * @returns the path kind, or undefined when the value is not written for a judged path field.
 */
const pathFieldKindOf = (node: ValueNode): PathKind | undefined => {
    const container = node.parent;
    if (!container) return undefined;
    const list = isListNode(container) ? container : undefined;
    const owner = list ? list.parent : container;
    if (!owner) return undefined;
    const name = list ? (list.identifier?.name ?? assignmentNameOf(list)) : assignmentNameOf(node);
    const kind = name ? PATH_FIELD_KINDS.get(name.toLowerCase()) : undefined;
    if (!name || !kind) return undefined;
    const ownerClass = ownerClassOf(owner);
    const valueType = ownerClass ? fieldOf(ownerClass, name)?.valueType : undefined;
    if (!valueType) return undefined;
    if (!list) return isPathType(valueType) ? kind : undefined;
    const listed =
        valueType.kind === 'list' || valueType.kind === 'range' || valueType.kind === 'interpolated'
            ? valueType.element
            : undefined;
    return isPathType(listed) ? kind : undefined;
};

/**
 * Whether this pass judges the written path at all. Three shapes are left alone because the game
 * reads them against something other than the folder the file sits in, and this pass has no reason
 * to assume it knows what that is. A rooted path and a `./` path are both read from the game's own
 * working directory, which is its install folder, so of those only the `./Data/` spelling is judged,
 * and only once the game folder is known. A backslash is a separator on Windows and an ordinary
 * character in a filename elsewhere, so what a value carrying one names depends on where it is read.
 *
 * A value written without quotes that carries whitespace is left alone as well. The game reads
 * everything up to the end of the line as one value there, so what is written is a quoting problem
 * rather than a missing file, and reporting the joined text as a missing file reads as noise.
 *
 * @param node the value node the path is written on.
 * @param written the trimmed written path.
 * @returns true when the path is judged.
 */
const isJudgedPath = (node: ValueNode, written: string): boolean => {
    if (written.includes('\\')) return false;
    if (!node.quoted && /\s/.test(written)) return false;
    if (written.startsWith('/') || /^[a-zA-Z]:/.test(written)) return false;
    if (/^\.\/data\//i.test(written)) return !!CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath;
    return !written.startsWith('./');
};

/**
 * The folder the written path's last segment is looked for in.
 *
 * @param uri the URI of the file the path is written in.
 * @param written the written path.
 * @returns the absolute folder path.
 */
const targetDirOf = (uri: string, written: string): string => {
    const fromGameFolder = /^\.\/data\//i.test(written);
    const relative = fromGameFolder ? written.replace(/^\.\/data\//i, '') : written;
    const lastSlash = relative.lastIndexOf('/');
    const subDir = lastSlash >= 0 ? relative.slice(0, lastSlash) : '';
    const base = fromGameFolder ? CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath : normalizeDir(uri);
    return join(base, subDir);
};

/**
 * For a path that is not on disk, the closest-named entry of the expected kind that is, returned as
 * the whole corrected value with only its last segment swapped, or null when nothing is close
 * enough. Only an entry of the expected kind is offered, so a folder field is never answered with a
 * file. Among those, the entries carrying the written extension are preferred, which keeps a missing
 * `.music` track from being answered with the `.rules` file lying next to it, and the whole set is
 * fallen back on when none carries it, which is what makes a mistyped extension correctable.
 *
 * @param uri the URI of the file the path is written in.
 * @param written the written path.
 * @param kind whether a file or a folder is expected.
 * @returns the corrected value, or null when nothing fits.
 */
const suggestPathName = async (uri: string, written: string, kind: PathKind): Promise<string | null> => {
    const lastSlash = written.lastIndexOf('/');
    const basename = lastSlash >= 0 ? written.slice(lastSlash + 1) : written;
    const dot = basename.lastIndexOf('.');
    const extension = dot > 0 ? basename.slice(dot).toLowerCase() : '';

    const names = new Set<string>();
    const sameExtension = new Set<string>();
    try {
        for (const entry of await cachedReaddir(targetDirOf(uri, written))) {
            // A mod folder reaches the game tree through a junction, which Node reports as a
            // symbolic link rather than as a directory, so a link answers for either expectation.
            const fits = entry.isSymbolicLink() || (kind === 'folder' ? entry.isDirectory() : entry.isFile());
            if (!fits) continue;
            names.add(entry.name);
            if (extension && entry.name.toLowerCase().endsWith(extension)) sameExtension.add(entry.name);
        }
    } catch {
        // The folder the path leads through is not on disk either, so there is nothing to suggest.
    }
    const suggestion = closestMatch(basename, sameExtension.size ? sameExtension : names, true);
    return suggestion ? written.slice(0, written.length - basename.length) + suggestion : null;
};

/**
 * Whole-document pass over the path-shaped values the asset check cannot reach. That check
 * recognizes an asset by its extension, so a music track, a markov name file and the folders a
 * texture set or a ship library is read from all go unchecked, even though the game resolves every
 * one of them against the filesystem while it loads.
 *
 * The path is resolved the way the game resolves it, against the folder of the file it is written
 * in, with every segment compared without regard to letter case, since the game reads through a
 * filesystem that ignores it. A `./Data/` path is read from the game's own folder instead. The check
 * proves existence and nothing else, the way the manifest check does, so a folder written where a
 * file belongs is reported by neither.
 *
 * Strings files are exempt, since their values are display text: a line whose key happens to be
 * `Ship` is prose, not a blueprint path.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels between the directory walks.
 * @returns one warning per written path that is not on disk.
 */
export const validatePathValues = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    if (await isStringsFile(document.uri, cancellationToken).catch(() => false)) return [];

    // Only a string-typed value can be an unchecked path: the parser types a value carrying a known
    // asset extension as a sprite, a sound or a shader, and the value validator resolves those. The
    // restriction comes first, so the name test runs over a handful of nodes rather than all of them.
    const candidates: Array<{ node: ValueNode; written: string; kind: PathKind }> = [];
    for (const value of stringValueNodesOf(document)) {
        const written = String(value.valueType.value).trim();
        if (!written) continue;
        const kind = pathFieldKindOf(value);
        if (!kind || !isJudgedPath(value, written)) continue;
        candidates.push({ node: value, written, kind });
    }
    if (candidates.length === 0) return [];

    const errors: ValidationError[] = [];
    for (const { node, written, kind } of candidates) {
        if (cancellationToken.isCancellationRequested) return errors;
        // A resolution that throws answers "found", which keeps the pass silent rather than guessing.
        if (await resolveAssetPath(node, document.uri, cancellationToken).catch(() => 'found')) continue;
        const suggestion = await suggestPathName(document.uri, written, kind).catch(() => null);
        const info = [
            /^\.\/data\//i.test(written) ? '' : l10n.t('The path is read relative to the folder this file is in'),
            suggestion ? l10n.t('Did you mean "{0}"?', suggestion) : '',
        ]
            .filter(Boolean)
            .join(' ');
        errors.push({
            message:
                kind === 'folder'
                    ? l10n.t('The folder "{0}" does not exist', written)
                    : l10n.t('The file "{0}" does not exist', written),
            node,
            // The game throws on some of these while it loads and quietly draws nothing for others,
            // and a mod may also ship the target outside the folders the editor can see, so the
            // finding stays a warning rather than a hard error.
            severity: 'warning',
            ...(info ? { additionalInfo: info } : {}),
            ...(suggestion
                ? { data: { quickFix: { title: l10n.t('Change to "{0}"', suggestion), newText: suggestion } } }
                : {}),
        });
    }
    return errors;
};
