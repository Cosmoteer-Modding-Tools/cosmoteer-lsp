import { isAbsolute, relative, resolve } from 'path';
import { cachedPathExists } from '../../../workspace/fs-cache';

/** A rewrite of one path inside a member's source, in offsets relative to that source. */
export interface ReferenceRebase {
    /** Offset of the path's first character. */
    start: number;
    /** Offset one past the path's last character. */
    end: number;
    /** The path re-expressed relative to the base file's directory. */
    newText: string;
}

/** What a member's references mean for extraction. */
export interface ReferenceVerdict {
    /** True when every reference the member carries still names the same target from the base file. */
    safe: boolean;
    /** The path rewrites that make it so, empty when the member carries no path. */
    rebases: ReferenceRebase[];
}

/**
 * The game reads a `<./…>` reference path from the install root rather than from the declaring file,
 * so it means the same thing wherever it is written and is carried over untouched.
 */
export const isGameRootPath = (path: string): boolean => /^\s*\.[\\/]/.test(path);

/**
 * The file extensions the game loads as an asset. A value ending in one of them is a path the engine
 * resolves against the directory of the file it is written in (`Halfling.IO.FilePath`), exactly like
 * a `<…>` reference, so it has to be re-expressed when the member moves to another directory. The
 * list is deliberately closed: matching "anything with a dot" would swallow a dotted part id such as
 * `cosmoteer.armor` and refuse half the fields in the game.
 */
export const ASSET_EXTENSIONS = new Set([
    'png',
    'jpg',
    'jpeg',
    'bmp',
    'dds',
    'tga',
    'gif',
    'wav',
    'ogg',
    'mp3',
    'shader',
    'ttf',
    'otf',
    'fnt',
    'rules',
    'txt',
    'json',
    'xml',
]);

/** A run of characters that could spell a path, bounded by what an ObjectText value can hold. */
export const PATH_TOKEN = /[A-Za-z0-9_.\-/\\ ]*\.[A-Za-z][A-Za-z0-9]{0,6}/g;

/** Whether a token ends in an extension the game loads as an asset. */
export const looksLikeAssetPath = (token: string): boolean => {
    const extension = token.slice(token.lastIndexOf('.') + 1).toLowerCase();
    return ASSET_EXTENSIONS.has(extension);
};

/**
 * Re-express one path so it names the same file from another directory.
 *
 * @param path the path as written, relative to `declaringDir`.
 * @param declaringDir the directory of the file the path is written in today.
 * @param baseDir the directory the generated base file will live in.
 * @returns the rewritten path, or undefined when the target does not exist or cannot be reached
 * from the base directory by a relative path.
 */
export const rebasePath = (path: string, declaringDir: string, baseDir: string): string | undefined => {
    const target = resolve(declaringDir, path.trim());
    // Only a path that exists can be proven to still name the same file afterwards.
    if (!cachedPathExists(target)) return undefined;
    const rebased = relative(baseDir, target).replace(/\\/g, '/');
    if (rebased.length === 0 || isAbsolute(rebased)) return undefined;
    return rebased;
};

/**
 * Re-express one path in the game-root form the engine reads from its own install folder.
 *
 * A path written in a file of the game's `Data` tree resolves against that file's directory, so a
 * member copied out of the install into a mod would start naming a file next to the mod instead.
 * A filesystem-relative rewrite would name the right file today and break the moment the mod is
 * published or linked from another folder, because the hop count back into the install would be
 * wrong. The `./Data/…` form the game reads from its working directory names the same file from
 * every file and every machine, so it is the only form worth writing into a mod.
 *
 * @param path the path as written, relative to `declaringDir`.
 * @param declaringDir the directory of the file the path is written in today.
 * @param dataRoot the game's `Data` directory.
 * @returns the rewritten path, or undefined when the target does not exist or lies outside the
 * game's `Data` tree.
 */
export const gameRootRebase = (path: string, declaringDir: string, dataRoot: string): string | undefined => {
    const target = resolve(declaringDir, path.trim());
    // Only a path that exists can be proven to still name the same file afterwards.
    if (!cachedPathExists(target)) return undefined;
    const rebased = relative(dataRoot, target).replace(/\\/g, '/');
    // A target outside the game tree has no game-root spelling, so the member is refused instead.
    if (rebased.length === 0 || isAbsolute(rebased) || rebased.startsWith('..')) return undefined;
    return `./Data/${rebased}`;
};

/** How {@link analyzeReferences} re-expresses a path the member carries. */
export interface ReferenceRebaseOptions {
    /**
     * The game's `Data` directory. Set it when the member is being copied into a mod, so paths come
     * out in the `./Data/…` form rather than as a hop chain back into the install.
     */
    readonly gameRootDir?: string;
}

/**
 * Judge every reference and asset path inside a member's source and, where one is a file path,
 * express it relative to the base file instead of the file it is moving out of.
 *
 * A member survives the move only when nothing in it can mean something else from another file.
 * A path qualifies once it is re-expressed and the target is confirmed to exist, and that
 * re-expression is also what keeps the comparison honest: three parts that each write
 * `File = "icon.png"` next to their own icon produce three different anchor-relative paths, so they
 * stop comparing equal and no plan is built for them. Everything else is refused, because it resolves
 * against its surroundings: `~` starts at the declaring file's root, `^` indexes the declaring node's
 * own inheritance list, `:` selects the most-derived inheritor, and a bare `&Name` walks the
 * declaring node's scope. The mXparser operators that reuse those characters are refused with them,
 * which costs coverage on a handful of computed values and never correctness.
 *
 * Quoted text is judged like the rest and not skipped. The game's own computed values are written as
 * quoted expressions (`"round((&~/Tier) * 40, 0)"`), and skipping quotes would let a `~` through and,
 * worse, let two members whose values differ only inside the quotes compare equal.
 *
 * @param raw the member's exact source slice.
 * @param declaringDir the directory of the file the member is written in today.
 * @param baseDir the directory the generated base file will live in.
 * @param options selects the game-root rewrite instead, for a member copied into a mod.
 * @returns whether the member may move, and the path rewrites it needs when it does.
 */
export const analyzeReferences = (
    raw: string,
    declaringDir: string,
    baseDir: string,
    options?: ReferenceRebaseOptions
): ReferenceVerdict => {
    const gameRootDir = options?.gameRootDir;
    const rebase = (path: string): string | undefined =>
        gameRootDir === undefined
            ? rebasePath(path, declaringDir, baseDir)
            : gameRootRebase(path, declaringDir, gameRootDir);
    const refuse: ReferenceVerdict = { safe: false, rebases: [] };
    const rebases: ReferenceRebase[] = [];
    // A quote that never closes means the member's extent cannot be trusted, so nothing is moved.
    if (((raw.match(/"/g) ?? []).length & 1) === 1) return refuse;
    // The `<…>` spans are handled first and then excluded from the plain-path scan, so a reference
    // path is never rewritten twice.
    const referenceSpans: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== '<') continue;
        const close = raw.indexOf('>', i + 1);
        if (close === -1) return refuse;
        const inner = raw.slice(i + 1, close);
        referenceSpans.push({ start: i, end: close + 1 });
        if (!isGameRootPath(inner)) {
            const rebased = rebase(inner);
            if (rebased === undefined) return refuse;
            if (rebased !== inner) rebases.push({ start: i + 1, end: close, newText: rebased });
        }
        i = close;
    }
    const insideReference = (at: number): boolean =>
        referenceSpans.some((span) => at >= span.start && at < span.end);

    // Scope-relative forms never survive the move, quoted or not.
    for (let i = 0; i < raw.length; i++) {
        if (insideReference(i)) continue;
        const char = raw[i];
        if (char === '~' || char === '^' || char === ':') return refuse;
        if (char === '&' && /[A-Za-z_.]/.test(raw[i + 1] ?? '')) return refuse;
    }

    // Asset paths resolve against the declaring file's directory, so they move with the member and
    // have to be re-expressed exactly like a reference path.
    for (const match of raw.matchAll(PATH_TOKEN)) {
        const token = match[0];
        const offset = match.index ?? 0;
        if (insideReference(offset)) continue;
        if (!looksLikeAssetPath(token)) continue;
        const leading = token.length - token.trimStart().length;
        const trimmed = token.trim();
        const rebased = rebase(trimmed);
        if (rebased === undefined) return refuse;
        if (rebased !== trimmed) {
            rebases.push({ start: offset + leading, end: offset + leading + trimmed.length, newText: rebased });
        }
    }
    rebases.sort((a, b) => a.start - b.start);
    return { safe: true, rebases };
};

/**
 * Apply the rebases {@link analyzeReferences} produced to a member's source.
 *
 * @param raw the member's exact source slice.
 * @param rebases the path rewrites, in ascending offset order.
 * @returns the source as it is written into the base file.
 */
export const applyRebases = (raw: string, rebases: ReadonlyArray<ReferenceRebase>): string => {
    if (rebases.length === 0) return raw;
    let out = '';
    let cursor = 0;
    for (const rebase of rebases) {
        if (rebase.start < cursor) continue;
        out += raw.slice(cursor, rebase.start) + rebase.newText;
        cursor = rebase.end;
    }
    return out + raw.slice(cursor);
};
