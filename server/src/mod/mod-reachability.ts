import { existsSync, readdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { basename, dirname, join, relative, resolve } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    AssignmentNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../core/ast/ast';
import { parseAlias } from '../document/schema/alias-root';
import { isManifestBasename, isRulesFileName, isShaderDocument } from '../document/document-kind';
import { parseFilePath } from '../utils/ast.utils';
import { stringLiteralEnd } from '../utils/text.utils';
import { findActionsList, parseModActions } from './action-parser';

/**
 * Which files of a mod the game can actually load, computed from the manifest outward.
 *
 * The game reads a mod's `mod.rules` (and version-specific `mod_*.rules`) manifests and nothing
 * else by convention: every other file is loaded only because an action's source references it, a
 * reached file `&<includes>` or inherits it, or it is a language file under the `StringsFolder`.
 * A `.rules` file outside that closure is dead content (a backup, a template, or something the
 * modder forgot to wire in), which the game silently never parses.
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
    /**
     * Normalized (lower-case, forward-slash) absolute paths of the reachable files: the `.rules`
     * files of {@link allRulesFiles} the closure reached, plus every `.shader` a reached file names
     * as an asset. The shaders are in the set so the diagnostics pass can check the ones the game
     * compiles, and they are only ever asked about by path, so the callers that intersect the set
     * with {@link allRulesFiles} are unaffected.
     */
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
    /**
     * The forward half of the same graph: for each unreachable file (keyed per
     * {@link reachabilityKey}) the unreachable files it really references, so wiring the key back in
     * brings the whole subtree with it. Unlike {@link deadReferencers} these edges are read from
     * comment-stripped text, since a chain held together by a commented-out line does not come back
     * when the file at its head does. Empty when the walk was cancelled before the files were read.
     */
    deadEdges: Map<string, string[]>;
}

/** Every `<…>` occurrence in a file's text, inner text only. */
const FILE_REF_RE = /<([^<>\r\n"]+)>/g;

/** Where a `.shader` path a rules file names ends, quoted or bare. */
const SHADER_SUFFIX_RE = /\.shader\b/gi;

/**
 * What ends such a path on its way back to the front: whitespace, and the punctuation Object Text
 * puts around a value. A path with a space in it is therefore read short and resolves to nothing,
 * which only leaves that shader where it already was, out of the scan.
 */
const PATH_BREAK_RE = /[\s"'<>=,;{}()[\]]/;

/** The canonical set-membership key for a file path on a case-insensitive filesystem. */
export const reachabilityKey = (path: string): string => path.replace(/\\/g, '/').toLowerCase();

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
        const literalEnd = stringLiteralEnd(text, i);
        if (literalEnd !== undefined) {
            i = literalEnd;
            continue;
        }
        i++;
    }
    return out.join('');
};

/**
 * Every `.rules` and `.shader` file under a directory tree, collected in one walk. The two are kept
 * apart because only the rules files are the mod's content: a shader is an asset a rules file names,
 * so it is judged reachable by that reference and never reported as dead content of its own.
 *
 * @param root the directory to walk.
 * @returns the absolute paths, split by kind.
 */
const filesUnder = (root: string): { rules: string[]; shaders: string[] } => {
    const rules: string[] = [];
    const shaders: string[] = [];
    const walk = (dir: string): void => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) walk(join(dir, entry.name));
            else if (isRulesFileName(entry.name)) rules.push(join(dir, entry.name));
            else if (isShaderDocument(entry.name)) shaders.push(join(dir, entry.name));
        }
    };
    walk(root);
    return { rules, shaders };
};

/**
 * Resolves one `<…>` ref against the referencing file's directory, then the mod root. Returns the
 * absolute path of the `.rules` file it names inside the mod, or undefined for a vanilla `./Data`
 * ref, a path escaping the mod, a non-`.rules` target, or a file that does not exist. Existence is
 * decided against `knownFiles` (every `.rules` under the mod, per {@link reachabilityKey}), which
 * replaces two `existsSync` calls per ref with set lookups.
 *
 * @param raw the ref's inner text, without the angle brackets.
 * @param fromDir the directory of the file the ref is written in.
 * @param modRoot the mod's root folder, the second place a ref is resolved against.
 * @param knownFiles every `.rules` file under the mod, keyed per {@link reachabilityKey}.
 * @returns the absolute path, or undefined when the ref names nothing inside the mod.
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

/**
 * Marks every shader a file's text names as reached. An asset path resolves against the directory
 * of the file that writes it and nowhere else, so a `./Data/…` path names the game's own shader and
 * a path landing outside the mod names nothing here. Shaders are marked rather than queued: their
 * `#include` chain is HLSL, which the `<…>` expansion cannot read, and the includer's own checks
 * already read that chain.
 *
 * @param walk the walk's state.
 * @param text the file's comment-stripped text.
 * @param fromDir the directory the paths resolve against.
 * @returns nothing.
 */
const reachShaders = (walk: ReachabilityWalk, text: string, fromDir: string): void => {
    if (walk.knownShaders.size === 0) return;
    // The extension is found first and the path read backwards from it. A single pattern matching
    // the whole path forward instead retries its leading run at every offset of the file, which is
    // far more work over the text of a whole mod for the same answer.
    for (const match of text.matchAll(SHADER_SUFFIX_RE)) {
        let start = match.index;
        while (start > 0 && !PATH_BREAK_RE.test(text[start - 1])) start--;
        const ref = text.slice(start, match.index + match[0].length).replace(/\\/g, '/');
        if (/^\.\/data\//i.test(ref)) continue;
        const key = reachabilityKey(resolve(fromDir, ref));
        if (walk.knownShaders.has(key)) walk.reachable.add(key);
    }
};

/** The inner text of an alias's `<file>` part, without the angle brackets. */
const aliasFileRef = (node: AbstractNode): string | undefined => {
    if (!isValueNode(node) || node.valueType.type !== 'Reference') return undefined;
    const alias = parseAlias(String(node.valueType.value));
    return alias?.fileRef.replace(/^</, '').replace(/>$/, '');
};

/**
 * Collects the `<file>` refs of every `&`-reference value inside an action source's subtree,
 * including the inheritance bases of every group and list on the way down. A source written as
 * `Overrides : &<frag.rules>` or `ManyToAdd : &<list.rules>/Parts []` names its content only in the
 * inheritance list, and the game merges those bases in before it reads the members
 * (`OTGroupNode.GetInheritedGroups` resolves each entry and opens its file), so the file is loaded
 * exactly like one named in the body.
 */
const collectSourceRefs = (node: AbstractNode, out: string[]): void => {
    const fileRef = aliasFileRef(node);
    if (fileRef !== undefined) {
        out.push(fileRef);
        return;
    }
    if (isValueNode(node)) return;
    if (isGroupNode(node) || isListNode(node)) {
        for (const base of node.inheritance ?? []) collectSourceRefs(base, out);
        for (const element of node.elements) collectSourceRefs(element, out);
    } else if (isAssignmentNode(node) && node.right) {
        collectSourceRefs(node.right, out);
    }
};

/**
 * The reference nodes a manifest names its `Actions` list through from outside the list's own body:
 * the bases of an `Actions: &<launcher.rules>/Actions, …` inheritance, and the right side of an
 * `Actions = &<acts/list.rules>/Actions` assignment. The game reads the list with
 * `TryReadFromPath<List<ModAction>>("Actions")`, which dereferences either form and opens the
 * referenced file, so both seed the closure. Names are matched case-insensitively, mirroring the
 * game's node lookup.
 *
 * @param document the parsed manifest.
 * @returns the nodes holding the refs, in declaration order.
 */
const actionsListRefs = (document: AbstractNodeDocument): AbstractNode[] => {
    const assigned = document.elements.filter(
        (element) => isAssignmentNode(element) && element.left.name.toLowerCase() === 'actions' && element.right
    ) as AssignmentNode[];
    return [...(findActionsList(document)?.inheritance ?? []), ...assigned.map((element) => element.right!)];
};

/** The state one reachability walk threads through its steps. */
interface ReachabilityWalk {
    /** The mod root, forward-slash normalized and without a trailing separator. */
    root: string;
    /** Every `.rules` file under the mod, keyed per {@link reachabilityKey}. */
    knownFiles: Set<string>;
    /** Every `.shader` file under the mod, keyed per {@link reachabilityKey}. */
    knownShaders: Set<string>;
    /** The keys of the files reached so far. */
    reachable: Set<string>;
    /** The reached files whose own refs have still to be expanded. */
    queue: string[];
    /**
     * Refs a file writes only inside a comment, keyed by the target they name, so an unreachable
     * file can be annotated with the file whose commented-out line disables it.
     */
    commentedReferencers: Map<string, string[]>;
}

/**
 * Marks a file reached and queues its own refs for expansion, ignoring a file already reached.
 *
 * @param walk the walk's state.
 * @param path the absolute path to reach, or undefined when a ref named nothing inside the mod.
 * @returns nothing.
 */
const enqueue = (walk: ReachabilityWalk, path: string | undefined): void => {
    if (!path) return;
    const key = reachabilityKey(path);
    if (walk.reachable.has(key)) return;
    walk.reachable.add(key);
    walk.queue.push(path);
};

/**
 * Remembers every ref a file writes only inside a comment, which is content the closure must not
 * follow but a dead file still wants named as the line that would revive it.
 *
 * @param walk the walk's state.
 * @param text the file's raw text.
 * @param fromFile the absolute path of the file the refs are written in.
 * @param fromDir the directory the refs resolve against first.
 * @returns nothing.
 */
const recordCommented = (walk: ReachabilityWalk, text: string, fromFile: string, fromDir: string): void => {
    const live = new Set<string>();
    for (const match of stripComments(text).matchAll(FILE_REF_RE)) live.add(match[1]);
    for (const match of text.matchAll(FILE_REF_RE)) {
        if (live.has(match[1])) continue;
        const target = resolveRef(match[1], fromDir, walk.root, walk.knownFiles);
        if (!target) continue;
        const targetKey = reachabilityKey(target);
        const referencers =
            walk.commentedReferencers.get(targetKey) ?? walk.commentedReferencers.set(targetKey, []).get(targetKey)!;
        if (!referencers.includes(fromFile)) referencers.push(fromFile);
    }
};

/**
 * Seeds the closure from one manifest: the manifest itself, every file its parsed action sources
 * reference, every file its `Actions` list inherits from, and every `.rules` under its
 * `StringsFolder`. Action targets contribute nothing, since they name vanilla locations that would
 * otherwise collide with same-named mod files.
 *
 * @param walk the walk's state.
 * @param manifest the absolute path of the manifest.
 * @returns nothing.
 */
const seedFromManifest = async (walk: ReachabilityWalk, manifest: string): Promise<void> => {
    walk.reachable.add(reachabilityKey(manifest));
    const manifestDir = dirname(manifest);
    // A whole action commented out is the most common way a mod ships content the game never
    // loads, and the manifest is not walked with the rest, so its own comments are read here. An
    // action source written inline in the manifest can name a shader, so those are read here too.
    const manifestText = await readFile(manifest, 'utf8').catch(() => '');
    recordCommented(walk, manifestText, manifest, manifestDir);
    reachShaders(walk, stripComments(manifestText), manifestDir);
    const document = await parseFilePath(manifest).catch(() => null);
    if (!document) return;
    for (const action of parseModActions(document)) {
        const refs: string[] = [];
        for (const source of action.sources) collectSourceRefs(source, refs);
        for (const ref of refs) enqueue(walk, resolveRef(ref, manifestDir, walk.root, walk.knownFiles));
    }
    // A manifest may build its `Actions` from other files' action lists, by virtual inheritance
    // (`Actions: &<launcher.rules>/Actions, …`) or by assigning one outright
    // (`Actions = &<acts/list.rules>/Actions`). Either way the `<file>` ref lives outside the list
    // body, so parseModActions never sees it, yet the game loads each referenced file to read the
    // actions. Seed them here. Their own `<…>` refs (the parts/resources the actions add) then
    // expand with the rest of the closure.
    for (const node of actionsListRefs(document)) {
        const fileRef = aliasFileRef(node);
        if (fileRef !== undefined) enqueue(walk, resolveRef(fileRef, manifestDir, walk.root, walk.knownFiles));
    }
    // Language files under the StringsFolder are loaded by the game directly. The game's node
    // lookup is case-insensitive, so `Stringsfolder` (seen in a published mod) counts too.
    for (const element of document.elements) {
        if (!isAssignmentNode(element) || element.left.name.toLowerCase() !== 'stringsfolder') continue;
        const value = element.right;
        if (!value || !isValueNode(value)) continue;
        const stringsDir = resolve(manifestDir, String(value.valueType.value).replace(/"/g, ''));
        if (!existsSync(stringsDir)) continue;
        for (const file of filesUnder(stringsDir).rules) walk.reachable.add(reachabilityKey(file));
    }
};

/**
 * Expands the closure in waves: every queued file is read concurrently, then the refs the wave
 * surfaced fill the queue for the next one. IO parallelism dominates the cost. Only refs surviving
 * the comment strip expand, since a commented-out include is disabled content the game never
 * follows, and those stripped-away refs are remembered per target instead.
 *
 * @param walk the walk's state.
 * @param token cancels the walk between waves.
 * @returns nothing.
 */
const expandClosure = async (walk: ReachabilityWalk, token: CancellationToken): Promise<void> => {
    while (walk.queue.length > 0) {
        if (token.isCancellationRequested) break;
        const wave = walk.queue.splice(0);
        const texts = await Promise.all(wave.map((file) => readFile(file, 'utf8').catch(() => '')));
        for (const [index, text] of texts.entries()) {
            const fromDir = dirname(wave[index]);
            const live = stripComments(text);
            for (const match of live.matchAll(FILE_REF_RE)) {
                enqueue(walk, resolveRef(match[1], fromDir, walk.root, walk.knownFiles));
            }
            reachShaders(walk, live, fromDir);
            recordCommented(walk, text, wave[index], fromDir);
        }
    }
};

/**
 * Builds the graph over the files the closure never reached, which tells "referenced by nothing"
 * apart from "referenced only by other dead files". Only the unreachable files are scanned, since a
 * reachable referencer would have pulled the file in.
 *
 * @param walk the walk's state, read for the refs recorded from comments.
 * @param unreachable the absolute paths the closure never reached.
 * @param token skips the file reads when cancellation is already requested.
 * @returns the backward edges per target and the live forward edges per source.
 */
const deadContentGraph = async (
    walk: ReachabilityWalk,
    unreachable: string[],
    token: CancellationToken
): Promise<{ deadReferencers: Map<string, string[]>; deadEdges: Map<string, string[]> }> => {
    const unreachableKeys = new Set(unreachable.map((file) => reachabilityKey(file)));
    const deadReferencers = new Map<string, string[]>();
    const deadEdges = new Map<string, string[]>();
    const deadTexts = token.isCancellationRequested
        ? []
        : await Promise.all(unreachable.map((file) => readFile(file, 'utf8').catch(() => '')));
    for (const [index, text] of deadTexts.entries()) {
        const file = unreachable[index];
        const fromDir = dirname(file);
        const fileKey = reachabilityKey(file);
        const deadTargetOf = (ref: string): string | undefined => {
            const target = resolveRef(ref, fromDir, walk.root, walk.knownFiles);
            if (!target) return undefined;
            const targetKey = reachabilityKey(target);
            return unreachableKeys.has(targetKey) && targetKey !== fileKey ? targetKey : undefined;
        };
        let raw = 0;
        for (const match of text.matchAll(FILE_REF_RE)) {
            const targetKey = deadTargetOf(match[1]);
            if (!targetKey) continue;
            raw++;
            const referencers = deadReferencers.get(targetKey) ?? deadReferencers.set(targetKey, []).get(targetKey)!;
            if (!referencers.includes(file)) referencers.push(file);
        }
        // The forward edges are the ones a revival count rides on, and a commented-out reference
        // revives nothing, so they are read again from stripped text. Most dead files reference no
        // other dead file at all, and the second pass is worth paying only for the ones that do.
        if (raw === 0) continue;
        const live = new Set<string>();
        for (const match of stripComments(text).matchAll(FILE_REF_RE)) {
            const targetKey = deadTargetOf(match[1]);
            if (targetKey) live.add(targetKey);
        }
        if (live.size > 0) deadEdges.set(fileKey, [...live]);
    }
    // A commented-out reference from a reachable file is the most actionable annotation of all,
    // being the exact line whose uncommenting revives the file, so it goes first. Targets a live
    // reference reached anyway need no annotation.
    for (const [targetKey, referencers] of walk.commentedReferencers) {
        if (!unreachableKeys.has(targetKey)) continue;
        const existing = deadReferencers.get(targetKey) ?? [];
        const fresh = referencers.filter((file) => !existing.includes(file));
        deadReferencers.set(targetKey, [...fresh, ...existing]);
    }
    return { deadReferencers, deadEdges };
};

/**
 * Computes the reachable-file closure of the mod at `modRoot`.
 *
 * Seeds are the manifests themselves, every file an action source references (through the parsed
 * actions, so vanilla-naming action targets contribute nothing) and every `.rules` under the
 * manifest's `StringsFolder`. Expansion then follows every non-commented `<…>` ref of each
 * reached file. A mod's root `cosmoteer.rules` is not a seed: the game applies actions to its own
 * `Data/cosmoteer.rules` and never opens the mod's copy, so that file is reachable only when
 * reached content references it.
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

    const { rules: allRulesFiles, shaders } = filesUnder(root);
    // The game finds manifests recursively and picks one by game-version priority, so nested
    // manifests (merged sub-mods) seed too. Which one wins depends on the running game version, and
    // seeding all of them keeps the union over-approximate in the safe direction.
    const manifests = allRulesFiles.filter((file) => isManifestBasename(basename(file)));
    const walk: ReachabilityWalk = {
        root,
        knownFiles: new Set(allRulesFiles.map((file) => reachabilityKey(file))),
        knownShaders: new Set(shaders.map((file) => reachabilityKey(file))),
        reachable: new Set<string>(),
        queue: [],
        commentedReferencers: new Map<string, string[]>(),
    };

    for (const manifest of manifests) await seedFromManifest(walk, manifest);
    // A root cosmoteer.rules is deliberately not seeded. It is a common convenience-globals
    // convention, but the game only ever opens its own Data/cosmoteer.rules and applies the
    // manifest actions to that file, so the mod's local copy is loaded exactly when something
    // reachable actually references it and not otherwise.
    // The editor still parses it for navigation (mod-context overlays its globals), which is
    // independent of this closure.
    await expandClosure(walk, token);

    const reachable = walk.reachable;
    const unreachable = allRulesFiles.filter((file) => !reachable.has(reachabilityKey(file)));
    const { deadReferencers, deadEdges } = await deadContentGraph(walk, unreachable, token);

    return { modRoot: root, manifests, allRulesFiles, reachable, unreachable, deadReferencers, deadEdges };
};

/** The relative, forward-slash path of `file` under the mod root, for display. */
export const relativeToMod = (modRoot: string, file: string): string => relative(modRoot, file).replace(/\\/g, '/');

/** A per-mod memo of closures, so a file-by-file question does not re-walk the mod for every file. */
export interface ReachabilityMemo {
    /**
     * The mod's reachable-file closure, computed once per mod root.
     *
     * @param modRoot the mod root directory.
     * @param cancellationToken cancels the walk.
     * @returns the closure, or undefined when it could not be completed.
     */
    of(modRoot: string, cancellationToken: CancellationToken): Promise<ModReachability | undefined>;
    /** Drops the memoized closures, so a file added or renamed is seen by the next question. */
    clear(): void;
}

/**
 * A memo of reachability closures keyed by mod root. A cancelled walk returns a partial closure, in
 * which a reachable file reads as dead content, so it is dropped instead of memoized.
 *
 * @returns a fresh memo.
 */
export const reachabilityMemo = (): ReachabilityMemo => {
    const byRoot = new Map<string, Promise<ModReachability | undefined>>();
    return {
        async of(modRoot, cancellationToken) {
            let pending = byRoot.get(modRoot);
            if (!pending) {
                pending = computeModReachability(modRoot, cancellationToken).catch(() => undefined);
                byRoot.set(modRoot, pending);
            }
            const reachability = await pending;
            if (!reachability || cancellationToken.isCancellationRequested) {
                byRoot.delete(modRoot);
                return undefined;
            }
            return reachability;
        },
        clear() {
            byRoot.clear();
        },
    };
};
