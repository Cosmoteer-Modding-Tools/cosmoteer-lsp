import { realpathSync } from 'fs';
import { dirname } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { childNodesOf } from '../../utils/ast.utils';
import { isModRules } from '../../document/document-kind';
import { aliasRootIndex } from '../../document/schema/alias-root';
import { MARKER_CLASSES } from '../../document/schema/category-usage';
import { documentRootClass } from '../../document/schema/document-root';
import { ENTITY_FIELDS, PART_RULES_CLASS, sameId } from '../../document/schema/entity-schema';
import { typeDef } from '../../document/schema/schema';
import { ActionRootingIndex } from '../../mod/action-rooting.index';
import { computeModReachability, ModReachability, reachabilityKey, relativeToMod } from '../../mod/mod-reachability';
import { findModRoot } from '../../mod/mod-root';
import { isStringsFile } from '../../mod/strings-folder';
import { documentsMentioning, uriToFsPath } from '../navigation/workspace-files';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/** One id a file declares for a game collection, with the member the registration wires in. */
interface ModIdDeclaration {
    readonly cls: string;
    readonly id: string;
    /** The node to underline, always inside the document being validated. */
    readonly node: AbstractNode;
    /** The member an action or alias registers (`Part`, `Factions`), empty for a whole-file root. */
    readonly member: string;
}

/** The document's own top-level `ID`, the declaration a whole-file root makes. */
function* rootDeclarationOf(document: AbstractNodeDocument): Generator<ModIdDeclaration> {
    const cls = documentRootClass(document);
    if (!cls) return;
    for (const element of document.elements) {
        if (!isAssignmentNode(element) || element.left.name !== 'ID' || !isValueNode(element.right)) continue;
        const valueType = element.right.valueType;
        if (valueType.type !== 'String' && valueType.type !== 'Reference') continue;
        const id = String(valueType.value);
        if (id.trim() !== '') yield { cls, id, node: element.right, member: '' };
        return;
    }
}

/** The `Part { ID = … }` a ship-part file writes at its top level. */
function* partDeclarationOf(document: AbstractNodeDocument): Generator<ModIdDeclaration> {
    for (const element of document.elements) {
        if (!isGroupNode(element) || element.identifier?.name.toLowerCase() !== 'part') continue;
        for (const member of element.elements) {
            if (
                !isAssignmentNode(member) ||
                member.left.name.toLowerCase() !== 'id' ||
                !isValueNode(member.right) ||
                member.right.valueType.type !== 'String'
            ) {
                continue;
            }
            const id = String(member.right.valueType.value);
            if (id.trim() !== '') {
                yield { cls: PART_RULES_CLASS, id, node: member.right, member: element.identifier.name };
            }
        }
    }
}

/**
 * The ids a `Factions [ { ID } ]` kind of list declares, restricted to field names ENTITY_FIELDS
 * gives exactly one candidate class. A name that reaches two classes (`Ships` and `Techs` do, the
 * career and build-battle collections) says nothing about which collection an element joins, and
 * those collections legitimately carry the same ids, so such a name cannot decide a collision.
 */
function* listDeclarationsIn(node: AbstractNode): Generator<ModIdDeclaration> {
    if (isListNode(node) && node.identifier) {
        const candidates = ENTITY_FIELDS.get(node.identifier.name.toLowerCase());
        if (candidates?.length === 1) {
            const { elementClass, identityKey } = candidates[0];
            for (const element of node.elements) {
                if (!isGroupNode(element)) continue;
                for (const member of element.elements) {
                    if (
                        !isAssignmentNode(member) ||
                        member.left.name.toLowerCase() !== identityKey.toLowerCase() ||
                        !isValueNode(member.right) ||
                        member.right.valueType.type !== 'String'
                    ) {
                        continue;
                    }
                    const id = String(member.right.valueType.value);
                    if (id.trim() !== '') {
                        yield { cls: elementClass, id, node: member.right, member: node.identifier.name };
                    }
                }
            }
        }
    }
    const children = childNodesOf(node);
    for (const child of children) yield* listDeclarationsIn(child);
}

/**
 * Every id `document` declares for a game collection, in the three shapes a collision is decidable
 * in. Deliberately narrower than {@link entityDeclarationsOf}, which also harvests stat names,
 * damage types, spawner tags, label fields and consumer map keys. Those are name vocabularies many
 * files write on purpose, so a second writer of one is not a duplicate.
 *
 * @param document the parsed document to harvest.
 * @returns a generator of the ids the document declares.
 */
export function* modIdDeclarationsOf(document: AbstractNodeDocument): Generator<ModIdDeclaration> {
    for (const declaration of rootDeclarationOf(document)) {
        if (!MARKER_CLASSES.has(declaration.cls)) yield declaration;
    }
    for (const declaration of partDeclarationOf(document)) {
        if (!MARKER_CLASSES.has(declaration.cls)) yield declaration;
    }
    for (const element of document.elements) {
        for (const declaration of listDeclarationsIn(element)) {
            if (!MARKER_CLASSES.has(declaration.cls)) yield declaration;
        }
    }
}

/**
 * Whether the game actually puts this declaration into a collection. A mod wires content in by
 * naming it from a manifest action or a game-root alias, and only then does the id take a slot the
 * next one could take away. A file that is merely inherited (`Part : <base.rules>/Part`) or read
 * member by member (`Range = &<base.rules>/Range`) joins nothing, which is what a base template
 * carrying a leftover `ID` looks like. Answers false while the rooting indexes are still building,
 * so the check stays silent rather than guessing.
 *
 * @param uri the declaring document's uri.
 * @param member the member the declaration sits in, empty for a whole-file root.
 * @returns true when an action or an alias roots that member.
 */
const isRegistered = (uri: string, member: string): boolean =>
    member === ''
        ? !!aliasRootIndex.rootType(uri) || !!ActionRootingIndex.instance.rootType(uri)
        : !!aliasRootIndex.memberType(uri, member) || !!ActionRootingIndex.instance.memberType(uri, member);

/** Real-path identity keys, so one file reached under two spellings never collides with itself. */
const realPathKeys = new Map<string, string>();

/**
 * The identity key of a file, folded through the real path. The uri and reachability keys fold case
 * and separators but leave a junction, a symlink and an 8.3 short name pointing at one file looking
 * like two, which would read as a duplicate of itself.
 *
 * @param fsPath the file's path as written.
 * @returns the case-folded real path.
 */
const realKey = (fsPath: string): string => {
    let key = realPathKeys.get(fsPath);
    if (key === undefined) {
        let resolved = fsPath;
        try {
            resolved = realpathSync.native(fsPath);
        } catch {
            /* not on disk yet, the written path is the best identity available */
        }
        key = reachabilityKey(resolved);
        realPathKeys.set(fsPath, key);
    }
    return key;
};

/** Per-mod reachability closures, so a per-file pass does not re-walk the mod for every file. */
const reachabilityByRoot = new Map<string, Promise<ModReachability | undefined>>();

/** Verdicts of the peer scan, keyed per mod root, class and id. */
const peerVerdicts = new Map<string, string[]>();
const PEER_VERDICTS_CAP = 512;

/**
 * Drops the memoized closures and peer verdicts after a workspace change, so a file the user just
 * added or renamed is seen by the next validation.
 */
export const invalidateDuplicateIdCache = (): void => {
    reachabilityByRoot.clear();
    peerVerdicts.clear();
    realPathKeys.clear();
};

/**
 * The mod's reachable-file closure, computed once per mod root.
 *
 * @param modRoot the mod root directory.
 * @param cancellationToken cancels the walk.
 * @returns the closure, or undefined when it could not be completed.
 */
const reachabilityOf = async (
    modRoot: string,
    cancellationToken: CancellationToken
): Promise<ModReachability | undefined> => {
    let pending = reachabilityByRoot.get(modRoot);
    if (!pending) {
        pending = computeModReachability(modRoot, cancellationToken).catch(() => undefined);
        reachabilityByRoot.set(modRoot, pending);
    }
    const reachability = await pending;
    // A cancelled walk returns a partial closure, and a file missing from it would read as dead
    // content, so it is dropped instead of memoized.
    if (!reachability || cancellationToken.isCancellationRequested) {
        reachabilityByRoot.delete(modRoot);
        return undefined;
    }
    return reachability;
};

/**
 * Whether the mod root holds several manifests side by side. The game picks one of them by
 * CompatibleGameVersions and loads only that tree, so two alternative trees declaring the same ids
 * never meet in one game. The closure seeds every manifest it finds on purpose, which keeps it
 * over-approximate but leaves it unable to tell the trees apart, so such a mod is left unjudged.
 *
 * @param reachability the mod's closure.
 * @returns true when more than one manifest sits directly in the mod root.
 */
const hasVariantManifests = (reachability: ModReachability): boolean => {
    const rootKey = reachabilityKey(reachability.modRoot);
    return reachability.manifests.filter((manifest) => reachabilityKey(dirname(manifest)) === rootKey).length > 1;
};

/**
 * The other files of the mod that register the same id for the same class. Found through the
 * mention pre-filter, so only files whose text spells the id are read, and memoized per mod root
 * and id so a whole-workspace pass scans each id once.
 *
 * @param declaration the declaration to find peers for.
 * @param ownKey the declaring file's real-path key, excluded from the result.
 * @param modRoot the mod root both files must belong to.
 * @param reachability the mod's closure.
 * @param folderPaths the project folders the mention index covers.
 * @param cancellationToken cancels the scan.
 * @returns the peer files' paths.
 */
const peerFilesDeclaring = async (
    declaration: ModIdDeclaration,
    ownKey: string,
    modRoot: string,
    reachability: ModReachability,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<string[]> => {
    // The id is folded into the key because the peers are matched with {@link sameId}, so two
    // spellings of one name must not be remembered as two separate verdicts.
    const key = `${reachabilityKey(modRoot)}|${declaration.cls}|${declaration.id.toLowerCase()}`;
    const cached = peerVerdicts.get(key);
    if (cached) return cached.filter((peer) => realKey(peer) !== ownKey);
    const declaring: string[] = [];
    for await (const candidate of documentsMentioning(folderPaths, declaration.id, cancellationToken)) {
        // The mention walk also yields every open buffer and the game tree, and a nested sub-mod is
        // a mod of its own, so the peer must root to the very same manifest folder.
        if (findModRoot(candidate.uri) !== modRoot) continue;
        const fsPath = uriToFsPath(candidate.uri);
        if (!reachability.reachable.has(reachabilityKey(fsPath))) continue;
        // A language file holds localization text. A rules-shaped copy in one is dead content the
        // game reads as strings, never a second entry in a collection.
        if (await isStringsFile(candidate.uri, cancellationToken)) continue;
        for (const peer of modIdDeclarationsOf(candidate)) {
            // The engine interns ids ignoring case, so `SW.Armor` and `SW.armor` take the same slot
            // in the collection and the second one really does drop the first.
            if (peer.cls !== declaration.cls || !sameId(peer.id, declaration.id)) continue;
            if (!isRegistered(candidate.uri, peer.member)) continue;
            declaring.push(fsPath);
            break;
        }
    }
    if (peerVerdicts.size >= PEER_VERDICTS_CAP) peerVerdicts.clear();
    peerVerdicts.set(key, declaring);
    return declaring.filter((peer) => realKey(peer) !== ownKey);
};

/**
 * Flags an id two files of one mod both register for the same collection, which the game resolves
 * by keeping one entry and dropping the other, so half the content silently never appears.
 *
 * Every gate is there to keep the check silent where a second writer is legitimate: the vocabulary
 * shapes are outside the harvest, a name that could mean two collections is skipped, a file the mod
 * never loads is skipped, a language file is skipped, a mod shipping alternative manifests is
 * skipped, and a declaration nothing registers is skipped, which is what a base file carrying a
 * leftover `ID` for its derivers looks like.
 *
 * @param document the parsed document to validate.
 * @param folderPaths the project folders the peer scan reads through.
 * @param cancellationToken cancels the closure walk and the peer scan.
 * @returns one warning per registered id another file of the mod registers too.
 */
export const validateDuplicateModIds = async (
    document: AbstractNodeDocument,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const modRoot = findModRoot(document.uri);
    if (!modRoot) return [];
    const declarations = [...modIdDeclarationsOf(document)];
    if (declarations.length === 0) return [];
    if (await isStringsFile(document.uri, cancellationToken)) return [];

    const reachability = await reachabilityOf(modRoot, cancellationToken);
    if (!reachability || hasVariantManifests(reachability)) return [];

    const ownPath = uriToFsPath(document.uri);
    if (!reachability.reachable.has(reachabilityKey(ownPath))) return [];
    const ownKey = realKey(ownPath);

    const errors: ValidationError[] = [];
    for (const declaration of declarations) {
        if (cancellationToken.isCancellationRequested) return errors;
        if (!isRegistered(document.uri, declaration.member)) continue;
        const peers = await peerFilesDeclaring(
            declaration,
            ownKey,
            modRoot,
            reachability,
            folderPaths,
            cancellationToken
        );
        if (peers.length === 0) continue;
        const targetName = typeDef(declaration.cls)?.name ?? declaration.cls.split('.').pop()!;
        errors.push({
            message: l10n.t(
                "The {0} id '{1}' is registered here and in {2}. The game keeps one of them and drops the rest.",
                targetName,
                declaration.id,
                peers.map((peer) => relativeToMod(modRoot, peer)).join(', ')
            ),
            node: declaration.node,
            severity: 'warning',
        });
    }
    return errors;
};
