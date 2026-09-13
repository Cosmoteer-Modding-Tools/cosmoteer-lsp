import { resolve } from 'path';
import { AbstractNode, AbstractNodeDocument, isListNode, isValueNode, ValueNode } from '../../../core/ast/ast';
import { basenameOf } from '../../../document/document-kind';
import { ActionSource } from '../../../mod/action';
import { parseModActions } from '../../../mod/action-parser';
import { normalizeTargetPath } from '../../../mod/action-target-resolver';
import { namedMembersOf } from '../../../utils/ast.utils';
import { foldPathCase } from '../../../workspace/fs-cache';
import { relativeRulesReference } from '../shared-base/base-file.emitter';
import { dirOf, readRulesFile, resolveBasePath } from '../shared-base/base-index';
import { manifestsIn } from '../register-part/ship-registry';

/**
 * Registering a created file in one of the game's own top-level lists, through an `AddMany` action
 * in the mod's manifest.
 *
 * The ship route is not here: registering a part in a ship is the shipped register-part command's
 * work, and this command hands off to it rather than re-emitting anything. What is here is the same
 * exchange for the lists a mod cannot reach any other way, resources today and any other
 * `<file>/List` the game root names tomorrow. The target is read off the game root rather than
 * hardcoded, since the game root is the file that says where a registry lives: `cosmoteer.rules`
 * writes `Resources = &<resources/resources.rules>/Resources`, and that reference, sigil removed, is
 * exactly the path an action target has to name. The logo ship takes the same road with a `Replace`
 * instead of an `AddMany`, since the title screen reads one value rather than a list.
 */

/** How a manifest can fail to take a new action entry. */
export type ManifestChoice =
    | { readonly kind: 'manifest'; readonly fsPath: string }
    | { readonly kind: 'none' }
    | { readonly kind: 'ambiguous'; readonly manifests: string[] };

/**
 * The manifest an entry goes into: the one named `mod.rules`, or the mod's only one.
 *
 * A version split mod (`mod_0.30.rules` beside `mod_0.29.rules`) needs the author to say which
 * variants get the entry, so it is refused rather than guessed at.
 *
 * @param manifests the mod's manifests.
 * @returns the manifest, or undefined when the choice belongs to the author.
 */
export const manifestToWrite = (manifests: readonly string[]): string | undefined => {
    const named = manifests.find((path) => basenameOf(path).toLowerCase() === 'mod.rules');
    return named ?? (manifests.length === 1 ? manifests[0] : undefined);
};

/**
 * The manifest a registration is written into: the plain `mod.rules` when the mod ships one, and the
 * only manifest when it ships exactly one under another name.
 *
 * A version-split mod (`mod_0.30.rules` beside `mod_0.29.rules`) is refused. Which variants a new
 * part belongs in is a decision only the author can make, and writing into one of them silently
 * would leave the mod half registered on the game versions the other one covers.
 *
 * @param modRoot the mod whose manifest is wanted.
 * @returns the manifest, or why there is none to write into.
 */
export const manifestForRegistration = (modRoot: string): ManifestChoice => {
    const manifests = manifestsIn(modRoot);
    if (manifests.length === 0) return { kind: 'none' };
    const chosen = manifestToWrite(manifests);
    if (chosen) return { kind: 'manifest', fsPath: chosen };
    return { kind: 'ambiguous', manifests: manifests.map(basenameOf) };
};

/**
 * The action-target path of one of the game root's own top-level list members.
 *
 * Both spellings the game root uses are handled. A member written as a reference
 * (`Resources = &<resources/resources.rules>/Resources`) already carries the path the action has to
 * name, so it is used as written. A member written as a list in the game root itself
 * (`Ships [ … ]`) is named by a path to the game root's own file.
 *
 * @param rootDocument the game root `cosmoteer.rules`, parsed.
 * @param rootFsPath that file's on-disk path.
 * @param dataRoot the game's `Data` directory, which every action target is expressed against.
 * @param memberName the top-level member holding the list, matched ignoring case.
 * @returns the target path, or undefined when the game root declares no such member.
 */
export const gameRootListTarget = (
    rootDocument: AbstractNodeDocument,
    rootFsPath: string,
    dataRoot: string,
    memberName: string
): string | undefined => {
    const lower = memberName.toLowerCase();
    for (const [name, node] of namedMembersOf(rootDocument)) {
        if (name.toLowerCase() !== lower) continue;
        if (isValueNode(node) && node.valueType.type === 'Reference') {
            // An action target is a path and never a reference, so the reading sigil the game root
            // writes is dropped: `AddTo` takes `"<resources/resources.rules>/Resources"`.
            return String(node.valueType.value).trim().replace(/^&\s*/, '');
        }
        if (isListNode(node)) return relativeRulesReference(dataRoot, rootFsPath, name);
        return undefined;
    }
    return undefined;
};

/** The `<…>` span of a reference, whatever member path follows it. */
const REFERENCE_FILE = /^\s*&?\s*<([^<>]+)>/;

/**
 * The action-target path of a member inside a file one of the game root's own members names.
 *
 * The game root names its menu rules as `Menus = &<gui/menus.rules>`, and the logo ship is the
 * `LogoShip` value inside that file, so the target the `Replace` action needs is the file the root
 * names with the member path appended. A member the root holds itself, or one it does not declare,
 * has no such file and so no such target.
 *
 * @param rootDocument the game root `cosmoteer.rules`, parsed.
 * @param memberName the top-level member naming the file, matched ignoring case.
 * @param memberPath the member inside that file the target has to name.
 * @returns the target path, or undefined when the game root names no such file.
 */
export const gameRootMemberTarget = (
    rootDocument: AbstractNodeDocument,
    memberName: string,
    memberPath: string
): string | undefined => {
    const lower = memberName.toLowerCase();
    for (const [name, node] of namedMembersOf(rootDocument)) {
        if (name.toLowerCase() !== lower) continue;
        if (!isValueNode(node) || node.valueType.type !== 'Reference') return undefined;
        const match = REFERENCE_FILE.exec(String(node.valueType.value));
        if (!match) return undefined;
        // Whatever member path the root itself wrote after the file is dropped, since the target
        // names a member of the file rather than of whatever the root was pointing at inside it. The
        // path is relative to the root's own directory, which is the data root every target is read
        // against, so it is kept as written.
        return `<${match[1]}>/${memberPath}`;
    }
    return undefined;
};

/** The comparison key of a file, folded the way the filesystem matches it. */
const fileKey = (fsPath: string): string => foldPathCase(resolve(fsPath).replace(/\\/g, '/'));

/**
 * The file a reference names, member path or not.
 *
 * `locationOf` cannot answer this, because it refuses a reference with no member path, and a
 * memberless reference is exactly what a registry of whole files is written with
 * (`&<steel/steel.rules>`). Existence is deliberately not required: an author who wired the action
 * before writing the file has still registered it, and adding a second entry would give the game a
 * duplicate.
 *
 * @param reference the reference's text.
 * @param declaringDir the directory of the file it is written in.
 * @returns the file's path with forward slashes, or undefined when the text names no file.
 */
const referencedFileOf = (reference: string, declaringDir: string): string | undefined => {
    const match = REFERENCE_FILE.exec(reference);
    if (!match) return undefined;
    const fsPath = resolveBasePath(match[1], declaringDir);
    return fsPath ? fsPath.replace(/\\/g, '/') : undefined;
};

/**
 * Whether a set of reference elements already names a file, whatever spelling each of them uses.
 *
 * @param elements the reference elements to look through.
 * @param declaringDir the directory those references are written in.
 * @param fileFsPath the file being registered.
 * @returns true when one of them resolves to that file.
 */
const referencesFile = (elements: readonly AbstractNode[], declaringDir: string, fileFsPath: string): boolean => {
    const wanted = fileKey(fileFsPath);
    for (const element of elements) {
        if (!isValueNode(element) || element.valueType.type !== 'Reference') continue;
        const named = referencedFileOf(String(element.valueType.value), declaringDir);
        if (named && fileKey(named) === wanted) return true;
    }
    return false;
};

/**
 * Whether one of a mod's manifests already carries an action that does something to a target, with
 * the caller deciding what counts as that something.
 *
 * Every manifest of the mod is read, variants included, since a version-split mod may already carry
 * the entry in the variant that is not being written to.
 *
 * @param modRoot the mod whose manifests are read.
 * @param target the game node as an action target names it.
 * @param matches whether one source of a matching action is the entry being looked for, called with
 * the directory of the manifest the source is written in.
 * @param verb the action verb to look at, absent when every verb counts.
 * @returns true when one source of one matching action satisfies the predicate.
 */
export const manifestActionMatches = async (
    modRoot: string,
    target: string,
    matches: (source: ActionSource, declaringDir: string) => boolean | Promise<boolean>,
    verb?: string
): Promise<boolean> => {
    const wanted = normalizeTargetPath(target).toLowerCase();
    for (const manifestFsPath of manifestsIn(modRoot)) {
        const file = await readRulesFile(manifestFsPath);
        if (!file) continue;
        const declaringDir = dirOf(manifestFsPath);
        for (const action of parseModActions(file.document)) {
            if (verb !== undefined && action.type !== verb) continue;
            const hits = action.targets.some(
                (node) => normalizeTargetPath(String(node.valueType.value)).toLowerCase() === wanted
            );
            if (!hits) continue;
            for (const source of action.sources) {
                if (await matches(source, declaringDir)) return true;
            }
        }
    }
    return false;
};

/**
 * Whether one of a mod's manifests already adds a file to a list.
 *
 * @param modRoot the mod whose manifests are read.
 * @param target the list as an action target names it.
 * @param fileFsPath the file being registered.
 * @returns true when an action already carries a reference to it.
 */
export const manifestAlreadyAdds = async (modRoot: string, target: string, fileFsPath: string): Promise<boolean> =>
    // A source is a `ManyToAdd [ … ]` list or a single `ToAdd`, and both reach the game the same way,
    // so a bare reference counts as a registration just as a list element does.
    await manifestActionMatches(modRoot, target, (source, declaringDir) =>
        referencesFile(isListNode(source) ? source.elements : [source], declaringDir, fileFsPath)
    );

/**
 * Whether one of a mod's manifests already merges a file into a group with an `Overrides`.
 *
 * The source of an `Overrides` is the group itself, `Overrides = &<buffs/mine.rules>`, rather than
 * a list of entries, so only a reference source counts and an inline `Overrides { … }` group never
 * names a file. A second `Overrides` of the same file would merge the same members twice, which is
 * harmless for the game and noise in the manifest.
 *
 * @param modRoot the mod whose manifests are read.
 * @param target the group as an action target names it.
 * @param fileFsPath the file being merged in.
 * @returns true when an `Overrides` action already references it.
 */
export const manifestAlreadyOverridesWith = async (
    modRoot: string,
    target: string,
    fileFsPath: string
): Promise<boolean> =>
    await manifestActionMatches(
        modRoot,
        target,
        (source, declaringDir) => referencesFile([source], declaringDir, fileFsPath),
        'Overrides'
    );

/** A `Replace` action one of the mod's manifests already carries for a target. */
export interface ManifestReplaceAction {
    /** The manifest the action is written in. */
    readonly manifestFsPath: string;
    /** Its `With` value node, a plain path relative to that manifest. */
    readonly source: ValueNode;
}

/**
 * The `Replace` action a mod's manifests already carry for a target, whatever it replaces the value
 * with. A value the game holds once (the title screen ship) is replaced at most once per mod: a
 * second `Replace` of the same node would only make the manifest say two things about one value,
 * so a caller finding one re-points it rather than adding another.
 *
 * @param modRoot the mod whose manifests are read.
 * @param target the value as an action target names it.
 * @returns the first such action with a plain value source, or undefined when none replaces it.
 */
export const manifestReplaceActionFor = async (
    modRoot: string,
    target: string
): Promise<ManifestReplaceAction | undefined> => {
    const wanted = normalizeTargetPath(target).toLowerCase();
    for (const manifestFsPath of manifestsIn(modRoot)) {
        const file = await readRulesFile(manifestFsPath);
        if (!file) continue;
        for (const action of parseModActions(file.document)) {
            if (action.type !== 'Replace') continue;
            const hits = action.targets.some(
                (node) => normalizeTargetPath(String(node.valueType.value)).toLowerCase() === wanted
            );
            if (!hits) continue;
            const source = action.sources.find(isValueNode);
            if (source) return { manifestFsPath, source };
        }
    }
    return undefined;
};

/**
 * Whether one of a mod's manifests already replaces a value with a path to a file.
 *
 * The `With` of a `Replace` is a plain path relative to the manifest rather than a reference, which
 * is how the logo ship is named: `With = "gui/logo.ship.png"`. Two spellings of the same file count
 * as the same registration, so the paths are compared resolved rather than as text.
 *
 * @param modRoot the mod whose manifests are read.
 * @param target the value as an action target names it.
 * @param fileFsPath the file the value is replaced with.
 * @returns true when a `Replace` action already names it.
 */
export const manifestAlreadyReplacesWith = async (
    modRoot: string,
    target: string,
    fileFsPath: string
): Promise<boolean> =>
    await manifestActionMatches(
        modRoot,
        target,
        (source, declaringDir) => {
            if (!isValueNode(source)) return false;
            const written = String(source.valueType.value).trim();
            return written.length > 0 && fileKey(resolve(declaringDir, written)) === fileKey(fileFsPath);
        },
        'Replace'
    );
