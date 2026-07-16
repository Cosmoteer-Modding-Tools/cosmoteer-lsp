import { dirname, resolve } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { foldPathCase } from '../../workspace/fs-cache';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { collectRulesFiles, readFilesAhead } from './workspace-files';

/**
 * Every `<…>` path a rules text writes whose file part is a `.txt`. Matched on the raw text rather
 * than the parsed AST, so a ref the parser could not reach (a file whose own syntax is broken) still
 * counts, and a commented-out ref counts too. Both over-approximate, which is the safe direction for
 * a gate that suppresses diagnostics.
 */
const TXT_REFERENCE = /<([^<>\n]*\.txt)>/gi;

/** A cheap pre-filter so a text holding no `.txt` at all skips the scan. Case-insensitive to match
 *  {@link TXT_REFERENCE}, since the game reads paths through a case-insensitive filesystem. */
const TXT_HINT = /\.txt/i;

/**
 * The candidate on-disk paths one `<…>` ref could name, as case-folded keys. The game resolves a
 * plain ref against the declaring file's own directory and a `./Data` ref against the game root, and
 * a workshop escape (`<./Data/../../../workshop/…>`) walks out of the game root, so all three bases
 * are offered. No existence check runs: the set is only ever probed with real on-disk paths, so a
 * candidate naming nothing simply never matches, and probing would cost a stat per ref.
 *
 * @param inner the ref's inner path, without the angle brackets.
 * @param fromDir the directory of the file that wrote the ref.
 * @param dataRoot the game `Data` root, when one is known.
 * @returns the case-folded candidate keys.
 */
const candidateKeys = (inner: string, fromDir: string, dataRoot: string | undefined): string[] => {
    const relative = inner.trim().replace(/\\/g, '/').replace(/^\.\/data\//i, '');
    const bases = [fromDir];
    if (dataRoot) bases.push(dataRoot, dirname(dataRoot));
    const keys: string[] = [];
    for (const base of bases) {
        try {
            keys.push(foldPathCase(resolve(base, relative)));
        } catch {
            /* a malformed path resolves to nothing worth recording */
        }
    }
    return keys;
};

/**
 * The `.txt` files some rules text in the project references by path, as case-folded keys.
 *
 * The game's loader ignores the extension, so a mod may keep real rules in a `.txt` and pull it in
 * with `&<…>`, an inheritance base, or a mod-action target. Nothing auto-discovers a `.txt` though,
 * so a `.txt` nothing names is not rules content (the game's own `Data/credits.txt`, a readme, a
 * decal whitelist, a stale backup). This is the reference half of that test.
 *
 * The scan reads text rather than consulting the rooting indexes. The reverse-include index looks
 * like the natural source and is not: it records an include only when the include's slot types (see
 * its `collectIncludes`), so it deliberately drops deep refs (`&<reac.txt>/Part`) and refs written by
 * a container it could not root. Those drops are correct for typing and would be silent diagnostic
 * suppression here, which measured at a quarter of the referenced `.txt` files in the workshop corpus.
 *
 * @param folderPaths the project folders (the mod plus the game `Data` tree) to scan.
 * @param token cancels the walk between files.
 * @returns the referenced keys, or undefined when the project holds no `.txt` at all (no gate needed).
 */
export const collectReferencedTxtKeys = async (
    folderPaths: string[],
    token: CancellationToken
): Promise<Set<string> | undefined> => {
    const files: string[] = [];
    let sawTxt = false;
    for (const folder of folderPaths) {
        for await (const file of collectRulesFiles(folder)) {
            if (token.isCancellationRequested) return undefined;
            files.push(file);
            if (!sawTxt && file.toLowerCase().endsWith('.txt')) sawTxt = true;
        }
    }
    // A project without a single `.txt` can never trip the gate, so it pays nothing for it.
    if (!sawTxt) return undefined;

    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    const referenced = new Set<string>();
    for await (const { file, text } of readFilesAhead(files)) {
        if (token.isCancellationRequested) return undefined;
        if (!text || !TXT_HINT.test(text)) continue;
        const fromDir = dirname(file);
        for (const match of text.matchAll(TXT_REFERENCE)) {
            // A ref naming nothing but the extension names no file. Anything else is resolved even
            // when it looks odd, since a candidate that names nothing is harmless and skipping one
            // that does would suppress a real file's diagnostics.
            if (match[1].trim().length <= '.txt'.length) continue;
            for (const key of candidateKeys(match[1], fromDir, dataRoot)) referenced.add(key);
        }
    }
    return referenced;
};
