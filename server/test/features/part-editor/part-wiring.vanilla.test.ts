import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { parseFilePath, parseText } from '../../../src/utils/ast.utils';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { invalidateSchemaContextCache } from '../../../src/document/schema/schema-context';
import { ensureAliasRootIndex } from '../../../src/features/navigation/alias-root-builder';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { LocalizationKeyIndex } from '../../../src/features/completion/localization-key.index';
import { ActionRootingIndex } from '../../../src/mod/action-rooting.index';
import { locatePartGroup } from '../../../src/features/part-editor/part-grid-data.service';
import { PART_RULES_CLASS } from '../../../src/features/part-editor/part-fields';
import {
    PartReferenceSite,
    WiringRow,
    localizationRow,
    modeOfferingsRow,
    paletteRow,
    partIdentityOf,
    partReferenceSites,
    registrationRow,
} from '../../../src/features/part-editor/part-wiring.probes';

// Ground-truth exercise of the wiring probes against the real vanilla install: the same corpus the
// row set was decided from. Everything the game ships is wired correctly by definition, so a part
// reading `missing` on registration or on palette placement is a bug in the probes. Needs the game
// install, so it self-skips when Data/ is absent (e.g. CI). Point it elsewhere with
// COSMOTEER_DATA_DIR.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;
const FOLDERS = [DATA_DIR];

/** The whole row set for one vanilla part file, plus the naming sites the rows were built from. */
const rowsFor = async (
    relativePath: string
): Promise<{
    sites: PartReferenceSite[];
    registration: WiringRow;
    palette: WiringRow;
    modes: WiringRow;
    localization: WiringRow;
}> => {
    const document = await parseFilePath(join(DATA_DIR, relativePath));
    const part = locatePartGroup(document, 0);
    if (!part) throw new Error(`${relativePath} declares no part group`);
    const identity = await partIdentityOf(part, token);
    const sites = identity.id ? await partReferenceSites(identity, document.uri, FOLDERS, token) : [];
    return {
        sites,
        registration: registrationRow(part, identity),
        palette: await paletteRow(part, sites, FOLDERS, token),
        modes: await modeOfferingsRow(sites, FOLDERS, token),
        localization: await localizationRow(part, FOLDERS, token),
    };
};

/** The bare file names of the naming sites, so a test can name the file without its full path. */
const siteFiles = (sites: readonly PartReferenceSite[]): string[] =>
    sites.map((site) => site.uri.replace(/\\/g, '/').split('/').pop() ?? '');

describe.skipIf(!HAVE_DATA)('part wiring over vanilla Data', () => {
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
        aliasRootIndex.invalidate();
        await ensureAliasRootIndex(token);
        await ReverseIncludeIndex.instance.ensureBuilt(FOLDERS, token);
        await SchemaIdIndex.instance.idsForClass(PART_RULES_CLASS, FOLDERS, token);
        await LocalizationKeyIndex.instance.allKeys(FOLDERS, token);
        await ActionRootingIndex.instance.ensureBuilt(FOLDERS, token);
        invalidateSchemaContextCache();
    }, 600_000);

    it('reads cannon_med as fully wired, naming the ship file that pulls it in', async () => {
        const rows = await rowsFor('ships/terran/cannon_med/cannon_med.rules');
        expect(rows.registration.mark).toBe('ok');
        expect(rows.registration.findings.join('\n')).toContain('terran.rules');
        expect(rows.palette.mark).toBe('ok');
        expect(rows.palette.findings.join('\n')).toContain('WeaponsProjectile');
        expect(rows.modes.mark).toBe('ok');
        expect(rows.localization.mark).toBe('ok');
    }, 120_000);

    it('finds the file-reference tech spelling in both the career and the build battle tech tree', async () => {
        const rows = await rowsFor('ships/terran/cannon_med/cannon_med.rules');
        const files = siteFiles(rows.sites.filter((site) => site.fieldName?.toLowerCase() === 'partsunlocked'));
        expect(files).toContain('techs.rules');
        expect(files).toContain('techs_buildbattle.rules');
    }, 120_000);

    it('reports the overclock toggle choice that names the part by its bare id', async () => {
        const rows = await rowsFor('ships/terran/cannon_med/cannon_med.rules');
        expect(rows.sites.some((site) => site.fieldName?.toLowerCase() === 'partid')).toBe(true);
        expect(rows.modes.findings.join('\n')).toContain('cosmoteer.cannon_med-overclock');
    }, 120_000);

    it('places corridor in the palette through the ship default part, and whitelists it', async () => {
        const rows = await rowsFor('ships/terran/corridor/corridor.rules');
        expect(rows.palette.mark).toBe('ok');
        expect(rows.palette.findings.join('\n')).toContain('The default part of');
        expect(rows.modes.findings.join('\n')).toContain('offers it from the start');
        expect(rows.modes.findings.join('\n')).toContain('build battle parts whitelist');
    }, 120_000);

    // The fixture project declares no editor group at all (nothing there aliases a build gui), so
    // the group branch's ok and missing verdicts can only be pinned where real groups exist. Both
    // parts are synthetic: vanilla ships no part the palette refuses to show.
    it('judges the editor group branch against the groups the game declares', async () => {
        const placed = parseText(
            'Part\n{\n\tID = test.synthetic_placed\n\tEditorGroup = "WeaponsProjectile"\n\tSize = [1, 1]\n}\n',
            join(DATA_DIR, 'ships/terran/synthetic_placed.rules')
        );
        const placedRow = await paletteRow(locatePartGroup(placed, 0)!, [], FOLDERS, token);
        expect(placedRow.mark).toBe('ok');
        expect(placedRow.findings.join('\n')).toContain('WeaponsProjectile');

        const unplaced = parseText(
            'Part\n{\n\tID = test.synthetic_unplaced\n\tSize = [1, 1]\n}\n',
            join(DATA_DIR, 'ships/terran/synthetic_unplaced.rules')
        );
        const unplacedRow = await paletteRow(locatePartGroup(unplaced, 0)!, [], FOLDERS, token);
        expect(unplacedRow.mark).toBe('missing');
        expect(unplacedRow.findings.join('\n')).toContain('palette never shows it');
    }, 120_000);

    it('places railgun_accelerator in the palette through its parent part', async () => {
        const rows = await rowsFor('ships/terran/railgun_accelerator/railgun_accelerator.rules');
        expect(rows.palette.mark).toBe('ok');
        expect(rows.palette.findings.join('\n')).toContain('Stacked under');
    }, 120_000);

    it('lists more than one language for the cannon_med name key', async () => {
        const rows = await rowsFor('ships/terran/cannon_med/cannon_med.rules');
        const nameKeyLine = rows.localization.findings.find((finding) => finding.includes('Parts/CannonMed'))!;
        expect(nameKeyLine).toBeTruthy();
        expect(nameKeyLine.split(',').length).toBeGreaterThan(1);
    }, 120_000);

    it('sweeps every part of the terran parts list: all registered, all placed, and the tech split', async () => {
        const terran = readFileSync(join(DATA_DIR, 'ships/terran/terran.rules'), 'utf8');
        const entries = [...terran.matchAll(/&<([^>]+\.rules)>\/Part\b/g)].map((match) => match[1]);
        expect(entries.length).toBeGreaterThan(90);

        const unregistered: string[] = [];
        const unplaced: string[] = [];
        let withTech = 0;
        for (const entry of entries) {
            const rows = await rowsFor(join('ships/terran', entry));
            if (rows.registration.mark !== 'ok') unregistered.push(entry);
            if (rows.palette.mark !== 'ok') unplaced.push(`${entry} (${rows.palette.mark})`);
            if (rows.modes.findings.some((finding) => finding.startsWith('Unlocked by'))) withTech++;
        }
        console.log(
            `terran parts: ${entries.length}, named by a tech: ${withTech}, from the start: ${entries.length - withTech}`
        );
        expect(unregistered).toEqual([]);
        expect(unplaced).toEqual([]);
        // Measured on the 0.30 install: 96 parts, 68 named by some tech (career, build battle, or a
        // toggle choice) and 28 named by none. A large block of the base game is buildable from the
        // start, which is exactly why the mode row is informational and must never become a
        // diagnostic. The floor is asserted rather than the exact split, so a game update that adds
        // techs does not fail the build.
        expect(withTech).toBeGreaterThan(0);
        expect(entries.length - withTech).toBeGreaterThanOrEqual(20);
    }, 1_800_000);
});
