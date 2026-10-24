import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNodeDocument, descendants, isAssignmentNode, isGroupNode, isValueNode } from '../../core/ast/ast';
import { isManifestBasename, isModRules } from '../../document/document-kind';
import { compareVersionNumbers, isAheadOfInstalledGame } from '../../document/schema/deprecations';
import { classAncestry } from '../../document/schema/schema';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { findModRoot } from '../../mod/mod-root';
import { flattenGroup } from '../../semantics/effective-group';
import { safeReaddir } from '../../utils/fs.utils';
import { resourceDeclaration, STORAGE_CLASS, topLevelMember } from '../diagnostics/validator.resource-pickup';
import { declaredCompatibleVersions } from '../game-version';
import { readManifest } from '../mod-report/mod-dependencies';
import { ManualFinding } from '../../../../shared/migration.types';

/** The release that made every resource storage run its resource's death effects. */
const CHANGED_IN = '0.30.5';

/**
 * Whether the mod a file belongs to was written for a game older than {@link CHANGED_IN}: no
 * manifest of it names that version or a newer one. A file outside any mod is not judged.
 *
 * @param uri the file's uri.
 * @returns true when the mod's manifests predate the change.
 */
const modPredatesChange = async (uri: string): Promise<boolean> => {
    const root = findModRoot(uri);
    if (!root) return false;
    for (const name of safeReaddir(root)) {
        if (!isManifestBasename(name)) continue;
        const manifest = await readManifest(`${root}/${name}`);
        const declared = manifest ? declaredCompatibleVersions(manifest) : undefined;
        if (declared?.some((version) => compareVersionNumbers(version, CHANGED_IN) >= 0)) return false;
    }
    return true;
};

/**
 * Review notes for the storages a 0.30.5 update changes without renaming anything.
 *
 * Since 0.30.5 every resource storage plays its resource's `DeathHitEffects` and
 * `DeathMediaEffects` when the part is destroyed or scorched, scaled by full stacks, where before
 * only storage bays did. So a cannon, launcher or factory that keeps a volatile resource inside now
 * explodes. That is the game's own fix and applies to mods too, so nothing is rewritten. A storage
 * of a mod written for an older game is pointed out instead, when it names a resource with death
 * effects and does not decide `DoResourceDeathEffects` itself. Storage bays are a different class
 * and never match.
 *
 * @param document the parsed rules file.
 * @param doc the file's text, for line numbers.
 * @param folderPaths the project folders the resource lookup reads through.
 * @param token cancels the walk.
 * @returns the notes, in source order.
 */
export const storageDeathEffectNotes = async (
    document: AbstractNodeDocument,
    doc: TextDocument,
    folderPaths: string[],
    token: CancellationToken
): Promise<ManualFinding[]> => {
    if (isModRules(document.uri) || isAheadOfInstalledGame(CHANGED_IN)) return [];
    const notes: ManualFinding[] = [];
    let predates: boolean | undefined;
    for (const node of descendants(document)) {
        if (token.isCancellationRequested) return notes;
        if (!isGroupNode(node)) continue;
        const cls = resolveGroupClass(node);
        if (!cls || !classAncestry(cls).includes(STORAGE_CLASS)) continue;
        // The note sits where the resource is chosen, so a storage inheriting it is not reported twice.
        const written = node.elements.find(
            (element) => isAssignmentNode(element) && element.left.name.toLowerCase() === 'resourcetype'
        );
        if (!written || !isAssignmentNode(written) || !written.right || !isValueNode(written.right)) continue;
        if (written.right.valueType.type === 'Reference') continue;
        predates ??= await modPredatesChange(document.uri);
        if (!predates) return [];
        const folded = await flattenGroup(node, token).catch(() => null);
        if (!folded || !folded.complete) continue;
        if (folded.members.some((member) => member.name.toLowerCase() === 'doresourcedeatheffects')) continue;
        const resource = await resourceDeclaration(String(written.right.valueType.value).trim(), folderPaths, token);
        if (!resource) continue;
        if (
            !topLevelMember(resource.document, 'DeathHitEffects') &&
            !topLevelMember(resource.document, 'DeathMediaEffects')
        )
            continue;
        notes.push({
            uri: doc.uri,
            line: doc.positionAt(written.left.position.start).line + 1,
            message: l10n.t(
                "Since {0}, this storage plays the death effects of '{1}' when the part is destroyed or scorched, scaled by the number of full stacks it holds. Before, only storage bays did. Add 'DoResourceDeathEffects = false' to keep the old behavior, or '= true' to keep the new one and drop this note.",
                CHANGED_IN,
                resource.id
            ),
        });
    }
    return notes;
};
