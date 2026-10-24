import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { validateWeaponCoverage } from '../../../src/features/diagnostics/validator.weapon-coverage';

// Every file the game ships loads and runs, so a finding here is a false positive by definition.
// Needs the install, self-skips without.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const rulesUnder = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) rulesUnder(full, out);
        else if (entry.toLowerCase().endsWith('.rules')) out.push(full);
    }
    return out;
};

describe.skipIf(!HAVE_DATA)('the weapon coverage check over vanilla Data', () => {
    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = {
            begin: () => undefined,
            report: () => undefined,
            done: () => undefined,
        };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
    }, 300_000);

    it('finds nothing to say about the files the game ships', async () => {
        const findings: string[] = [];
        const judged: string[] = [];
        for (const file of rulesUnder(DATA_DIR)) {
            let text: string;
            try {
                text = readFileSync(file, 'utf8');
            } catch {
                continue;
            }
            // Only a weapon writing coverage can produce a finding, and parsing the whole tree for
            // the rest costs minutes.
            if (!/WeaponCoverage|ForceCustomCoverageWidthZero/.test(text)) continue;
            const document = parser(lexer(text), pathToFileURL(file).href).value;
            judged.push(relative(DATA_DIR, file).replace(/\\/g, '/'));
            for (const error of await validateWeaponCoverage(document, token)) {
                findings.push(`${relative(DATA_DIR, file)}: ${error.message}`);
            }
        }
        // Anti-vacuity: the mine launcher writes a default arc and range, so a run that never
        // reached it proves nothing.
        expect(judged).toContain('ships/terran/missile_launcher/mine/missile_launcher_mine.rules');
        expect(findings).toEqual([]);
    }, 600_000);

    it('does judge the game weapons it stays quiet on, once their coverage is broken', async () => {
        /**
         * Validates a vanilla file with one edit applied, under its own uri.
         *
         * @param path the file under Data.
         * @param from the text to replace.
         * @param to the replacement.
         * @returns the finding messages.
         */
        const broken = async (path: string, from: string, to: string): Promise<string[]> => {
            const file = join(DATA_DIR, path);
            const text = readFileSync(file, 'utf8');
            expect(text).toContain(from);
            const document = parser(lexer(text.replace(from, to)), pathToFileURL(file).href).value;
            return (await validateWeaponCoverage(document, token)).map((error) => error.message);
        };
        const mine = await broken(
            'ships/terran/missile_launcher/mine/missile_launcher_mine.rules',
            'Range = 150',
            'Range = 0'
        );
        expect(mine).toEqual([expect.stringContaining('coverage range of 0')]);
        // The launcher's weapons inherit a template through `~/`, and the match is read through it.
        const he = await broken(
            'ships/terran/missile_launcher/he/missile_launcher_he.rules',
            'MatchWeaponCoverage = WeaponB',
            'MatchWeaponCoverage = EmitterA'
        );
        expect(he).toEqual([expect.stringContaining("'EmitterA' is not a weapon")]);
    }, 300_000);
});
