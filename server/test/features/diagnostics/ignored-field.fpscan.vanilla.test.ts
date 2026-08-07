import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateIgnoredFields } from '../../../src/features/diagnostics/validator.ignored-field';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';

// False-positive scan of the ignored-field validator over the whole vanilla install. Unlike the
// cross-file validators, this one is expected to produce findings: vanilla ships real dead fields
// (dev-editor Type-switch residue on particle updaters, a handful of stale keys on components). So
// the contract is not zero findings but zero FALSE POSITIVES, pinned two ways:
//   1. every class the schemagen-derived `purelyReflective` + concrete gate once mis-flagged before
//      its guards were complete stays absent. Each class below does read the field it was flagged
//      on, so a regression that re-flags it is a false positive. These stand in for the
//      failure modes the gate defends against: an abstract/interface base whose concrete type reads
//      the field (ISoundEffect, PartComponentRules), a valueForm wrapper whose members are read from
//      the same node (BrushRules seen as BlockTileBrush), a GenericSerialReader custom read path
//      (MusicLayersTrackRules), and a fragment file mis-rooted through reverse-include
//      (a floor part seen as DamageLevelSprites).
//   2. the particle-updater dead-field detections still fire, proving the derivation did not collapse
//      to flagging nothing.
// Needs the install, self-skips without it.
const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;
const parseFile = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;

const rulesFilesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            let st;
            try {
                st = statSync(p);
            } catch {
                continue;
            }
            if (st.isDirectory()) walk(p);
            else if (entry.endsWith('.rules')) out.push(p);
        }
    };
    walk(root);
    return out;
};

// Classes that do read the field the validator once flagged on them. Any finding on one of these is
// a regression into a false positive.
const FALSE_POSITIVE_CLASSES = [
    'ISoundEffect',
    'PartComponentRules',
    'BlockTileBrush',
    'BrushRules',
    'MusicLayersTrackRules',
    'MusicTrackRules',
    'DamageLevelSprites',
    'GalaxySpawner',
];

/**
 * The written shape of the member a finding landed on, read back from the source: what follows the
 * reported name decides it. The pass judged assignments only until the bare named list was added, so
 * `bare-list` is the shape whose findings are new surface.
 *
 * @param text the file's source.
 * @param start the finding's start offset, which is the member's name.
 * @returns the shape label.
 */
const shapeAt = (text: string, start: number): string => {
    const afterName = text.slice(start).replace(/^[^\s=[{]+/, '');
    const trimmed = afterName.replace(/^(\s|\/\/[^\n]*)+/, '');
    if (trimmed.startsWith('=')) return 'assignment';
    if (trimmed.startsWith('[')) return 'bare-list';
    if (trimmed.startsWith('{')) return 'bare-group';
    return 'other';
};

/** The class name out of a not-a-member message, for pairing a finding with its file. */
const flaggedClass = (message: string): string => message.match(/is not a member of (\w+) /)?.[1] ?? '';

describe.skipIf(!HAVE_DATA)('ignored-field validator over vanilla Data', () => {
    let findings: string[] = [];
    let shaped: { file: string; shape: string; cls: string; message: string }[] = [];

    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const svc = CosmoteerWorkspaceService.instance;
        svc.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await svc.initialize(DATA_DIR, noop);
        const resolveRef = async (fileRef: string, fromUri: string) => {
            const rel = fileRef.replace(/[<>]/g, '').trim();
            if (!rel) return undefined;
            const withExt = /\.[^/\\.]+$/.test(rel) ? rel : `${rel}.rules`;
            for (const abs of [
                join(dirname(fileURLToPath(fromUri)), withExt),
                join(DATA_DIR, withExt),
                join(dirname(DATA_DIR), withExt),
            ]) {
                if (existsSync(abs)) {
                    try {
                        return parseFile(abs);
                    } catch {
                        return undefined;
                    }
                }
            }
            return undefined;
        };
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseFile(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);
        ReverseIncludeIndex.instance.reset();
        await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR], token);

        findings = [];
        shaped = [];
        for (const file of rulesFilesUnder(DATA_DIR)) {
            let text: string;
            let doc;
            try {
                text = readFileSync(file, 'utf8');
                doc = parseFile(file);
            } catch {
                continue;
            }
            const rel = relative(DATA_DIR, file);
            for (const error of await validateIgnoredFields(doc, token)) {
                findings.push(`${rel}: ${error.message}`);
                shaped.push({
                    file: rel,
                    shape: shapeAt(text, error.range?.start ?? 0),
                    cls: flaggedClass(error.message),
                    message: error.message,
                });
            }
        }
    }, 600_000);

    it('never flags a field its declaring class actually reads', () => {
        const offenders = findings.filter((f) =>
            FALSE_POSITIVE_CLASSES.some((cls) => f.includes(`is not a member of ${cls} `))
        );
        expect(offenders.slice(0, 30)).toEqual([]);
    });

    it('never flags a wrapper-side field when the dispatched member class wins the group', () => {
        // A wrapper class delegating its value form to a registry reads BOTH its own fields and the
        // dispatched member's from one flat group. The stat-widget groups resolve to the member
        // (StatBarRules and friends own more of the written names), and the wrapper's game-read
        // `ToggleButtonID` must stay known through the delegation companion.
        const offenders = findings.filter((f) => f.includes("'ToggleButtonID'"));
        expect(offenders).toEqual([]);
    });

    it('never flags a bare named group', () => {
        // An identified subgroup with an unknown name can still be an id-referenced declaration
        // (component/toggle ids are read by name from plain string fields), invisible to a reference
        // scan. Only the assignment and the bare named list are judged.
        expect(shaped.filter((f) => f.shape === 'bare-group')).toEqual([]);
    });

    it('flags a bare named list only in groups whose assignments it already flags', () => {
        // The bare list (`MediaEffects [ … ]`) is the shape vanilla spells every effect collection
        // with, and the one a misplaced member most often takes. Vanilla loads in-game, so a
        // bare-list finding is trustworthy only where the same file's same class already produced
        // assignment findings: the verdict is then the pre-existing one completed across shapes, not
        // a new class of judgement the assignment path never had to survive.
        const assignmentPairs = new Set(
            shaped.filter((f) => f.shape === 'assignment').map((f) => `${f.file}|${f.cls}`)
        );
        const unpaired = shaped
            .filter((f) => f.shape === 'bare-list' && !assignmentPairs.has(`${f.file}|${f.cls}`))
            .map((f) => `${f.file}: ${f.message}`);
        expect(unpaired).toEqual([]);
    });

    it('still detects the particle-updater dead fields', () => {
        // The dev editor leaves its Type-switch residue (`DataOut`, `FromValue`, `ValueType`, ...) on
        // particle updaters, which is the validator's canonical target. A healthy scan finds many.
        const particle = findings.filter((f) => /is not a member of Particle\w+ /.test(f));
        expect(particle.length).toBeGreaterThan(100);
    });
});
