import * as l10n from '@vscode/l10n';
import { CancellationToken, CodeLens, Range } from 'vscode-languageserver';
import { isModRules } from '../../document/document-kind';
import { computeModReachability, ModReachability, reachabilityKey, relativeToMod } from '../../mod/mod-reachability';
import { findModRoot } from '../../mod/mod-root';
import { isStringsFile } from '../../mod/strings-folder';
import { uriToFsPath } from '../navigation/workspace-files';

/**
 * Code lenses over a `.rules` file, the server side of the two clients' own lens providers.
 *
 * The one thing a file cannot say about itself is whether the game ever reads it. A mod loads the
 * closure of its manifest's action sources and their includes, and everything outside that closure
 * is content the author is still editing and the game never sees. Nothing in the file says so, the
 * editor shows it exactly like a file that loads, and the mistake survives until somebody wonders
 * why the change did nothing.
 *
 * The lens is emitted with its range alone and the sentence is filled in on resolve, so opening a
 * file costs a range and the closure is only walked for a lens the editor actually shows.
 */

/** Marks a lens as this provider's, and says which file it is about, across the resolve round trip. */
interface ReachabilityLensData {
    readonly kind: 'reachability';
    readonly uri: string;
}

/** Per-mod closures, so a file-by-file question does not re-walk the mod for every file. */
const reachabilityByRoot = new Map<string, Promise<ModReachability | undefined>>();

/** Drops the memoized closures, so a file added or renamed is seen by the next lens. */
export const invalidateCodeLensCache = (): void => {
    reachabilityByRoot.clear();
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
    // A cancelled walk returns a partial closure, in which a reachable file reads as dead content,
    // so it is dropped instead of memoized.
    if (!reachability || cancellationToken.isCancellationRequested) {
        reachabilityByRoot.delete(modRoot);
        return undefined;
    }
    return reachability;
};

/**
 * The lenses a document carries, ranges only. One lens on the first line, saying whether the mod
 * loads the file. A manifest is what the closure is seeded from and a language file is loaded by
 * the strings folder rather than by an action, so neither gets one.
 *
 * @param uri the document's uri.
 * @param cancellationToken cancels the strings-folder resolution.
 * @returns the unresolved lenses, empty for a file the question does not apply to.
 */
export const codeLensesFor = async (uri: string, cancellationToken: CancellationToken): Promise<CodeLens[]> => {
    if (isModRules(uri) || !findModRoot(uri)) return [];
    if (await isStringsFile(uri, cancellationToken).catch(() => false)) return [];
    const data: ReachabilityLensData = { kind: 'reachability', uri };
    return [{ range: Range.create(0, 0, 0, 0), data }];
};

/**
 * Fills in a lens's sentence. A file the closure never reached is named as one the mod does not
 * load, together with the files that mention it, which is where the chain was cut. A file the walk
 * could not be completed for gets no sentence rather than a guess.
 *
 * @param lens the lens the client handed back.
 * @param cancellationToken cancels the closure walk.
 * @returns the lens, with a title when there is one to give.
 */
export const resolveCodeLens = async (lens: CodeLens, cancellationToken: CancellationToken): Promise<CodeLens> => {
    const data = lens.data as ReachabilityLensData | undefined;
    if (data?.kind !== 'reachability') return lens;
    const modRoot = findModRoot(data.uri);
    if (!modRoot) return lens;
    const reachability = await reachabilityOf(modRoot, cancellationToken);
    if (!reachability) return lens;
    const fsPath = uriToFsPath(data.uri);
    const key = reachabilityKey(fsPath);
    if (!reachability.allRulesFiles.some((file) => reachabilityKey(file) === key)) return lens;
    if (reachability.reachable.has(key)) {
        return { ...lens, command: { title: l10n.t('The mod loads this file'), command: '' } };
    }
    const referencedBy: string[] = reachability.deadReferencers.get(key) ?? [];
    const title =
        referencedBy.length > 0
            ? l10n.t(
                  'The mod does not load this file. It is mentioned in {0}, which either is not loaded either or names it inside a comment.',
                  referencedBy.map((file) => relativeToMod(modRoot, file)).join(', ')
              )
            : l10n.t('The mod does not load this file. No action, include or inheritance in the mod reaches it.');
    return { ...lens, command: { title, command: '' } };
};
