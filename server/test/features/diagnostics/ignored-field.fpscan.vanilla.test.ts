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
//      its guards were complete stays absent. Each entry below was decompile-verified to read the
//      flagged field, so a regression that re-flags it is a false positive. These stand in for the
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

// Classes proven by decompilation to read the field the validator once flagged on them. Any finding
// on one of these is a regression into a false positive.
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

describe.skipIf(!HAVE_DATA)('ignored-field validator over vanilla Data', () => {
    let findings: string[] = [];

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
        for (const file of rulesFilesUnder(DATA_DIR)) {
            let doc;
            try {
                doc = parseFile(file);
            } catch {
                continue;
            }
            for (const error of await validateIgnoredFields(doc, token)) {
                findings.push(`${relative(DATA_DIR, file)}: ${error.message}`);
            }
        }
    }, 600_000);

    it('never flags a field its declaring class actually reads', () => {
        const offenders = findings.filter((f) =>
            FALSE_POSITIVE_CLASSES.some((cls) => f.includes(`is not a member of ${cls} `))
        );
        expect(offenders.slice(0, 30)).toEqual([]);
    });

    it('still detects the particle-updater dead fields', () => {
        // The dev editor leaves its Type-switch residue (`DataOut`, `FromValue`, `ValueType`, ...) on
        // particle updaters, which is the validator's canonical target. A healthy scan finds many.
        const particle = findings.filter((f) => /is not a member of Particle\w+ /.test(f));
        expect(particle.length).toBeGreaterThan(100);
    });
});
