import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    AssignmentNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { isModRules, isRulesFileName } from '../../document/document-kind';
import { registryOf, typeDef } from '../../document/schema/schema';
import { BUILTIN_SHIP_CLASS, entityDeclarationsOf, SELF_KEYED_MAP_FIELDS } from '../../document/schema/entity-schema';
import { MARKER_CLASSES } from '../../document/schema/category-usage';
import { SchemaIdIndex } from '../completion/schema-id.index';
import { isSameOrSubclass, schemaReferenceFieldOf, mapKeyReferencesOf } from '../navigation/schema-id-reference.navigation';
import { stringValueNodesOf } from '../navigation/schema-reference.navigation';
import { ActionRootingIndex } from '../../mod/action-rooting.index';
import type { ValueType } from '../../document/schema/schema.types';
import { normalizeUri } from '../navigation/reference-location';
import { documentsMentioning, uriToFsPath } from '../navigation/workspace-files';
import { ReverseIncludeIndex } from '../navigation/reverse-include.index';
import { parseText } from '../../utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { closestMatch } from '../../utils/did-you-mean';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/** A cross-file id reference found in a document, with the class it targets and the written id. */
export interface IdReference {
    readonly node: AbstractNode;
    readonly targetClass: string;
    readonly value: string;
    /** The declaring field, when the reference sits in a value position of a known field. */
    readonly fieldName?: string;
    /** True when the reference is the KEY of a map (`MaxBuffValues { Engine = … }`) rather than a
     *  value written for a field. A key of a self-keyed map is a declaration, not a reference. */
    readonly isMapKey?: boolean;
}

/**
 * Collects every cross-file `ID<X>` reference in a document, from value positions (`ResourceType = battery`,
 * `ReceivableBuffs = [Engine]`) and from map keys (`MaxBuffValues = { Engine = … }`).
 *
 * @param document the parsed document to scan.
 * @returns a generator of every {@link IdReference} the document contains.
 */
export function* idReferencesOf(document: AbstractNodeDocument): Generator<IdReference> {
    for (const value of stringValueNodesOf(document)) {
        const ref = schemaReferenceFieldOf(value);
        if (ref) yield { node: value, targetClass: ref.targetClass, value: ref.value, fieldName: ref.fieldName };
    }
    for (const key of mapKeyReferencesOf(document)) {
        yield {
            node: key.node,
            targetClass: key.targetClass,
            value: key.value,
            fieldName: key.fieldName,
            isMapKey: true,
        };
    }
}

/**
 * True when the reference is the key of a self-keyed map (`RenderLayers { MyLayer { … } }`,
 * `TradeShips { Starstone { … } }`), which the engine reads as a declaration: writing the key is what
 * brings the instance into existence, so an unknown key is a new instance rather than a typo, and
 * judging it would flag every mod that adds one.
 *
 * Only the key position declares. A value written for a field of the same class elsewhere
 * (`RenderLayer = my_layer` on a part sprite) is an ordinary reference into that pool and is judged
 * like any other: nothing about the class is exempt, only the position that declares it.
 *
 * @param reference the reference to classify.
 * @returns true when the reference sits in a declaring key position.
 */
const isSelfKeyedDeclaration = (reference: IdReference): boolean =>
    !!reference.isMapKey &&
    !!reference.fieldName &&
    SELF_KEYED_MAP_FIELDS.get(reference.fieldName.toLowerCase()) === reference.targetClass;

/**
 * The component registries whose ids are container-local: the engine names each component after its
 * node name inside the owner's `Components { … }` map (`PartRules` and `BulletRules` both do this,
 * decompile verified), and a reference resolves against the owner's own components rather than a global pool.
 * Judging them here would be worse than not judging them: two bullets each defining `DamagePool` means
 * one bullet's copy would excuse a reference in another bullet that has none, so the check could never
 * catch the bug it exists for. The part-local sibling validator owns these instead.
 */
const CONTAINER_LOCAL_REGISTRIES: ReadonlySet<string> = new Set(['PartComponentRules', 'BulletComponentRules']);

/** Whether id references targeting `cls` are judged at all (see the layer notes above). */
export const isValidatedIdClass = (cls: string): boolean => {
    const registry = registryOf(cls)?.name;
    return !(registry && CONTAINER_LOCAL_REGISTRIES.has(registry));
};

/**
 * Whether one reference is judged. Every `ID<X>` class is judged; no class is allowlisted or excluded
 * by name. The layers that make that safe are each mechanical:
 *  - a class whose declarations the harvest cannot see at all has no ids to judge against (the
 *    no-coverage skip in {@link judgeIdReference}),
 *  - part-component targets are part-local (nesting, inherited bases, includes), the sibling
 *    validator's domain, derived here from the schema's registry,
 *  - a self-keyed map KEY declares rather than references, so an unknown key is a new instance
 *    ({@link isSelfKeyedDeclaration}, derived from the schema's map shapes). The class itself stays
 *    judged: a value written for it elsewhere is an ordinary reference into the pool its keys fill,
 *  - label fields that borrow the id type without the engine ever resolving them derive from the
 *    base game's own usage ({@link isVanillaLabelField}),
 *  - an id written in a declaration shape anywhere in the project, rooted or not, is never flagged
 *    ({@link declaredAnywhereLoosely}: unrooted whole-file roots, a mod's own alias collections,
 *    entries a mod.rules action adds to a map),
 *  - vanilla's own leftovers exempt through {@link referencedInGameTree}, dependency mods through
 *    {@link declaredInInstalledMods}.
 * The vanilla scan (zero contract plus the pinned exemption set) and the mods scan triage stay the
 * honesty check for all of it.
 *
 * @param reference the reference to gate.
 * @returns true when the reference is a reference into a judged pool.
 */
export const isValidatedIdReference = (reference: IdReference): boolean =>
    isValidatedIdClass(reference.targetClass) && !isSelfKeyedDeclaration(reference);

/**
 * Ids the base game's own files reference without declaring, exempted mechanically instead of via a
 * hand-kept list, so a game update needs no code change here. Vanilla ships a few stale references
 * (`graveyard_platform`, `station_captor_defense` tags, the laser bolts' dead `shrapnel` resistance,
 * all decompile-verified harmless leftovers): when an unknown id is also referenced by a shipped
 * game file for the same target class, the game itself carries that reference, so it is vanilla's
 * leftover rather than the modder's typo. The vanilla scan pins the exact exempted set through
 * {@link gameTreeExemptions}, so a harvest regression that would widen it fails the scan instead of
 * hiding behind the exemption.
 */
const referencedInGameTree = async (
    targetClass: string,
    id: string,
    cancellationToken: CancellationToken
): Promise<boolean> => {
    const key = `${targetClass}:${id}`;
    const cached = gameTreeVerdicts.get(key);
    if (cached !== undefined) return cached;
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return false;
    const dataRootPrefix = normalizeUri(pathToFileURL(dataRoot).href);
    let referenced = false;
    for await (const document of documentsMentioning([pathToFileURL(dataRoot).href], id, cancellationToken)) {
        // Only shipped game files may exempt (the mention walk also yields the already-registered
        // workspace documents, and an open file referencing its own typo twice must still flag).
        if (!normalizeUri(document.uri).startsWith(dataRootPrefix)) continue;
        for (const reference of idReferencesOf(document)) {
            if (reference.targetClass === targetClass && reference.value === id) {
                referenced = true;
                break;
            }
        }
        if (referenced) break;
    }
    if (gameTreeVerdicts.size >= INSTALLED_MOD_VERDICTS_CAP) gameTreeVerdicts.clear();
    gameTreeVerdicts.set(key, referenced);
    if (referenced) gameTreeExemptions.add(id.toLowerCase());
    return referenced;
};

/** Per-session verdicts of the game-tree reference consult, one scan per unknown id. */
const gameTreeVerdicts = new Map<string, boolean>();

/** Every id the game-tree consult has exempted this session, exposed so the vanilla scan can assert
 *  the set stays exactly the known stale leftovers (the regression tripwire lives in the test). */
export const gameTreeExemptions = new Set<string>();

/** The Steam workshop content folder for Cosmoteer (app 799600) next to the detected install, or
 *  undefined when the game was not installed through Steam. */
const workshopContentDir = (): string | undefined => {
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return undefined;
    const dir = join(dataRoot, '..', '..', '..', 'workshop', 'content', '799600');
    return existsSync(dir) ? dir : undefined;
};

/** Per-session verdicts of the installed-mods consult, so each unknown id costs one scan. */
const installedModVerdicts = new Map<string, boolean>();
const INSTALLED_MOD_VERDICTS_CAP = 512;

/**
 * Whether any installed workshop mod declares the id, the dependency escape hatch of the
 * cross-file id validation. Scans the workshop tree lazily through the mention pre-filter, so only
 * files whose text contains the id are parsed, and memoizes the verdict per class and id.
 *
 * @param targetClass the reference target class the id must be declared for.
 * @param id the unknown id.
 * @param cancellationToken cancels the workshop scan.
 * @returns true when some installed mod declares the id for that class (or a subclass).
 */
const declaredInInstalledMods = async (
    targetClass: string,
    id: string,
    cancellationToken: CancellationToken
): Promise<boolean> => {
    const key = `${targetClass}:${id}`;
    const cached = installedModVerdicts.get(key);
    if (cached !== undefined) return cached;
    const workshop = workshopContentDir();
    if (!workshop) return false;
    const workshopPrefix = normalizeUri(pathToFileURL(workshop).href);
    let declared = false;
    for await (const document of documentsMentioning([pathToFileURL(workshop).href], id, cancellationToken)) {
        // Only installed-mod files may vouch (the mention walk also yields the already-registered
        // workspace documents, whose declarations the index and the loose probe already count).
        if (!normalizeUri(document.uri).startsWith(workshopPrefix)) continue;
        for (const declaration of entityDeclarationsOf(document)) {
            if (declaration.id === id && isSameOrSubclass(declaration.elementClass, targetClass)) {
                declared = true;
                break;
            }
        }
        // A dependency mod's declaration may sit in a shape the harvest cannot classify outside its
        // own workspace (its buffs collection, an unrooted resource file), the same leniency the
        // loose probe grants the open workspace. Marker classes stay exact: their harvest is
        // complete, so the shape match could only shadow a real finding.
        if (!declared && !MARKER_CLASSES.has(targetClass) && looseDeclarationIn(document, id)) declared = true;
        if (declared) break;
    }
    if (installedModVerdicts.size >= INSTALLED_MOD_VERDICTS_CAP) installedModVerdicts.clear();
    installedModVerdicts.set(key, declared);
    return declared;
};

/** Per-session verdicts of the label-field derivation, one game-tree scan per field and class. */
const labelFieldVerdicts = new Map<string, boolean>();

/** Every field the label derivation has exempted this session, exposed so the vanilla scan can
 *  assert the set stays exactly the known label fields (the regression tripwire lives in the test). */
export const labelFieldExemptions = new Set<string>();

/**
 * Whether a field is a label field: reference-typed in the C# only because it borrows the id type,
 * while the engine never resolves its value to an object (`SelectionTypeID` is only ever compared
 * between parts to group them in the build UI, `FlipWhenLoadingIDs` deliberately names removed
 * legacy parts for save compatibility). Derived mechanically from the base game's own usage: the
 * shipped files load fine in-game, so a field whose vanilla values never resolve to a primary id
 * cannot be an existence-checked reference. Aliases do not count as resolving here, since a label
 * field's values are historical strings and `OtherIDs` archives exactly those (`SelectionTypeID =
 * "armor"` matches the armor part's legacy alias, never a primary id). A field with any
 * primary-resolving vanilla usage stays checked, and its stale ids stay covered by the id-level
 * game-tree exemption instead.
 *
 * @param fieldName the written field name of the reference.
 * @param targetClass the reference target class.
 * @param cancellationToken cancels the game-tree scan.
 * @returns true when vanilla uses the field and none of its values resolve to a primary id.
 */
const isVanillaLabelField = async (
    fieldName: string,
    targetClass: string,
    cancellationToken: CancellationToken
): Promise<boolean> => {
    const field = fieldName.toLowerCase();
    const key = `${field}:${targetClass}`;
    const cached = labelFieldVerdicts.get(key);
    if (cached !== undefined) return cached;
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return false;
    const dataRootUrl = pathToFileURL(dataRoot).href;
    const dataRootPrefix = normalizeUri(dataRootUrl);
    const ids = await SchemaIdIndex.instance.primaryIdsForClass(targetClass, [dataRoot], cancellationToken, dataRootPrefix);
    let sawUsage = false;
    let sawResolving = false;
    for await (const document of documentsMentioning([dataRootUrl], fieldName, cancellationToken)) {
        // Only the base game's own usage may derive the verdict (the mention walk also yields the
        // already-registered workspace documents, and a mod's usage must not reclassify a field).
        if (!normalizeUri(document.uri).startsWith(dataRootPrefix)) continue;
        for (const reference of idReferencesOf(document)) {
            if (reference.fieldName?.toLowerCase() !== field || reference.targetClass !== targetClass) continue;
            if (reference.value.trim() === '') continue;
            sawUsage = true;
            if (ids.has(reference.value)) {
                sawResolving = true;
                break;
            }
        }
        if (sawResolving) break;
    }
    const label = sawUsage && !sawResolving;
    if (labelFieldVerdicts.size >= INSTALLED_MOD_VERDICTS_CAP) labelFieldVerdicts.clear();
    labelFieldVerdicts.set(key, label);
    if (label) labelFieldExemptions.add(field);
    return label;
};

/** Verdicts of the loose declaration consult, keyed per folder set and id since the answer depends
 *  on both. Cleared through {@link invalidateLooseDeclarationCache} when workspace content changes
 *  (unlike the game-tree and installed-mods consults, this one scans the user's editable files). */
const looseDeclarationVerdicts = new Map<string, boolean>();

/** Drops the loose-declaration verdicts after a workspace file change, so a declaration the user
 *  just added (or removed) is seen by the next validation. */
export const invalidateLooseDeclarationCache = (): void => {
    looseDeclarationVerdicts.clear();
};

/**
 * Whether any project file writes the id in a declaration shape, regardless of rooting: a bare
 * `ID = <id>` assignment (an unrooted whole-file root, a GUI id group, a group inside a mod.rules
 * action payload) or a named group/list called `<id>` (a mod's own buffs.rules members, an effect
 * bucket). This is what makes the whole-file-root and manifest-collection classes safe to judge
 * without hand-kept exclusions: their declarations may sit where the rooted harvest cannot classify
 * them, but the shapes themselves are still recognizable. Class-blind on purpose, since the
 * unclassifiable location is exactly why the class is unknown; the cost of a rare cross-class
 * collision is a suppressed warning, never a false one.
 *
 * @param id the unknown id.
 * @param folderPaths the project folders to scan (paths or uris).
 * @param cancellationToken cancels the scan.
 * @returns true when some file writes the id in a declaration shape.
 */
const declaredAnywhereLoosely = async (
    id: string,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<boolean> => {
    const key = `${folderPaths.join('|')}:${id}`;
    const cached = looseDeclarationVerdicts.get(key);
    if (cached !== undefined) return cached;
    const folders = folderPaths.map((path) => (path.includes('://') ? path : pathToFileURL(path).href));
    let declared = false;
    for await (const document of documentsMentioning(folders, id, cancellationToken)) {
        if (looseDeclarationIn(document, id)) {
            declared = true;
            break;
        }
    }
    if (!declared) declared = await declaredInUnwalkedInclude(id, cancellationToken);
    if (looseDeclarationVerdicts.size >= INSTALLED_MOD_VERDICTS_CAP) looseDeclarationVerdicts.clear();
    looseDeclarationVerdicts.set(key, declared);
    return declared;
};

/**
 * Whether a file the project walk never visits, but some indexed file includes through `&<…>`,
 * declares the id. The game's loader ignores the extension, so rules content can live in a file the
 * walk skips (a workshop mod keeps its ship render layers in `2.d`, pulled in by
 * `RenderLayers : &<Hyperoid/Mineables/2.d>/d`). No index sees such a file, so its declarations would
 * look like nothing and every reference to them would be flagged.
 *
 * Consulted only for an id that resolved nowhere else, and the include targets are few, so the cost
 * lands on the already-slow unknown-id path and is memoized with the rest of the probe's verdict.
 *
 * @param id the unknown id.
 * @param cancellationToken cancels the reads.
 * @returns true when an unwalked include target writes the id in a declaration shape.
 */
const declaredInUnwalkedInclude = async (id: string, cancellationToken: CancellationToken): Promise<boolean> => {
    const targets = ReverseIncludeIndex.instance
        .includeTargetUris()
        .filter((uri) => !isRulesFileName(uri.split('/').pop() ?? ''));
    for (const uri of targets) {
        if (cancellationToken.isCancellationRequested) return false;
        // Read the target's real path, not its normalized key: the key is lower-cased, so on a
        // case-sensitive filesystem `uriToFsPath` would point at a file that does not exist.
        const path = ReverseIncludeIndex.instance.realPathFor(uri) ?? uriToFsPath(uri);
        const text = await readFile(path, 'utf8').catch(() => undefined);
        if (text === undefined || !text.includes(id)) continue;
        const document = parseText(text, uri);
        if (looseDeclarationIn(document, id) || writesMapEntryKey(document, id)) return true;
    }
    return false;
};

/**
 * True when `document` writes `Key = <id>` anywhere: the entry spelling of a map key. Accepted as a
 * declaration only inside a file no index can see ({@link declaredInUnwalkedInclude}), where nothing
 * can type the list the entry sits in, so the shape is all there is to go on. The `.d` file the
 * workshop mod inherits into its `RenderLayers` holds its layers exactly this way.
 *
 * Elsewhere the same shape needs the map to be self-keyed ({@link declaresSelfKeyedEntry}), since a
 * `Key` of an ordinary reference-keyed map references rather than declares, and accepting it blindly
 * would swallow real typos.
 *
 * @param document the parsed unwalked file.
 * @param id the id being looked for.
 * @returns true when some entry key writes the id.
 */
const writesMapEntryKey = (document: AbstractNodeDocument, id: string): boolean => {
    let found = false;
    const visit = (node: AbstractNode): void => {
        if (found) return;
        if (
            isAssignmentNode(node) &&
            node.left.name.toLowerCase() === 'key' &&
            isValueNode(node.right) &&
            String(node.right.valueType.value) === id
        ) {
            found = true;
            return;
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
                  : [];
        for (const child of children) visit(child);
    };
    for (const element of document.elements) visit(element);
    return found;
};

/**
 * True when `document` writes `id` in a declaration shape: an `ID = <id>` assignment, a named
 * container `<id>`, the `Key` of a self-keyed map entry ({@link declaresSelfKeyedEntry}), or an
 * alias assignment `<id> = &…` whose reference value derives the instance from another one (a mod's
 * `MyBuff = &BaseBuff`). A scalar-valued assignment (`fire = 50%`) is not declaration-shaped: map
 * keys with plain values are the reference side of their relation.
 */
const looseDeclarationIn = (document: AbstractNodeDocument, id: string): boolean => {
    let found = false;
    const visit = (node: AbstractNode): void => {
        if (found) return;
        if (isAssignmentNode(node) && isValueNode(node.right)) {
            if (node.left.name.toLowerCase() === 'id' && String(node.right.valueType.value) === id) {
                found = true;
                return;
            }
            if (node.left.name === id && node.right.valueType.type === 'Reference') {
                found = true;
                return;
            }
            if (String(node.right.valueType.value) === id && declaresSelfKeyedEntry(node)) {
                found = true;
                return;
            }
        }
        if ((isGroupNode(node) || isListNode(node)) && node.identifier?.name === id) {
            found = true;
            return;
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
                  : [];
        for (const child of children) visit(child);
    };
    for (const element of document.elements) visit(element);
    return found;
};

/** True when a slot type is a self-keyed map (`map<reference X, group X>`), the shape whose keys are
 *  its instances. The type-level twin of {@link SELF_KEYED_MAP_FIELDS}, for a slot an action gave. */
const isSelfKeyedMapType = (type: ValueType | undefined): boolean =>
    type?.kind === 'map' &&
    type.key.kind === 'reference' &&
    type.value.kind === 'group' &&
    type.value.ref === type.key.target;

/**
 * True when `node` is the `Key` of an entry of a self-keyed map written in list spelling
 * (`RenderLayers [ { Key = "asteroid_lights_add" Value { … } } ]`), the other declaring spelling
 * beside the named member (`RenderLayers { asteroid_lights_add { … } }`).
 *
 * The loose probe needs this because a mod adds its layers from a `mod.rules` action payload, where
 * the list carries the ACTION's field name rather than the map's:
 *
 *     { Action = AddMany; AddTo = "<ships/terran/terran.rules>/Terran/RenderLayers"
 *       ManyToAdd [ { Key = "asteroid_lights_add" Value { … } } ] }
 *
 * so the entry is a declaration despite sitting in a list called `ManyToAdd`. What types it is the
 * action's target slot, which is exactly what {@link ActionRootingIndex} records, so the payload is
 * recognized through the slot rather than through a list of action field names.
 *
 * Both routes demand the self-keyed map shape, which keeps the probe's class-blindness from swallowing
 * typos: a `Key` of an ordinary reference-keyed map still references rather than declares.
 *
 * @param node the `Key = …` assignment to classify.
 * @returns true when the assignment declares a self-keyed map instance.
 */
const declaresSelfKeyedEntry = (node: AssignmentNode): boolean => {
    if (node.left.name.toLowerCase() !== 'key') return false;
    const entry = node.parent;
    const list = entry?.parent;
    if (!entry || !isGroupNode(entry) || !list || !isListNode(list)) return false;
    const owner = list.parent;
    const fieldName =
        list.identifier?.name ??
        (owner && (isGroupNode(owner) || isDocumentNode(owner))
            ? owner.elements.find(
                  (element): element is AssignmentNode => isAssignmentNode(element) && element.right === list
              )?.left.name
            : undefined);
    if (fieldName && SELF_KEYED_MAP_FIELDS.has(fieldName.toLowerCase())) return true;
    return isSelfKeyedMapType(ActionRootingIndex.instance.nodeSlotType(list));
};

/**
 * Validates cross-file `ID<X>` references, flagging a value that names no declaration of class `X`
 * anywhere in the project (a typo such as `ResourceType = btatery` or `ReceivableBuffs = [Engne]`).
 *
 * Conservative, to stay false-positive-free: every escape hatch in {@link judgeIdReference} runs
 * before a reference is flagged, and an empty value is ignored. The id index is built across the
 * whole project, so an id declared in any open folder or the game tree counts.
 *
 * @param document the parsed document to validate.
 * @param folderPaths the project folders the id index is built from.
 * @param cancellationToken cancellation for the index build.
 * @returns the list of validation errors, one per reference whose id is not declared anywhere.
 */
export const validateCrossFileIdReferences = async (
    document: AbstractNodeDocument,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];

    const references = [...idReferencesOf(document)].filter(
        (ref) => isValidatedIdReference(ref) && isJudgeableReference(ref)
    );
    if (references.length === 0) return [];

    const errors: ValidationError[] = [];
    const idsByClass = new Map<string, Set<string>>();
    for (const reference of references) {
        if (cancellationToken.isCancellationRequested) return errors;
        const verdict = await judgeIdReference(reference, folderPaths, idsByClass, cancellationToken);
        if (verdict !== 'unresolved') continue;

        errors.push(unresolvedIdError(reference, idsByClass.get(reference.targetClass) ?? new Set<string>()));
    }
    return errors;
};

/**
 * The declared ship id that is exactly the written one with an `IDPrefix` in front, when there is one.
 * A built-in ship's id is composed (`IDPrefix + " " + name`), so a builtins file that carries a prefix
 * its `ShipID`s omit leaves every reference unresolvable, the crash a mod hits on its first trade-ship
 * spawn. Restricted to ships, the only class the engine composes ids for: a general "some declared id
 * ends with the written one" match would suggest `big battery` for a mistyped `battery`.
 *
 * @param reference the unresolved id reference.
 * @param ids the declared ids of its target class.
 * @returns the shortest prefixed id, or undefined when the reference is not a ship or nothing matches.
 */
const prefixComposedShipId = (reference: IdReference, ids: ReadonlySet<string>): string | undefined => {
    if (reference.targetClass !== BUILTIN_SHIP_CLASS) return undefined;
    const suffix = ` ${reference.value.toLowerCase()}`;
    let best: string | undefined;
    for (const id of ids) {
        if (id.toLowerCase().endsWith(suffix) && (best === undefined || id.length < best.length)) best = id;
    }
    return best;
};

/**
 * The finding for one reference whose id nothing declares: the message, and the did-you-mean quick fix
 * when a declared id is close enough. A prefix-composed ship id gets a message that names the cause,
 * since "no ship named X" alone sends the author looking for a missing file rather than at the
 * `IDPrefix` line that renamed every ship in it.
 *
 * @param reference the unresolved id reference.
 * @param ids the declared ids of its target class.
 * @returns the validation error to report.
 */
export const unresolvedIdError = (reference: IdReference, ids: ReadonlySet<string>): ValidationError => {
    const targetName = typeDef(reference.targetClass)?.name ?? reference.targetClass.split('.').pop()!;
    const prefixed = prefixComposedShipId(reference, ids);
    const suggestion = prefixed ?? closestMatch(reference.value, [...ids], true);
    return {
        message: prefixed
            ? l10n.t(
                  "No {0} named '{1}' in the project. Its builtins file declares it as '{2}': that file's IDPrefix is prepended to every ship it declares.",
                  targetName,
                  reference.value,
                  prefixed
              )
            : l10n.t("No {0} named '{1}' in the project.", targetName, reference.value),
        node: reference.node,
        severity: 'warning',
        ...(suggestion
            ? { data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } } }
            : {}),
    };
};

/** Whether a reference carries a value the existence judgment applies to at all: non-empty. */
export const isJudgeableReference = (reference: IdReference): boolean => reference.value.trim() !== '';

/** The outcome of judging one cross-file id reference against the project's declarations. */
export type IdReferenceJudgment =
    | 'resolved'
    | 'no-coverage'
    | 'label-field'
    | 'declared-loosely'
    | 'vanilla-leftover'
    | 'dependency-declared'
    | 'unresolved';

/**
 * Judges whether one cross-file `ID<X>` reference resolves, applying every escape hatch the
 * validator ships: project declarations plus builtins, the game-tree leftover exemption, and the
 * installed-workshop-mods dependency consult. Only an `unresolved` verdict is a reportable finding.
 * Shared by the validator and the class-coverage audit, so the audit measures exactly what the
 * validator would flag.
 *
 * @param reference the id reference to judge.
 * @param folderPaths the project folders the id index is built from.
 * @param idsByClass per-call memo of the declared-id sets, filled on demand.
 * @param cancellationToken cancellation for the index build and consults.
 * @returns the judgment for this reference.
 */
export const judgeIdReference = async (
    reference: IdReference,
    folderPaths: string[],
    idsByClass: Map<string, Set<string>>,
    cancellationToken: CancellationToken
): Promise<IdReferenceJudgment> => {
    let ids = idsByClass.get(reference.targetClass);
    if (!ids) {
        ids = await SchemaIdIndex.instance.idsForClass(reference.targetClass, folderPaths, cancellationToken);
        idsByClass.set(reference.targetClass, ids);
    }
    // No file-harvested declarations for this class means we have no coverage to judge it. The
    // engine builtins alone do not open a class for judgment: the literal-construction sweep is
    // partial by nature, so builtins supplement resolution but never prove completeness.
    if (ids.size === 0 || !SchemaIdIndex.instance.hasFileDeclarationsFor(reference.targetClass)) {
        return 'no-coverage';
    }
    if (ids.has(reference.value)) return 'resolved';
    // A label field never resolves by design (checked before the per-id consults, since one field
    // verdict covers every value written in it).
    if (reference.fieldName && (await isVanillaLabelField(reference.fieldName, reference.targetClass, cancellationToken))) {
        return 'label-field';
    }
    // A declaration shape somewhere the rooted harvest cannot classify (an unrooted resource file,
    // a mod's own buffs collection, an action payload) still proves the id exists. Marker classes
    // are exempt from this leniency: their usage-defined harvest is complete by construction, so a
    // class-blind shape match could only shadow a real finding (a codex tutorial whose
    // `ID = scorched` must not excuse a dead `scorched` resistance key).
    if (
        !MARKER_CLASSES.has(reference.targetClass) &&
        (await declaredAnywhereLoosely(reference.value, folderPaths, cancellationToken))
    ) {
        return 'declared-loosely';
    }
    // A vanilla leftover: the base game's own files reference the id too, so it is not a typo
    // introduced here (lazy, one scan per unique unknown id per session).
    if (await referencedInGameTree(reference.targetClass, reference.value, cancellationToken)) return 'vanilla-leftover';
    // The id may come from a dependency mod outside the workspace (a part of a base pack, a tag
    // another mod's sysgen declares): consult the installed workshop mods before flagging
    // (lazy, one scan per unique unknown id per session).
    if (await declaredInInstalledMods(reference.targetClass, reference.value, cancellationToken)) {
        return 'dependency-declared';
    }
    return 'unresolved';
};
