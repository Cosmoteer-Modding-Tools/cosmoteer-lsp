import { CancellationToken } from 'vscode-languageserver';
import { dirname, isAbsolute, join } from 'path';
import {
    AbstractNodeDocument,
    ListNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import {
    MANIFEST_MEMBERS,
    MANIFEST_MEMBER_NAMES,
    ManifestEntry,
    ManifestMember,
    SHIP_LIBRARY_MEMBERS,
    SHIP_LIBRARY_MEMBER_NAMES,
    isManifestMember,
    isShipLibraryMember,
    isValidModId,
    manifestEntries,
    manifestMemberFor,
} from '../../mod/mod-manifest';
import { closestMatch } from '../../utils/did-you-mean';
import { cachedDirLookup } from '../../workspace/fs-cache';
import { uriToFsPath } from '../navigation/workspace-files';
import { referencedSegments } from './validator.ignored-field';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * The value types the parser marks as on-disk assets, which the value validator already resolves.
 * Mirrors `isAssetValue` in features/navigation/asset-resolver.ts.
 */
const ASSET_VALUE_TYPES: ReadonlySet<string> = new Set(['Sprite', 'Sound', 'Shader']);

/**
 * The finding for a member the model does not know, or nothing when the name decides nothing on its
 * own. Three shapes are left alone. A bare named group is how a loader mod that ships a `.dll`
 * reads its own configuration out of the manifest, and it is the shape the ignored-field pass
 * leaves alone for the same reason. A name that a reference in the file reads is the constant idiom
 * the game's own `huge_crews` manifest uses (`MAX_CREW = 100000`, read back as `&~/MAX_CREW`). And a
 * name nowhere near a real member is just an extra key, which the game ignores in silence, so only a
 * plausible typo of a member is worth saying anything about.
 *
 * @param entry the member to judge.
 * @param candidates the member spellings the container accepts.
 * @param segments the path segments the file's own references read.
 * @returns the finding, or undefined when the member is left alone.
 */
const unknownMemberError = (
    entry: ManifestEntry,
    candidates: string[],
    segments: Set<string>
): ValidationError | undefined => {
    if (entry.bareGroup) return undefined;
    if (segments.has(entry.name.toLowerCase())) return undefined;
    const suggestion = closestMatch(entry.name, candidates, true);
    if (!suggestion) return undefined;
    return {
        message: l10n.t("'{0}' is not a manifest field. Did you mean '{1}'?", entry.name, suggestion),
        node: entry.identifier,
        severity: 'warning',
        additionalInfo: l10n.t(
            'The game reads no field of that name from a manifest, so what is written here has no effect'
        ),
        data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } },
    };
};

/**
 * Whether a relative path exists under `baseDir`, folding case on every segment. The game resolves
 * through the case-insensitive Windows filesystem, so a `Strings` folder written as `strings` loads
 * for its author and must not be reported for somebody editing the same mod on a case-sensitive
 * filesystem. A cancelled walk answers true, which keeps the pass silent rather than guessing.
 *
 * @param baseDir the directory the value is relative to.
 * @param relative the written path value.
 * @param cancellationToken cancels between directory listings.
 * @returns true when every segment resolves.
 */
const existsUnder = async (
    baseDir: string,
    relative: string,
    cancellationToken: CancellationToken
): Promise<boolean> => {
    let current = baseDir;
    for (const segment of relative.replace(/\\/g, '/').split('/')) {
        if (cancellationToken.isCancellationRequested) return true;
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            current = dirname(current);
            continue;
        }
        const lookup = await cachedDirLookup(current).catch(() => undefined);
        const real = lookup?.get(segment.toLowerCase());
        if (!real) return false;
        current = join(current, real);
    }
    return true;
};

/**
 * The finding for a path member whose target is not on disk. Only the mod-relative form is judged.
 * A rooted value and a `./` value are read against the game's own working directory rather than
 * against the mod, which this pass has no reason to assume it knows. An asset-typed value is left to
 * the value validator, which already resolves sprites, sounds and shaders and would otherwise report
 * the same file twice.
 *
 * @param entry the path member to judge.
 * @param member the model entry naming what kind of path it is.
 * @param manifestPath the on-disk path of the manifest.
 * @param cancellationToken cancels the directory walk.
 * @returns the finding, or undefined when the path resolves or is not judged.
 */
const missingPathError = async (
    entry: ManifestEntry,
    member: ManifestMember,
    manifestPath: string,
    cancellationToken: CancellationToken
): Promise<ValidationError | undefined> => {
    if (!isAssignmentNode(entry.element) || !isValueNode(entry.element.right)) return undefined;
    const value = entry.element.right;
    // The same three types isAssetValue names, tested directly: the node is already a ValueNode, so
    // a guard that narrows to one would leave the other branch typed as never.
    if (ASSET_VALUE_TYPES.has(value.valueType.type)) return undefined;
    const written = String(value.valueType.value).trim();
    if (!written || isAbsolute(written) || written.startsWith('./') || written.startsWith('.\\')) return undefined;
    if (await existsUnder(dirname(manifestPath), written, cancellationToken)) return undefined;
    return {
        message:
            member.path === 'folder'
                ? l10n.t('The folder "{0}" does not exist', written)
                : l10n.t('The file "{0}" does not exist', written),
        node: value,
        severity: 'warning',
        additionalInfo: l10n.t('The path is read relative to the folder this manifest is in'),
    };
};

/**
 * The finding for an `ID` the game rejects. Only a written literal is judged, since a
 * reference-valued id is whatever it resolves to and this pass does not follow it.
 *
 * @param entry the `ID` member.
 * @returns the finding, or undefined when the id is fine or is not a literal.
 */
const malformedIdError = (entry: ManifestEntry): ValidationError | undefined => {
    if (!isAssignmentNode(entry.element) || !isValueNode(entry.element.right)) return undefined;
    const value = entry.element.right;
    if (value.valueType.type !== 'String' && value.valueType.type !== 'Number') return undefined;
    const written = String(value.valueType.value);
    if (isValidModId(written)) return undefined;
    return {
        message: l10n.t("The mod ID '{0}' is not in the 'author_name.mod_name' form", written),
        node: value,
        additionalInfo: l10n.t(
            'A mod ID needs a name on each side of a dot, otherwise the game refuses to load the mod'
        ),
    };
};

/**
 * The findings inside a `ShipLibraries` list: a near-miss member name, a folder that is not on disk,
 * and an entry that leaves out a member the deserializer throws on. An entry that inherits is only
 * checked for names, since the members it takes from its base are not written here.
 *
 * @param entry the `ShipLibraries` member.
 * @param manifestPath the on-disk path of the manifest.
 * @param segments the path segments the file's own references read.
 * @param cancellationToken cancels the folder lookups.
 * @returns the findings for every entry of the list.
 */
const shipLibraryErrors = async (
    entry: ManifestEntry,
    manifestPath: string,
    segments: Set<string>,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const list: ListNode | undefined = isListNode(entry.element)
        ? entry.element
        : isAssignmentNode(entry.element) && isListNode(entry.element.right)
          ? entry.element.right
          : undefined;
    const errors: ValidationError[] = [];
    for (const element of list?.elements ?? []) {
        if (cancellationToken.isCancellationRequested) return errors;
        if (!isGroupNode(element)) continue;
        const members = manifestEntries(element);
        for (const member of members) {
            if (!isShipLibraryMember(member.name)) {
                const unknown = unknownMemberError(member, SHIP_LIBRARY_MEMBER_NAMES, segments);
                if (unknown) errors.push(unknown);
                continue;
            }
            const model = manifestMemberFor(member.name, SHIP_LIBRARY_MEMBERS);
            if (!model?.path) continue;
            const pathError = await missingPathError(member, model, manifestPath, cancellationToken);
            if (pathError) errors.push(pathError);
        }
        if ((element.inheritance ?? []).length > 0) continue;
        const present = new Set(members.map((member) => member.name.toLowerCase()));
        for (const model of SHIP_LIBRARY_MEMBERS) {
            if (!model.required || present.has(model.name.toLowerCase())) continue;
            errors.push({
                message: l10n.t("The ship library has no '{0}'", model.name),
                node: element,
                additionalInfo: l10n.t(
                    'The game refuses to load a mod whose ship library does not have "{0}"',
                    model.name
                ),
            });
        }
    }
    return errors;
};

/**
 * Whole-document pass over a manifest's metadata, modeled on `Cosmoteer.Mods.ModInfo` (see
 * {@link MANIFEST_MEMBERS}). It reports four things and stays silent wherever the file does not
 * decide the answer:
 *  - a missing `ID` or `Name`, without which the game never loads the mod,
 *  - an `ID` the game rejects, with the same effect,
 *  - a member name that is a near miss of a real one, see {@link unknownMemberError},
 *  - a `StringsFolder`, `Logo` or ship-library `Folder` that is not on disk.
 *
 * The missing-member check needs the file to declare at least one member the game knows, so a
 * `mod_*.rules` that holds data rather than metadata, and a file still being typed, are left alone.
 * It runs as its own pass rather than through the AstType-keyed `Validator`, which holds one
 * callback per node type.
 *
 * @param document the parsed manifest.
 * @param cancellationToken cancels the path lookups.
 * @returns the findings, empty for any file that is not a manifest.
 */
export const validateModManifest = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (!isModRules(document.uri)) return [];
    const entries = manifestEntries(document);
    const anchor = entries[0];
    if (!anchor) return [];
    const errors: ValidationError[] = [];
    const segments = referencedSegments(document);
    const manifestPath = uriToFsPath(document.uri);
    const present = new Set(entries.map((entry) => entry.name.toLowerCase()));

    if (entries.some((entry) => isManifestMember(entry.name))) {
        for (const member of MANIFEST_MEMBERS) {
            if (!member.required) continue;
            if ([member.name, ...(member.aliases ?? [])].some((name) => present.has(name.toLowerCase()))) continue;
            errors.push({
                message: l10n.t("The manifest has no '{0}'", member.name),
                node: anchor.identifier,
                additionalInfo: l10n.t('The game only loads a mod whose manifest declares "{0}"', member.name),
            });
        }
    }

    for (const entry of entries) {
        if (cancellationToken.isCancellationRequested) return errors;
        const member = manifestMemberFor(entry.name, MANIFEST_MEMBERS);
        if (!member) {
            const unknown = unknownMemberError(entry, MANIFEST_MEMBER_NAMES, segments);
            if (unknown) errors.push(unknown);
            continue;
        }
        if (member.name === 'ID') {
            const idError = malformedIdError(entry);
            if (idError) errors.push(idError);
        }
        if (member.path) {
            const pathError = await missingPathError(entry, member, manifestPath, cancellationToken);
            if (pathError) errors.push(pathError);
        }
        if (member.name === 'ShipLibraries') {
            errors.push(...(await shipLibraryErrors(entry, manifestPath, segments, cancellationToken)));
        }
    }
    return errors;
};
