import { readFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { isValueNode } from '../core/ast/ast';
import {
    claimsOf,
    installedModClaims,
    manifestActionsWithFragments,
    otherMods,
} from '../features/diagnostics/validator.mod-conflict';
import { getStartOfAstNode, parseText } from '../utils/ast.utils';
import { workshopContentDir } from '../workspace/workshop-dir';
import { ActionVerb } from './action';
import { identityOfMod, manifestPathsIn } from './mod-dependencies';

/**
 * What the mod being edited and an installed mod both take for themselves.
 *
 * The game loads mods in ordinal order of their manifest id and the last write to a node is the one
 * that stands, so two mods claiming one node means one of the two changes is simply not there for a
 * player who has both. Neither mod is wrong about it: overriding another mod on purpose is ordinary
 * work. What an author cannot see on their own is that the other mod exists at all.
 *
 * The comparison is the one the shipped conflict check makes, so the report and the findings on the
 * manifest can never disagree: a destructive verb claims the node it names, and an override claims
 * each member it writes into the target, since the game merges an override member by member and two
 * mods writing different members of one group both take effect.
 */

/** One collision between this mod and an installed one. */
export interface ModConflict {
    /** The installed mod's display name. */
    readonly modName: string;
    /** The installed mod's manifest id, which decides the load order. */
    readonly modId: string;
    /** What the installed mod does to the claimed node. */
    readonly theirVerb: ActionVerb;
    /** What this mod does to it. */
    readonly ownVerb: ActionVerb;
    /** The claimed path: a target node, or one member written into it. */
    readonly key: string;
    /** The target this mod's action writes, as it is written. */
    readonly target: string;
    /** Whether this mod is the one the game applies last. */
    readonly ownsLastWord: boolean;
    /** The manifest the action is written in. */
    readonly file: string;
    /** The one-based line the action's target sits on. */
    readonly line: number;
}

/**
 * The one-based line an offset sits on.
 *
 * @param text the file's source text.
 * @param offset the byte offset into it.
 * @returns the line number, counted from one.
 */
const lineAt = (text: string, offset: number): number => {
    let line = 1;
    for (let at = 0; at < offset && at < text.length; at++) if (text.charCodeAt(at) === 10) line++;
    return line;
};

/**
 * Every node this mod and an installed mod both claim.
 *
 * A mod inside the subscribed workshop tree is somebody else's copy and is not compared at all,
 * since it would be read as conflicting with itself.
 *
 * @param modRoot the root of the mod being edited.
 * @param token cancels the manifest reads.
 * @returns one entry per collision, in the order the manifests write them.
 */
export const modConflicts = async (modRoot: string, token: CancellationToken): Promise<ModConflict[]> => {
    const workshop = workshopContentDir();
    if (workshop && modRoot.replace(/\\/g, '/').startsWith(workshop.replace(/\\/g, '/'))) return [];
    const ownId = (await identityOfMod(modRoot).catch(() => undefined))?.manifestId ?? '';
    const installed = otherMods(await installedModClaims(), modRoot, ownId);
    if (installed.length === 0 || token.isCancellationRequested) return [];

    const conflicts: ModConflict[] = [];
    const seen = new Set<string>();
    for (const manifestPath of manifestPathsIn(modRoot)) {
        if (token.isCancellationRequested) return conflicts;
        const text = await readFile(manifestPath, { encoding: 'utf-8' }).catch(() => null);
        if (text === null) continue;
        let actions;
        try {
            actions = await manifestActionsWithFragments(manifestPath, parseText(text, pathToFileURL(manifestPath).href));
        } catch {
            continue;
        }
        for (const action of actions) {
            const anchor = action.targets.find(isValueNode);
            if (!anchor || action.type === 'Unknown') continue;
            for (const claim of claimsOf(action)) {
                for (const mod of installed) {
                    const theirVerb = mod.claims.get(claim.key);
                    if (!theirVerb) continue;
                    const identity = `${mod.root}::${claim.key}`;
                    if (seen.has(identity)) continue;
                    seen.add(identity);
                    conflicts.push({
                        modName: mod.name,
                        modId: mod.id,
                        theirVerb,
                        ownVerb: action.type,
                        key: claim.key,
                        target: String(anchor.valueType.value),
                        // The game sorts by manifest id, ordinal, so the higher id writes last.
                        ownsLastWord: ownId > mod.id,
                        file: manifestPath,
                        // An action of an inherited fragment carries its own file's offsets, which
                        // this manifest's text cannot place, so it is reported on the manifest's
                        // first line rather than at a line belonging to another file.
                        line:
                            getStartOfAstNode(anchor).uri === pathToFileURL(manifestPath).href
                                ? lineAt(text, anchor.position.start)
                                : 1,
                    });
                }
            }
        }
    }
    return conflicts;
};
