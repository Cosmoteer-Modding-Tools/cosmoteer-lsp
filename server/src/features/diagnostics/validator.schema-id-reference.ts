import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { registryOf, typeDef } from '../../document/schema/schema';
import { entityDeclarationsOf, SELF_KEYED_MAP_FIELDS } from '../../document/schema/entity-schema';
import { MARKER_CLASSES } from '../../document/schema/category-usage';
import { SchemaIdIndex } from '../completion/schema-id.index';
import { isSameOrSubclass, schemaReferenceFieldOf, mapKeyReferencesOf } from '../navigation/schema-id-reference.navigation';
import { stringValueNodesOf } from '../navigation/schema-reference.navigation';
import { normalizeUri } from '../navigation/reference-location';
import { documentsMentioning } from '../navigation/workspace-files';
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
        yield { node: key.node, targetClass: key.targetClass, value: key.value, fieldName: key.fieldName };
    }
}

/**
 * Every `ID<X>` reference class is judged; no class is allowlisted or excluded by name. The layers
 * that make that safe are each mechanical:
 *  - a class whose declarations the harvest cannot see at all has no ids to judge against (the
 *    no-coverage skip in {@link judgeIdReference}),
 *  - part-component targets are part-local (nesting, inherited bases, includes), the sibling
 *    validator's domain, derived here from the schema's registry,
 *  - self-keyed map targets declare through their keys, so an unknown key is a new instance,
 *    derived from the schema's map shapes,
 *  - label fields that borrow the id type without the engine ever resolving them derive from the
 *    base game's own usage ({@link isVanillaLabelField}),
 *  - an id written in a declaration shape anywhere in the project, rooted or not, is never flagged
 *    ({@link declaredAnywhereLoosely}: unrooted whole-file roots, a mod's own alias collections,
 *    groups a mod.rules action adds),
 *  - vanilla's own leftovers exempt through {@link referencedInGameTree}, dependency mods through
 *    {@link declaredInInstalledMods}.
 * The vanilla scan (zero contract plus the pinned exemption set) and the mods scan triage stay the
 * honesty check for all of it.
 */
const SELF_KEYED_TARGETS: ReadonlySet<string> = new Set(SELF_KEYED_MAP_FIELDS.values());

/** Whether id references targeting `cls` are judged at all (see the layer notes above). */
export const isValidatedIdClass = (cls: string): boolean =>
    registryOf(cls)?.name !== 'PartComponentRules' && !SELF_KEYED_TARGETS.has(cls);

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
    if (looseDeclarationVerdicts.size >= INSTALLED_MOD_VERDICTS_CAP) looseDeclarationVerdicts.clear();
    looseDeclarationVerdicts.set(key, declared);
    return declared;
};

/**
 * True when `document` writes `id` in a declaration shape: an `ID = <id>` assignment, a named
 * container `<id>`, or an alias assignment `<id> = &…` whose reference value derives the instance
 * from another one (a mod's `MyBuff = &BaseBuff`). A scalar-valued assignment (`fire = 50%`) is not
 * declaration-shaped: map keys with plain values are the reference side of their relation.
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
        (ref) => isValidatedIdClass(ref.targetClass) && isJudgeableReference(ref)
    );
    if (references.length === 0) return [];

    const errors: ValidationError[] = [];
    const idsByClass = new Map<string, Set<string>>();
    for (const reference of references) {
        if (cancellationToken.isCancellationRequested) return errors;
        const verdict = await judgeIdReference(reference, folderPaths, idsByClass, cancellationToken);
        if (verdict !== 'unresolved') continue;

        const targetName = typeDef(reference.targetClass)?.name ?? reference.targetClass.split('.').pop()!;
        const ids = idsByClass.get(reference.targetClass) ?? new Set<string>();
        const suggestion = closestMatch(reference.value, [...ids], true);
        errors.push({
            message: l10n.t("No {0} named '{1}' in the project.", targetName, reference.value),
            node: reference.node,
            severity: 'warning',
            ...(suggestion
                ? { data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } } }
                : {}),
        });
    }
    return errors;
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
