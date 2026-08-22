import { existsSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { foldPathCase } from '../../../workspace/fs-cache';
import { isGameRootPath, looksLikeAssetPath, PATH_TOKEN } from '../shared-base/reference-safety';

/** Why a path inside a copied file could not be carried over. */
export type PathRefusal = 'unresolvablePath' | 'escapingPath';

/** One path rewrite inside a copied file, in offsets of that file's own source. */
export interface UnitRebase {
    /** Offset of the path's first character. */
    readonly start: number;
    /** Offset one past the path's last character. */
    readonly end: number;
    /** The path as the copy writes it. */
    readonly newText: string;
}

/** Where a path written in a copied file has to point once the copy is in place. */
export interface UnitRebaseContext {
    /** The directory the file being rewritten is written in today. */
    readonly sourceDir: string;
    /** The directory the copy of that file lives in. */
    readonly destinationDir: string;
    /** Case-folded source path to destination path, one entry per file the copy carries. */
    readonly unit: ReadonlyMap<string, string>;
    /** The game's `Data` directory, so a target inside the install gets its game-root spelling. */
    readonly dataRoot?: string;
    /** The directory the copy must stay inside, so no rewrite can reach out of the destination tree. */
    readonly destinationRoot?: string;
}

/** What one path came to. */
export type PathRebase = { newText: string } | { refusal: PathRefusal };

/** What a whole copied file's paths came to. */
export type FileRebase = { rebases: UnitRebase[] } | { refusal: PathRefusal; path: string };

/** A path with forward slashes, so every comparison and every emitted path reads the same on every OS. */
const slashed = (path: string): string => path.replace(/\\/g, '/');

/** Whether a path sits inside a directory, folding case the way the filesystem matches it. */
const isUnder = (path: string, root: string): boolean => {
    const folded = foldPathCase(slashed(path));
    const prefix = foldPathCase(slashed(root).replace(/\/+$/, ''));
    return folded === prefix || folded.startsWith(`${prefix}/`);
};

/**
 * Re-express one path so the copy still names the file the original named.
 *
 * The four cases, in the order they have to be decided:
 *  - a `./…` path is read from the game's install folder rather than from the declaring file, so it
 *    means the same thing wherever it is written and is carried over untouched.
 *  - a target inside the copy unit becomes the copy's own file. This is the case a plain rebase gets
 *    wrong: re-expressing it against the original would leave a cloned part reading the source part's
 *    sprites, so the two would share art and a repaint of one would repaint the other.
 *  - a target inside the game's `Data` tree becomes `./Data/…`. A filesystem-relative rewrite would
 *    name the right file on this machine and hard-code the author's install into a published mod,
 *    which is exactly the escape this editor's own workshop hint flags.
 *  - anything else is expressed relative to the copy's own directory, and only while it stays inside
 *    the destination tree. A mod cannot ship a file it reaches by climbing out of itself.
 *
 * A path whose target is not on disk is refused rather than guessed at, because nothing can be proven
 * about where it should point afterwards.
 *
 * @param path the path as written.
 * @param context where the file is copied from and to.
 * @returns the path the copy writes, or the reason the copy cannot be made.
 */
export const rebaseUnitPath = (path: string, context: UnitRebaseContext): PathRebase => {
    const trimmed = path.trim();
    if (trimmed === '') return { newText: path };
    if (isGameRootPath(trimmed)) return { newText: trimmed };

    const target = slashed(resolve(context.sourceDir, trimmed));
    const inUnit = context.unit.get(foldPathCase(target));
    if (inUnit) {
        const rebased = slashed(relative(context.destinationDir, inUnit));
        if (rebased === '' || isAbsolute(rebased)) return { refusal: 'escapingPath' };
        return { newText: rebased };
    }
    if (!existsSync(target)) return { refusal: 'unresolvablePath' };
    if (context.dataRoot && isUnder(target, context.dataRoot)) {
        const inside = slashed(relative(context.dataRoot, target));
        return { newText: `./Data/${inside}` };
    }
    if (context.destinationRoot && !isUnder(target, context.destinationRoot)) return { refusal: 'escapingPath' };
    const rebased = slashed(relative(context.destinationDir, target));
    if (rebased === '' || isAbsolute(rebased)) return { refusal: 'escapingPath' };
    return { newText: rebased };
};

/** A run of source the path scan must not read: a comment, or a `<…>` reference already handled. */
interface Span {
    readonly start: number;
    readonly end: number;
}

/** A `<…>` reference span, with the path it holds. */
interface ReferenceSpan extends Span {
    readonly innerStart: number;
    readonly innerEnd: number;
}

/**
 * The comment runs and the `<…>` reference spans of a file, found with the string awareness a plain
 * search cannot have: `//` inside a quoted path is part of the path, not the start of a comment.
 *
 * A `<` only opens a reference when a `>` closes it on the same line and nothing between them opens
 * another one. That keeps a comparison written in a computed value (`"if(&A < 5, 1, 0)"`) from being
 * read as a reference that swallows the rest of the line.
 *
 * @param text the file's source.
 * @returns the comment spans and the reference spans, both in ascending order.
 */
export const scanSpans = (text: string): { comments: Span[]; references: ReferenceSpan[] } => {
    const comments: Span[] = [];
    const references: ReferenceSpan[] = [];
    let inString = false;
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        if (!inString && char === '/' && text[index + 1] === '/') {
            const start = index;
            while (index < text.length && text[index] !== '\n') index++;
            comments.push({ start, end: index });
            continue;
        }
        if (!inString && char === '/' && text[index + 1] === '*') {
            const start = index;
            const close = text.indexOf('*/', index + 2);
            index = close === -1 ? text.length : close + 2;
            comments.push({ start, end: index });
            continue;
        }
        if (char === '"') {
            inString = !inString;
            index++;
            continue;
        }
        if (char === '<') {
            const close = text.indexOf('>', index + 1);
            const newline = text.indexOf('\n', index + 1);
            const inner = close === -1 ? '' : text.slice(index + 1, close);
            if (close !== -1 && (newline === -1 || close < newline) && !inner.includes('<')) {
                references.push({ start: index, end: close + 1, innerStart: index + 1, innerEnd: close });
                index = close + 1;
                continue;
            }
        }
        index++;
    }
    return { comments, references };
};

/**
 * Every path rewrite one copied file needs.
 *
 * Both spellings the game reads are covered: the `<…>` reference form and a bare or quoted asset path,
 * which the engine resolves against the declaring file's directory in exactly the same way. Comments
 * are left alone, since the prose in one is nobody's path, and a reference whose content is not a file
 * path is left alone too.
 *
 * @param text the copied file's source.
 * @param context where the file is copied from and to.
 * @returns the rewrites in ascending offset order, or the first path that stopped the copy.
 */
export const rebaseUnitFile = (text: string, context: UnitRebaseContext): FileRebase => {
    const { comments, references } = scanSpans(text);
    const rebases: UnitRebase[] = [];
    const covered = (at: number): boolean =>
        comments.some((span) => at >= span.start && at < span.end) ||
        references.some((span) => at >= span.start && at < span.end);

    for (const span of references) {
        const inner = text.slice(span.innerStart, span.innerEnd);
        // A reference always names a file, so anything without a file extension is something else.
        if (!looksLikeAssetPath(inner.trim())) continue;
        if (comments.some((comment) => span.start >= comment.start && span.start < comment.end)) continue;
        const rebased = rebaseUnitPath(inner, context);
        if ('refusal' in rebased) return { refusal: rebased.refusal, path: inner.trim() };
        const leading = inner.length - inner.trimStart().length;
        const trimmed = inner.trim();
        if (rebased.newText !== trimmed) {
            rebases.push({
                start: span.innerStart + leading,
                end: span.innerStart + leading + trimmed.length,
                newText: rebased.newText,
            });
        }
    }

    for (const match of text.matchAll(PATH_TOKEN)) {
        const token = match[0];
        const offset = match.index ?? 0;
        if (covered(offset)) continue;
        if (!looksLikeAssetPath(token)) continue;
        const leading = token.length - token.trimStart().length;
        const trimmed = token.trim();
        if (trimmed === '') continue;
        const rebased = rebaseUnitPath(trimmed, context);
        if ('refusal' in rebased) return { refusal: rebased.refusal, path: trimmed };
        if (rebased.newText !== trimmed) {
            rebases.push({ start: offset + leading, end: offset + leading + trimmed.length, newText: rebased.newText });
        }
    }

    rebases.sort((a, b) => a.start - b.start);
    return { rebases };
};
