import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { AbstractNode, isAssignmentNode, isGroupNode, isListNode, isValueNode, ValueNode } from '../../core/ast/ast';
import { Action, ActionVerb } from '../../mod/action';
import { parseModActions } from '../../mod/action-parser';
import { normalizeTargetPath } from '../../mod/action-target-resolver';
import { identityOfMod, manifestPathsIn, readManifest, scalarMember } from '../../mod/mod-dependencies';
import { findModRoot, sameModRoot } from '../../mod/mod-root';
import { localModDirs, workshopContentDir } from '../../workspace/workshop-dir';
import { ValidationError } from './validator';

/**
 * The verbs that take the target away from whoever wrote it first. Each one replaces or deletes the
 * node it names, so two mods aiming at one node cannot both have their way and the one the game
 * applies last is the one that stands.
 */
const DESTRUCTIVE_VERBS: ReadonlySet<ActionVerb> = new Set<ActionVerb>(['Replace', 'Remove', 'RemoveMany']);

/** How deep a merged override group is walked for the members it writes. */
const MAX_OVERRIDE_DEPTH = 8;

/** One node an action claims, keyed so two mods claiming the same thing compare equal. */
export interface Claim {
    /** The claimed path, folded, either a target node or one member written into it. */
    readonly key: string;
    /** The verb behind the claim, which decides the sentence the finding writes. */
    readonly verb: ActionVerb;
}

/** Everything one installed mod claims, with the identity a finding names it by. */
export interface ModClaims {
    readonly root: string;
    /** The manifest `ID`, which is what the game sorts the load order by. */
    readonly id: string;
    readonly name: string;
    readonly claims: ReadonlyMap<string, ActionVerb>;
}

/**
 * The member paths a group writes, one per leaf, so two overrides can be compared by what they
 * actually set rather than by the node they both merge into. An override merges member by member,
 * so two mods writing disjoint members of one group both take effect.
 *
 * @param node the group to walk.
 * @param prefix the path walked so far.
 * @param depth the remaining walk depth.
 * @returns the member paths, in document order.
 */
function* writtenMembersOf(node: AbstractNode, prefix: string, depth: number): Generator<string> {
    if (depth <= 0 || !isGroupNode(node)) return;
    for (const element of node.elements) {
        const named = isAssignmentNode(element)
            ? { name: element.left.name, value: element.right }
            : (isGroupNode(element) || isListNode(element)) && element.identifier
              ? { name: element.identifier.name, value: element as AbstractNode }
              : undefined;
        if (!named?.value) continue;
        const path = prefix ? `${prefix}/${named.name}` : named.name;
        // A group is walked for its own members. Everything else is written whole, a list
        // included: an inline list replaces the one it lands on rather than merging into it.
        if (isGroupNode(named.value)) yield* writtenMembersOf(named.value, path, depth - 1);
        else yield path;
    }
}

/**
 * What one action claims. A destructive verb claims the node it names. An override claims each
 * member it writes into the target, since that is the granularity the game merges at. An override
 * whose source is a reference to another file claims nothing here, because the members it carries
 * cannot be read without following it, and claiming the target instead would report two mods that
 * never touch the same member.
 *
 * @param action the parsed action.
 * @returns the claims, empty for a verb that only adds.
 */
export const claimsOf = (action: Action): Claim[] => {
    if (action.type === 'Unknown') return [];
    const verb = action.type;
    const targets = action.targets.map((target) => normalizeTargetPath(String(target.valueType.value)).toLowerCase());
    if (DESTRUCTIVE_VERBS.has(verb)) return targets.map((key) => ({ key, verb }));
    if (verb !== 'Overrides') return [];
    const claims: Claim[] = [];
    for (const target of targets) {
        for (const source of action.sources) {
            if (!isGroupNode(source)) continue;
            for (const member of writtenMembersOf(source, '', MAX_OVERRIDE_DEPTH)) {
                claims.push({ key: `${target}/${member.toLowerCase()}`, verb });
            }
        }
    }
    return claims;
};

/** The mod folders the game loads beside the one being edited: the workshop tree and the user's own. */
const installedModRoots = (): string[] => {
    const roots: string[] = [];
    for (const parent of [workshopContentDir(), ...localModDirs()]) {
        if (!parent) continue;
        let entries: string[];
        try {
            entries = readdirSync(parent);
        } catch {
            continue;
        }
        for (const entry of entries) {
            const root = join(parent, entry);
            try {
                if (statSync(root).isDirectory()) roots.push(root);
            } catch {
                /* a folder that vanished between the listing and the probe */
            }
        }
    }
    return roots;
};

/**
 * The installed mods that are somebody else's work. A mod is regularly edited in one folder and
 * loaded from another: a dev copy under the user's own `Mods` beside the subscribed copy of the
 * same mod, or the same folder reached by a path spelled differently. Neither of those is a
 * conflict with anybody, and both would otherwise report the mod against itself.
 *
 * @param installed every installed mod's claims.
 * @param modRoot the root of the mod being edited.
 * @param ownId the edited mod's manifest id.
 * @returns the mods worth comparing the edited manifest against.
 */
export const otherMods = (installed: readonly ModClaims[], modRoot: string, ownId: string): ModClaims[] =>
    installed.filter((mod) => !sameModRoot(mod.root, modRoot) && mod.id !== ownId);

/**
 * The installed mods' claims, read once per session. A mod subscribed to or updated while the
 * editor is open is picked up on the next start, which is when the game would pick it up too.
 */
let installedClaims: Promise<ModClaims[]> | undefined;

/**
 * Every claim the installed mods make, keyed per mod. Read from their manifests alone, which is
 * where the game reads their actions from too.
 *
 * @returns one entry per installed mod that claims anything.
 */
const readInstalledClaims = async (): Promise<ModClaims[]> => {
    const mods: ModClaims[] = [];
    for (const root of installedModRoots()) {
        const claims = new Map<string, ActionVerb>();
        let id: string | undefined;
        for (const path of manifestPathsIn(root)) {
            const manifest = await readManifest(path);
            if (!manifest) continue;
            id ??= scalarMember(manifest, 'ID');
            for (const action of parseModActions(manifest)) {
                for (const claim of claimsOf(action)) if (!claims.has(claim.key)) claims.set(claim.key, claim.verb);
            }
        }
        if (claims.size === 0 || !id) continue;
        const identity = await identityOfMod(root);
        mods.push({ root, id, name: identity.name ?? id, claims });
    }
    return mods;
};

/**
 * The sentence naming what the other mod does to the same node.
 *
 * @param verb the other mod's verb.
 * @param name the other mod's display name.
 * @param key the claimed path, for an override's member.
 * @returns the message.
 */
const conflictMessage = (verb: ActionVerb, name: string, key: string): string => {
    switch (verb) {
        case 'Replace':
            return l10n.t("'{0}' replaces the same node.", name);
        case 'Remove':
        case 'RemoveMany':
            return l10n.t("'{0}' removes the same node.", name);
        default:
            return l10n.t("'{0}' writes the same member, '{1}'.", name, key.split('/').pop() ?? key);
    }
};

/**
 * Reports an action of this manifest that aims at a node an installed mod already takes for itself.
 * The game applies mods in ordinal order of their manifest `ID` and the last one to write a node is
 * the one that stands, so with both mods enabled one of the two changes is simply not there.
 *
 * Overrides are compared by the members they write rather than by the node they merge into, since
 * an override merges member by member and two mods writing different members of one group both
 * take effect. `Replace`, `Remove` and `RemoveMany` take the whole node, so the target alone
 * decides them.
 *
 * Information severity: neither mod is wrong, and an author may well intend to override another
 * mod. What they cannot see without this is that the other mod exists.
 *
 * @param actions the manifest's parsed actions.
 * @param manifestUri the manifest being validated.
 * @param cancellationToken cancels the installed-mod read.
 * @returns one finding per action that collides with an installed mod.
 */
export const validateModConflicts = async (
    actions: Action[],
    manifestUri: string,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (actions.length === 0) return [];
    const modRoot = findModRoot(manifestUri);
    if (!modRoot) return [];
    // A mod installed under the workshop tree is somebody else's copy, and comparing it against
    // itself would report every one of its own actions as a conflict with itself.
    const workshop = workshopContentDir();
    if (workshop && modRoot.replace(/\\/g, '/').startsWith(workshop.replace(/\\/g, '/'))) return [];

    installedClaims ??= readInstalledClaims().catch(() => []);
    const ownId = (await identityOfMod(modRoot)).manifestId ?? '';
    const installed = otherMods(await installedClaims, modRoot, ownId);
    if (cancellationToken.isCancellationRequested || installed.length === 0) return [];

    const errors: ValidationError[] = [];
    for (const action of actions) {
        if (cancellationToken.isCancellationRequested) return errors;
        const claims = claimsOf(action);
        if (claims.length === 0) continue;
        const anchor: ValueNode | undefined = action.targets.find(isValueNode);
        if (!anchor) continue;
        const named = new Set<string>();
        for (const claim of claims) {
            for (const mod of installed) {
                const theirVerb = mod.claims.get(claim.key);
                if (!theirVerb || named.has(mod.root)) continue;
                named.add(mod.root);
                // The game sorts the mods it loads by manifest id, ordinal, and applies them in
                // that order, so the higher id writes last and its version is the one that stands.
                const winner = ownId > mod.id ? l10n.t('this mod') : mod.name;
                errors.push({
                    message: `${conflictMessage(theirVerb, mod.name, claim.key)} ${l10n.t(
                        'The game applies mods in id order, so with both enabled {0} wins.',
                        winner
                    )}`,
                    node: anchor,
                    severity: 'information',
                });
            }
        }
    }
    return errors;
};
