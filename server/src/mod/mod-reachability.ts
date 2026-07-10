import { existsSync, readdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { basename, dirname, join, relative, resolve } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, isAssignmentNode, isGroupNode, isListNode, isValueNode } from '../core/ast/ast';
import { parseAlias } from '../document/schema/alias-root';
import { isManifestBasename, isRulesFileName } from '../document/document-kind';
import { parseFilePath } from '../utils/ast.utils';
import { findActionsList, parseModActions } from './action-parser';

/**
 * Which files of a mod the game can actually load, computed from the manifest outward.
 *
 * The game reads a mod's `mod.rules` (and version-specific `mod_*.rules`) manifests and nothing
 * else by convention: every other file is loaded only because an action's source references it, a
 * reached file `&<includes>` or inherits it, or it is a language file under the `StringsFolder`.
 * A `.rules` file outside that closure is dead content — a backup, a template, or something the
 * modder forgot to wire in — which the game silently never parses.
 *
 * The closure is computed over text: every `<…>` occurrence in a reached file is resolved
 * against the file's own directory and the mod root, and kept when it lands on a `.rules` file
 * inside the mod. Comments are stripped first, since commenting out an include is exactly how
 * modders disable content, and counting those refs would mark files reachable the game never
 * loads (a whole prototype folder kept "reachable" by three commented-out lines in a parts list).
 * Beyond that the scan deliberately over-approximates (a `<…>` in a string counts), because a
 * false "reachable" only costs some extra validation while a false "unreachable" would wrongly
 * hide diagnostics or wrongly flag a file as forgotten. Manifests are the one exception: their
 * action *targets* name vanilla locations that would otherwise collide with same-named mod files
 * (an `AddTo = <cosmoteer.rules>` must not mark the mod's own `cosmoteer.rules` reachable), so
 * only their parsed action sources contribute seeds.
 */
export interface ModReachability {
    /** The mod root directory (the folder holding the manifest), forward-slash normalized. */
    modRoot: string;
    /**
     * Manifest file paths (`mod.rules`, `mod_*.rules`) found anywhere under the mod root. The
     * game discovers manifests with `SearchOption.AllDirectories` and picks one by game-version
     * priority, so a nested manifest (a merged sub-mod) can be the one that actually loads.
     */
    manifests: string[];
    /** Every `.rules` file under the mod root (absolute paths). */
    allRulesFiles: string[];
    /** Normalized (lower-case, forward-slash) absolute paths of the reachable `.rules` files. */
    reachable: Set<string>;
    /** The `.rules` files in {@link allRulesFiles} the closure never reached (absolute paths). */
    unreachable: string[];
    /**
     * For each unreachable file (keyed per {@link reachabilityKey}) the files whose text
     * references it (absolute paths). Such a referencer is either unreachable itself (a live
     * reference from a reachable file would have pulled the target in) or a reachable file that
     * references the target only inside a comment (the disabled include that killed the chain).
     * Files absent from the map are referenced by nothing in the mod at all.
     */
    deadReferencers: Map<string, string[]>;
}

/** The canonical set-membership key for a file path on a case-insensitive filesystem. */
export const reachabilityKey = (path: string): string => path.replace(/\\/g, '/').toLowerCase();

/** Every `<…>` occurrence in a file's text, inner text only. */
const FILE_REF_RE = /<([^<>\r\n"]+)>/g;

/**
 * Blanks out `//` line comments and `/*` block comments with spaces, mirroring the lexer's
 * rules: a comment never starts inside a `"…"` string (where `\` escapes the next character) or a
 * `@"…"` verbatim string (where a doubled `""` is a literal quote), and block comments do not
 * nest. Newlines inside comments are kept, so the line-bounded ref regex sees the same lines.
 *
 * @param text the raw file text.
 * @returns the text with every comment replaced by whitespace of the same shape.
 */
const stripComments = (text: string): string => {
    const out = text.split('');
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        const next = text[i + 1];
        if (c === '/' && next === '/') {
            while (i < text.length && text[i] !== '\n') out[i++] = ' ';
            continue;
        }
        if (c === '/' && next === '*') {
            out[i++] = ' ';
            out[i++] = ' ';
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
                if (text[i] !== '\n') out[i] = ' ';
                i++;
            }
            if (i < text.length) {
                out[i++] = ' ';
                out[i++] = ' ';
            }
            continue;
        }
        if (c === '@' && next === '"') {
            i += 2;
            while (i < text.length) {
                if (text[i] === '"') {
                    if (text[i + 1] === '"') {
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (c === '"') {
            i++;
            while (i < text.length) {
                if (text[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (text[i] === '"') {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        i++;
    }
    return out.join('');
};

const rulesFilesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) walk(join(dir, entry.name));
            else if (isRulesFileName(entry.name)) out.push(join(dir, entry.name));
        }
    };
    walk(root);
    return out;
};

/**
 * Resolves one `<…>` ref against the referencing file's directory, then the mod root. Returns the
 * absolute path of the `.rules` file it names inside the mod, or undefined for a vanilla `./Data`
 * ref, a path escaping the mod, a non-`.rules` target, or a file that does not exist. Existence is
 * decided against `knownFiles` (every `.rules` under the mod, per {@link reachabilityKey}), which
 * replaces two `existsSync` calls per ref with set lookups.
 */
const resolveRef = (raw: string, fromDir: string, modRoot: string, knownFiles: Set<string>): string | undefined => {
    const ref = raw.trim().replace(/\\/g, '/');
    if (!ref || /^\.\/data\//i.test(ref)) return undefined;
    const withExtension = /\.[^/.]+$/.test(ref) ? ref : `${ref}.rules`;
    if (!isRulesFileName(withExtension)) return undefined;
    for (const base of [fromDir, modRoot]) {
        const candidate = resolve(base, withExtension);
        if (knownFiles.has(reachabilityKey(candidate))) return candidate;
    }
    return undefined;
};

/** Collects the `<file>` refs of every `&`-reference value inside an action source's subtree. */
const collectSourceRefs = (node: AbstractNode, out: string[]): void => {
    if (isValueNode(node) && node.valueType.type === 'Reference') {
        const alias = parseAlias(String(node.valueType.value));
        if (alias) out.push(alias.fileRef.replace(/^</, '').replace(/>$/, ''));
        return;
    }
    if (isGroupNode(node) || isListNode(node)) {
        for (const element of node.elements) collectSourceRefs(element, out);
    } else if (isAssignmentNode(node) && node.right) {
        collectSourceRefs(node.right, out);
    }
};

/**
 * Computes the reachable-file closure of the mod at `modRoot`.
 *
 * Seeds are the manifests themselves, every file an action source references (through the parsed
 * actions, so vanilla-naming action targets contribute nothing) and every `.rules` under the
 * manifest's `StringsFolder`. Expansion then follows every non-commented `<…>` ref of each
 * reached file. A mod's
 * root `cosmoteer.rules` is NOT a seed: the game applies actions to its own `Data/cosmoteer.rules`
 * and never opens the mod's copy, so that file is reachable only when reached content references it.
 *
 * @param modRoot the directory holding the mod's manifest(s).
 * @param token cancels the walk between files.
 * @returns the closure, or undefined when `modRoot` holds no manifest.
 */
export const computeModReachability = async (
    modRoot: string,
    token: CancellationToken
): Promise<ModReachability | undefined> => {
    const root = modRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    let rootEntries: string[];
    try {
        rootEntries = readdirSync(root);
    } catch {
        return undefined;
    }
    if (!rootEntries.some((entry) => isManifestBasename(entry))) return undefined;

    const allRulesFiles = rulesFilesUnder(root);
    const knownFiles = new Set(allRulesFiles.map((file) => reachabilityKey(file)));
    // The game finds manifests recursively and picks one by game-version priority, so nested
    // manifests (merged sub-mods) seed too. Which one wins depends on the running game version;
    // seeding all of them keeps the union over-approximate in the safe direction.
    const manifests = allRulesFiles.filter((file) => isManifestBasename(basename(file)));

    const queue: string[] = [];
    const reachable = new Set<string>();
    const enqueue = (path: string | undefined): void => {
        if (!path) return;
        const key = reachabilityKey(path);
        if (reachable.has(key)) return;
        reachable.add(key);
        queue.push(path);
    };

    for (const manifest of manifests) {
        reachable.add(reachabilityKey(manifest));
        const manifestDir = dirname(manifest);
        const document = await parseFilePath(manifest).catch(() => null);
        if (!document) continue;
        for (const action of parseModActions(document)) {
            const refs: string[] = [];
            for (const source of action.sources) collectSourceRefs(source, refs);
            for (const ref of refs) enqueue(resolveRef(ref, manifestDir, root, knownFiles));
        }
        // A manifest may build its `Actions` by concatenating other files' action lists via virtual
        // inheritance (`Actions: &<launcher.rules>/Actions, …`). Those `<file>` refs live in the
        // list's inheritance, not its body, so parseModActions never sees them — yet the game loads
        // each referenced file to merge its actions in. Seed them here; their own `<…>` refs (the
        // parts/resources the actions add) then expand in the wave below.
        for (const base of findActionsList(document)?.inheritance ?? []) {
            if (!isValueNode(base) || base.valueType.type !== 'Reference') continue;
            const alias = parseAlias(String(base.valueType.value));
            if (alias) enqueue(resolveRef(alias.fileRef.replace(/^</, '').replace(/>$/, ''), manifestDir, root, knownFiles));
        }
        // Language files under the StringsFolder are loaded by the game directly. The game's node
        // lookup is case-insensitive, so `Stringsfolder` (seen in a published mod) counts too.
        for (const element of document.elements) {
            if (!isAssignmentNode(element) || element.left.name.toLowerCase() !== 'stringsfolder') continue;
            const value = element.right;
            if (!value || !isValueNode(value)) continue;
            const stringsDir = resolve(manifestDir, String(value.valueType.value).replace(/"/g, ''));
            if (!existsSync(stringsDir)) continue;
            for (const file of rulesFilesUnder(stringsDir)) reachable.add(reachabilityKey(file));
        }
    }
    // A root cosmoteer.rules is deliberately NOT seeded. It is a common convenience-globals
    // convention, but the game only ever opens its own Data/cosmoteer.rules and applies the
    // manifest actions to that file (verified against Cosmoteer.Data.Assets), so the mod's local
    // copy is loaded exactly when something reachable actually references it and not otherwise.
    // The editor still parses it for navigation (mod-context overlays its globals), which is
    // independent of this closure.

    // Expand the closure in waves: read every queued file concurrently, then resolve the refs the
    // wave surfaced, which fills the queue for the next wave. IO parallelism dominates the cost.
    // Only refs surviving the comment strip expand, since a commented-out include is disabled
    // content the game never follows. Those stripped-away refs are still remembered per target,
    // so an unreachable file can be annotated with the reachable file whose comment disables it.
    const commentedReferencers = new Map<string, string[]>();
    while (queue.length > 0) {
        if (token.isCancellationRequested) break;
        const wave = queue.splice(0);
        const texts = await Promise.all(wave.map((file) => readFile(file, 'utf8').catch(() => '')));
        for (const [index, text] of texts.entries()) {
            const fromDir = dirname(wave[index]);
            const stripped = stripComments(text);
            const liveRefs = new Set<string>();
            for (const match of stripped.matchAll(FILE_REF_RE)) {
                liveRefs.add(match[1]);
                enqueue(resolveRef(match[1], fromDir, root, knownFiles));
            }
            for (const match of text.matchAll(FILE_REF_RE)) {
                if (liveRefs.has(match[1])) continue;
                const target = resolveRef(match[1], fromDir, root, knownFiles);
                if (!target) continue;
                const targetKey = reachabilityKey(target);
                const referencers =
                    commentedReferencers.get(targetKey) ?? commentedReferencers.set(targetKey, []).get(targetKey)!;
                if (!referencers.includes(wave[index])) referencers.push(wave[index]);
            }
        }
    }

    const unreachable = allRulesFiles.filter((file) => !reachable.has(reachabilityKey(file)));

    // Distinguish "referenced by nothing" from "referenced only by other dead files". Only the
    // unreachable files need scanning: a reachable referencer would have pulled the file in.
    const unreachableKeys = new Set(unreachable.map((file) => reachabilityKey(file)));
    const deadReferencers = new Map<string, string[]>();
    const deadTexts = token.isCancellationRequested
        ? []
        : await Promise.all(unreachable.map((file) => readFile(file, 'utf8').catch(() => '')));
    for (const [index, text] of deadTexts.entries()) {
        const file = unreachable[index];
        const fromDir = dirname(file);
        const fileKey = reachabilityKey(file);
        for (const match of text.matchAll(FILE_REF_RE)) {
            const target = resolveRef(match[1], fromDir, root, knownFiles);
            if (!target) continue;
            const targetKey = reachabilityKey(target);
            if (!unreachableKeys.has(targetKey) || targetKey === fileKey) continue;
            const referencers = deadReferencers.get(targetKey) ?? deadReferencers.set(targetKey, []).get(targetKey)!;
            if (!referencers.includes(file)) referencers.push(file);
        }
    }
    // A commented-out reference from a reachable file is the most actionable annotation of all,
    // being the exact line whose uncommenting revives the file, so it goes first. Targets a live
    // reference reached anyway need no annotation.
    for (const [targetKey, referencers] of commentedReferencers) {
        if (!unreachableKeys.has(targetKey)) continue;
        const existing = deadReferencers.get(targetKey) ?? [];
        const fresh = referencers.filter((file) => !existing.includes(file));
        deadReferencers.set(targetKey, [...fresh, ...existing]);
    }

    return { modRoot: root, manifests, allRulesFiles, reachable, unreachable, deadReferencers };
};

/** The relative, forward-slash path of `file` under the mod root, for display. */
export const relativeToMod = (modRoot: string, file: string): string => relative(modRoot, file).replace(/\\/g, '/');
