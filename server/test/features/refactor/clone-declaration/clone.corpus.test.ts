import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { parser } from '../../../../src/core/parser/parser';
import { lexer } from '../../../../src/core/lexer/lexer';
import {
    buildClonePlan,
    ClonePlan,
    ClonePlanContext,
    CloneFailure,
} from '../../../../src/features/refactor/clone-declaration/clone-plan';
import { locateCloneTarget } from '../../../../src/features/refactor/clone-declaration/clone-target';
import { filePathToUri } from '../../../../src/features/navigation/navigation-strategy';
import { scanSpans } from '../../../../src/features/refactor/clone-declaration/unit-rebase';
import { looksLikeAssetPath, PATH_TOKEN } from '../../../../src/features/refactor/shared-base/reference-safety';
import { clearModRootCache } from '../../../../src/mod/mod-root';
import { parseText } from '../../../../src/utils/ast.utils';
import { foldPathCase } from '../../../../src/workspace/fs-cache';

// Every part of the game's own install, and of the installed workshop mods, planned as a clone into a
// throwaway mod. Nothing is written to either tree: the plan carries the copy's text, so the whole
// rewrite can be judged without touching a file the user owns. Asked for rather than run by default,
// like the other corpus tests here.
const DATA_DIR = (process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data')
    .replace(/\\/g, '/');
const WORKSHOP_DIR = (process.env.COSMOTEER_WORKSHOP_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600')
    .replace(/\\/g, '/');
const MAX_SOURCES = Number(process.env.CLONE_CORPUS_MAX ?? '400');
const HAVE = !!process.env.CLONE_CORPUS && existsSync(DATA_DIR);

/** Every refusal a corpus source may legitimately produce. Anything else is a defect. */
const ENUMERATED: ReadonlySet<CloneFailure> = new Set<CloneFailure>([
    'noDeclaration',
    'inheritedIdentity',
    'unreadableBase',
    'severalIdentities',
    'unresolvablePath',
    'escapingPath',
    'destinationExists',
    'notEditable',
]);

/** Every `.rules` file below a directory, capped so a mistaken root cannot walk the whole disk. */
const rulesFilesUnder = (dir: string, cap: number): string[] => {
    const found: string[] = [];
    const walk = (current: string): void => {
        if (found.length >= cap) return;
        let entries: string[];
        try {
            entries = readdirSync(current);
        } catch {
            return;
        }
        for (const name of entries) {
            if (found.length >= cap) return;
            const path = join(current, name).replace(/\\/g, '/');
            let directory = false;
            try {
                directory = statSync(path).isDirectory();
            } catch {
                continue;
            }
            if (directory) walk(path);
            else if (name.toLowerCase().endsWith('.rules')) found.push(path);
        }
    };
    walk(dir);
    return found;
};

/** A throwaway mod with a manifest and one language file, which is where every copy is planned to go. */
const makeScratchMod = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'clone-corpus-')).replace(/\\/g, '/');
    const mod = `${root}/mod`;
    mkdirSync(`${mod}/strings`, { recursive: true });
    writeFileSync(`${mod}/mod.rules`, 'ID = Test.CloneCorpus\nName = "Clone corpus"\nVersion = 1.0\nStringsFolder = "strings"\n');
    writeFileSync(`${mod}/strings/english.rules`, '__Name = "English"\n');
    return mod;
};

const context = (mod: string): ClonePlanContext => ({
    folderPaths: [mod],
    dataRoot: DATA_DIR,
    declaredIds: async () => new Set<string>(),
    declaredKeys: async () => new Set<string>(),
    localizationTexts: async () => [],
    modRootsUnder: () => [mod],
});

/** What one source came to: a plan, an enumerated refusal, or a defect worth naming. */
interface Outcome {
    source: string;
    plan?: ClonePlan;
    failure?: CloneFailure;
}

/** Plan a clone of the first declaration a file makes. */
const planFor = async (source: string, mod: string, destinationDir?: string): Promise<Outcome | undefined> => {
    let text: string;
    try {
        text = readFileSync(source, { encoding: 'utf-8' });
    } catch {
        return undefined;
    }
    let document;
    try {
        document = parseText(text, source);
    } catch {
        return undefined;
    }
    const located = await locateCloneTarget(document, 0, source, filePathToUri(source), CancellationToken.None);
    if ('refusal' in located) return undefined;
    const built = await buildClonePlan(
        located.target,
        text,
        document,
        { newId: 'corpus.clone_probe', destinationDir },
        context(mod),
        CancellationToken.None
    );
    return 'failure' in built ? { source, failure: built.failure } : { source, plan: built.plan };
};

/** Every path a copied file writes, ignoring comments, in the spelling the copy holds. */
const pathsOf = (text: string): string[] => {
    const { comments, references } = scanSpans(text);
    const covered = (at: number): boolean =>
        comments.some((span) => at >= span.start && at < span.end) ||
        references.some((span) => at >= span.start && at < span.end);
    const paths: string[] = [];
    for (const span of references) {
        const inner = text.slice(span.innerStart, span.innerEnd).trim();
        if (looksLikeAssetPath(inner)) paths.push(inner);
    }
    for (const match of text.matchAll(PATH_TOKEN)) {
        const token = match[0].trim();
        if (covered(match.index ?? 0) || !looksLikeAssetPath(token)) continue;
        paths.push(token);
    }
    return paths;
};

/**
 * The paths in a text that name nothing: a `./Data/…` path is read from the install, a path landing
 * on something the copy itself writes counts as there, and anything else is looked up on disk.
 *
 * @param text the file's source.
 * @param dir the directory the file is written in.
 * @param written every path the copy creates.
 * @returns the paths that resolve to nothing.
 */
const unresolvedIn = (text: string, dir: string, written: ReadonlySet<string>): string[] => {
    const installRoot = DATA_DIR.slice(0, DATA_DIR.lastIndexOf('/'));
    const missing: string[] = [];
    for (const path of pathsOf(text)) {
        const target = /^\s*\.[\\/]/.test(path)
            ? resolve(installRoot, path).replace(/\\/g, '/')
            : resolve(dir, path).replace(/\\/g, '/');
        if (written.has(foldPathCase(target)) || existsSync(target)) continue;
        missing.push(path);
    }
    return missing;
};

/**
 * The paths the copy breaks that the source did not. A path already broken where it came from stays
 * broken in the copy, which is right: a clone copies what is there and never quietly repairs it. The
 * game's installed mods carry a few such paths, and only a path the clone itself made unresolvable
 * would be a defect.
 *
 * @param plan the plan to judge.
 * @returns the newly unresolvable paths, named with the file that carries them.
 */
const unresolvedPathsOf = (plan: ClonePlan): string[] => {
    const written = new Set(plan.files.map((file) => foldPathCase(file.destination)));
    const missing: string[] = [];
    for (const file of plan.files) {
        if (file.text === undefined) continue;
        const dir = file.destination.slice(0, file.destination.lastIndexOf('/'));
        const sourceDir = file.source.slice(0, file.source.lastIndexOf('/'));
        const already = new Set(unresolvedIn(file.before ?? '', sourceDir, new Set()));
        for (const path of unresolvedIn(file.text, dir, written)) {
            if (!already.has(path)) missing.push(`${file.destination}: ${path}`);
        }
    }
    return missing;
};

/**
 * Sweep a tree and report what every declaration in it came to.
 *
 * @param root the tree to walk.
 * @param mod the throwaway mod every copy is planned into.
 * @param intoScratch names an explicit destination inside that mod, for a tree whose own files the
 * default would land beside. An installed workshop mod belongs to somebody else, so a sweep of one
 * must never plan a copy back into it.
 * @returns what each declaration came to.
 */
const sweep = async (root: string, mod: string, intoScratch = false): Promise<Outcome[]> => {
    const outcomes: Outcome[] = [];
    let index = 0;
    for (const source of rulesFilesUnder(root, MAX_SOURCES)) {
        const outcome = await planFor(source, mod, intoScratch ? `${mod}/probe/copy${index++}` : undefined);
        if (outcome) outcomes.push(outcome);
    }
    return outcomes;
};

/** The assertions every planned copy has to pass, whichever tree it came from. */
const judge = (outcomes: readonly Outcome[], label: string, mod: string): void => {
    const unexpected = outcomes.filter((outcome) => outcome.failure && !ENUMERATED.has(outcome.failure));
    expect(unexpected.map((outcome) => `${outcome.failure} ${outcome.source}`), `${label}: unenumerated refusals`).toEqual([]);

    const plans = outcomes.filter((outcome) => outcome.plan).map((outcome) => outcome.plan!);
    expect(plans.length, `${label}: nothing could be planned at all`).toBeGreaterThan(0);

    const unparsed: string[] = [];
    const escaping: string[] = [];
    const unresolved: string[] = [];
    for (const plan of plans) {
        for (const file of plan.files) {
            if (file.text === undefined) continue;
            const before = parser(lexer(file.before ?? ''), file.source).parserErrors.length;
            const after = parser(lexer(file.text), file.destination).parserErrors.length;
            if (after > before) unparsed.push(file.destination);
            // A published mod must never carry the author's own drive, and never climb past the mod.
            // Only the paths are judged: `&../../../BaseValue` walks up the node tree rather than up
            // the filesystem, and the game's own parts write it in every overclock remap.
            for (const path of pathsOf(file.text)) {
                if (/[A-Za-z]:[\\/]/.test(path) || path.startsWith('../../../')) {
                    escaping.push(`${file.destination}: ${path}`);
                }
            }
            // A copy never lands anywhere but where it was told to go. A collection element is the
            // one exception, since its copy belongs in the list it is already in, and whether that
            // file may be written at all is decided by `editableModRootOf` before the plan is built.
            const inPlace = plan.unit === 'listElement' && file.destination === file.source;
            if (!inPlace && !foldPathCase(file.destination).startsWith(foldPathCase(mod))) {
                escaping.push(`outside the destination: ${file.destination}`);
            }
        }
        unresolved.push(...unresolvedPathsOf(plan));
    }
    expect(unparsed, `${label}: the copy parses worse than the source`).toEqual([]);
    expect(escaping, `${label}: a copy carries an absolute or escaping path`).toEqual([]);
    expect(unresolved, `${label}: a copy points at a file that is not there`).toEqual([]);
};

describe.skipIf(!HAVE)("cloning the game's own parts", () => {
    it('plans a copy of every declaration that resolves, and never writes a path that does not', async () => {
        clearModRootCache();
        const mod = makeScratchMod();
        try {
            const outcomes = await sweep(DATA_DIR, mod);
            judge(outcomes, 'the game data', mod);
            // The install itself is never written to, whatever the plans say.
            expect(existsSync(`${DATA_DIR}/ships/corpus.clone_probe`)).toBe(false);
        } finally {
            rmSync(mod.slice(0, mod.lastIndexOf('/')), { recursive: true, force: true });
            clearModRootCache();
        }
    }, 900_000);
});

describe.skipIf(!HAVE || !existsSync(WORKSHOP_DIR)) ('cloning the installed workshop mods', () => {
    it('either plans a copy or refuses for one of the reasons it states', async () => {
        clearModRootCache();
        const mod = makeScratchMod();
        try {
            const outcomes = await sweep(WORKSHOP_DIR, mod, true);
            judge(outcomes, 'workshop mods', mod);
        } finally {
            rmSync(mod.slice(0, mod.lastIndexOf('/')), { recursive: true, force: true });
            clearModRootCache();
        }
    }, 900_000);
});
