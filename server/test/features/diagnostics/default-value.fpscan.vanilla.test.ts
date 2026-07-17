import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateDefaultValuedFields } from '../../../src/features/diagnostics/validator.default-value';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';

// False-positive scan of the default-value validator over the whole vanilla install. Like the
// ignored-field scan, findings are expected rather than forbidden: vanilla writes plenty of fields
// at their own default. The contract is that every finding is genuinely deletable, pinned by the
// invariant that no flagged assignment sits in a group that inherits (the one case where an
// explicit default is load-bearing).
// Set FPSCAN_DEFAULT_OUT to dump every finding for eyeballing. Needs the install, self-skips without it.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
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

describe.skipIf(!HAVE_DATA)('default-value validator over vanilla Data', () => {
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
            for (const error of await validateDefaultValuedFields(doc, token)) {
                findings.push(`${relative(DATA_DIR, file)}: ${error.message}`);
            }
        }
        if (process.env.FPSCAN_DEFAULT_OUT) writeFileSync(process.env.FPSCAN_DEFAULT_OUT, findings.join('\n'), 'utf8');
    }, 600_000);

    it('only ever names a class whose defaults are provably absent-values', () => {
        // Every class the scan may name was decompiled. Those flagged through an `initializer` default
        // are purelyReflective with a compiler-generated parameterless constructor, so their field
        // initializers are what the game uses when the field is absent. Those flagged through an
        // `attribute` default (TargetBlendMode, the GeneratorStage subclasses) were read individually
        // and each one's custom reader does reach ReflectiveRead, which is what applies the attribute.
        // Anything outside this set means a gate regressed and a class deserialized some other way
        // could be flagged on a default that is not its absent-value.
        const allowed = new Set([
            'AISelfRepairModuleRules',
            'ArcShieldEffectRules',
            'AsteroidDepositsStage',
            'AsteroidStage',
            'AsteroidWedgesStage',
            'BulletDeathByEnemyProximityRules',
            'BulletProximityAccelerationRules',
            'ConstantValueModulatorRules',
            'ConvertTypeStage',
            'EnlargeTilesStage',
            'FactionSpawnRules',
            'FactionsSpawner',
            'HeightMapToNormalsTextureLayer',
            'InlineResourceConverterRules',
            'InterpolateSineValueModulatorRules',
            'InterpolateValueModulatorRules',
            'MultiResourceStorageRules',
            'ParticleLightningRenderer',
            'PartTargeterGuiRules',
            'PartTileLineScoreValueRules',
            'PartToggleTriggerRules',
            'PartUIToggleRules',
            'PerlinNoiseEdgeEffects',
            'ResourceRarityRules',
            'ResourceTypeLoadoutRules',
            'SectorTypeInfo',
            'Spawner',
            'TargetBlendMode',
        ]);
        const offenders = findings.filter((f) => {
            const cls = /by default on ([A-Za-z0-9_]+),/.exec(f)?.[1];
            return cls && !allowed.has(cls);
        });
        expect(offenders.slice(0, 30)).toEqual([]);
    });

    it('never flags a field whose default is only a constructor initializer on a non-reflective class', () => {
        // The canonical traps, each decompile-verified: MusicFileTrackRules' only constructor takes a
        // GenericSerialReader, and BuffType/DynamicVolumeRules likewise deserialize outside the plain
        // reflective path. Their defaults come from the `initializer` source, which is only an
        // absent-value on a purelyReflective class, so they must stay unflagged. (TargetBlendMode is
        // not in this set: its defaults are `attribute`-sourced, which holds regardless.)
        const offenders = findings.filter((f) =>
            /on (MusicFileTrackRules|BuffType|DynamicVolumeRules|DynamicFilterRules),/.test(f)
        );
        expect(offenders).toEqual([]);
    });

    it('flags the attribute-sourced blend-mode defaults', () => {
        // TargetBlendMode is why defaultSource exists: not purelyReflective (it has its own
        // ReadContentFrom), but that reader starts from default(TargetBlendMode) and delegates to
        // ReflectiveRead, which applies each [Serialize(DefaultValue = …)]. Vanilla spells out full
        // 6-field blend blocks where several fields restate the default, so a healthy scan finds many.
        const blend = findings.filter((f) => f.includes('on TargetBlendMode,'));
        expect(blend.length).toBeGreaterThan(100);
    });

    it('still detects the texture-generator defaults', () => {
        // The planet/background generators write their edge-effect multipliers at the default 1, which
        // is the validator's highest-volume true positive. A healthy scan finds many.
        const perlin = findings.filter((f) => f.includes('on PerlinNoiseEdgeEffects,'));
        expect(perlin.length).toBeGreaterThan(100);
    });
});
