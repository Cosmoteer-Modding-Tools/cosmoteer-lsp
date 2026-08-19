import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { GroupNode, isValueNode } from '../../../src/core/ast/ast';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { invalidateSchemaContextCache } from '../../../src/document/schema/schema-context';
import { ensureAliasRootIndex } from '../../../src/features/navigation/alias-root-builder';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { LocalizationKeyIndex } from '../../../src/features/completion/localization-key.index';
import { ActionRootingIndex } from '../../../src/mod/action-rooting.index';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { invalidateModContext } from '../../../src/mod/mod-context';
import { globalSettings } from '../../../src/settings';
import { locatePartGroup } from '../../../src/features/part-editor/part-grid-data.service';
import { PART_RULES_CLASS } from '../../../src/features/part-editor/part-fields';
import {
    MODE_PART_FIELDS,
    PartReferenceSite,
    localizationRow,
    modeOfferingsRow,
    paletteRow,
    partIdentityOf,
    partReferenceSites,
    registrationRow,
} from '../../../src/features/part-editor/part-wiring.probes';
import { generatePartWiringReport } from '../../../src/features/part-editor/part-wiring.service';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';
import { FIXTURES_DIR } from '../../helpers';

// End-to-end exercise of the part wiring report over an on-disk fixture mod. The manifest
// (test/fixtures/part-wiring-mod/mod.rules) registers wired_part.rules into the fixture ship's
// Parts list and adds two career techs, so every row has a positive case, while orphan_part.rules is
// wired in by nothing and gives every row its negative case.
const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'part-wiring-mod');
const FOLDERS = [WORKSPACE_DATA_DIR, MOD_DIR];

/** The part group of a fixture mod file, with the identity and naming sites the rows read. */
const partOf = async (name: string) => {
    const document = await parseFilePath(join(MOD_DIR, name));
    const part = locatePartGroup(document, 0);
    if (!part) throw new Error(`${name} declares no part group`);
    const identity = await partIdentityOf(part, token);
    const sites = identity.id ? await partReferenceSites(identity, document.uri, FOLDERS, token) : [];
    return { document, part: part as GroupNode, identity, sites: sites as PartReferenceSite[] };
};

/** Rebuilds every index the rows read, in the order the server's startup chain builds them. */
const buildIndexes = async (): Promise<void> => {
    await ensureAliasRootIndex(token);
    await ReverseIncludeIndex.instance.ensureBuilt(FOLDERS, token);
    await SchemaIdIndex.instance.idsForClass(PART_RULES_CLASS, FOLDERS, token);
    await LocalizationKeyIndex.instance.allKeys(FOLDERS, token);
    await ActionRootingIndex.instance.ensureBuilt(FOLDERS, token);
    invalidateSchemaContextCache();
};

beforeAll(async () => {
    await initWorkspace();
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    clearModRootCache();
    invalidateModContext();
    aliasRootIndex.invalidate();
    ReverseIncludeIndex.instance.reset();
    SchemaIdIndex.instance.reset();
    LocalizationKeyIndex.instance.reset();
    ActionRootingIndex.instance.reset();
    await buildIndexes();
});

afterAll(() => {
    aliasRootIndex.invalidate();
    ReverseIncludeIndex.instance.reset();
    SchemaIdIndex.instance.reset();
    LocalizationKeyIndex.instance.reset();
    ActionRootingIndex.instance.reset();
    invalidateSchemaContextCache();
});

describe('the mode-field set derived from the schema', () => {
    it('holds exactly the part-naming fields the game modes declare, keyed by field name', () => {
        expect([...MODE_PART_FIELDS.keys()].sort()).toEqual(['partid', 'partsunlocked', 'partswhitelist']);
        expect(MODE_PART_FIELDS.get('partsunlocked')).toContain('Cosmoteer.Modes.Career.TechTree.TechRules');
        expect(MODE_PART_FIELDS.get('partswhitelist')).toContain(
            'Cosmoteer.Modes.Pvp.BuildBattle.BuildBattleModeRules'
        );
    });
});

describe('the request answers nothing outside a part', () => {
    it('reports undefined for a document that declares no part group', async () => {
        const document = await parseFilePath(join(MOD_DIR, 'techs.rules'));
        expect(await generatePartWiringReport(document, 0, FOLDERS, token)).toBeUndefined();
    });
});

describe('row 1, registered on a ship', () => {
    it('reads ok for a part a manifest action names, and says which action wired it', async () => {
        const { part, identity } = await partOf('wired_part.rules');
        const row = registrationRow(part, identity);
        expect(row.mark).toBe('ok');
        expect(row.findings.join('\n')).toContain('mod.rules action');
    });

    it('reads missing for a part nothing names', async () => {
        const { part, identity } = await partOf('orphan_part.rules');
        const row = registrationRow(part, identity);
        expect(row.mark).toBe('missing');
        expect(row.findings.join('\n')).toContain('never registers it');
    });
});

// The fixture game tree declares no editor group (its `cosmoteer.rules` aliases no build gui), so
// the group branch has no coverage here on purpose: what this fixture pins is that a written group
// nobody declares reads unknown rather than missing, and that the parent-part branch decides the row
// without needing any coverage. The ok and missing verdicts of the group branch are pinned against
// the real install in part-wiring.vanilla.test.ts.
describe('row 2, shown in the build palette', () => {
    it('reads ok for EditorParentParts, which needs no id coverage at all', async () => {
        const { part, sites } = await partOf('parented_part.rules');
        const row = await paletteRow(part, sites, FOLDERS, token);
        expect(row.mark).toBe('ok');
        expect(row.findings.join('\n')).toContain('Stacked under');
        expect(row.findings.join('\n')).toContain('test.wired');
    });

    it('reads unknown, never missing, while no editor group is declared anywhere', async () => {
        for (const file of ['wired_part.rules', 'orphan_part.rules']) {
            const { part, sites } = await partOf(file);
            const row = await paletteRow(part, sites, FOLDERS, token);
            expect(row.mark).toBe('unknown');
            expect(row.findings.join('\n')).toContain('Not enough of the game is indexed');
        }
    });
});

describe('row 3, offered in the game modes', () => {
    it('finds the bare-id tech spelling and names the tech', async () => {
        const { sites } = await partOf('wired_part.rules');
        const row = await modeOfferingsRow(sites, FOLDERS, token);
        expect(row.mark).toBe('ok');
        expect(row.findings.join('\n')).toContain('test.tech_wired');
    });

    it('searches the OtherIDs aliases too, so a tech naming the alias shows up', async () => {
        const { sites } = await partOf('wired_part.rules');
        const row = await modeOfferingsRow(sites, FOLDERS, token);
        expect(row.findings.join('\n')).toContain('test.tech_alias');
    });

    it('finds the file-reference tech spelling, which writes no part id at all', async () => {
        const { sites } = await partOf('wired_part.rules');
        const fileRef = sites.find(
            (site) => isValueNode(site.node) && site.node.valueType.type === 'Reference'
        );
        expect(fileRef?.fieldName?.toLowerCase()).toBe('partsunlocked');
        const row = await modeOfferingsRow(sites, FOLDERS, token);
        expect(row.findings.join('\n')).toContain('test.tech_fileref');
    });

    it('reads ok, never missing, for a part no tech names', async () => {
        const { sites } = await partOf('orphan_part.rules');
        const row = await modeOfferingsRow(sites, FOLDERS, token);
        expect(row.mark).toBe('ok');
        expect(row.findings.join('\n')).toContain('offers it from the start');
    });
});

describe('row 4, named in the language files', () => {
    it('lists every language declaring the key', async () => {
        const { part } = await partOf('wired_part.rules');
        const row = await localizationRow(part, FOLDERS, token);
        expect(row.mark).toBe('ok');
        const text = row.findings.join('\n');
        expect(text).toContain('Parts/WiredName');
        expect(text).toContain('English');
        expect(text).toContain('Deutsch');
    });

    it('reads missing for a key no strings file declares', async () => {
        const { part } = await partOf('orphan_part.rules');
        const row = await localizationRow(part, FOLDERS, token);
        expect(row.mark).toBe('missing');
        expect(row.findings.join('\n')).toContain('declared in no language file');
    });
});

describe('the rendered report', () => {
    it('carries one heading per row and links files without the raw file scheme', async () => {
        const document = await parseFilePath(join(MOD_DIR, 'wired_part.rules'));
        const markdown = (await generatePartWiringReport(document, 0, FOLDERS, token))!;
        expect(markdown).toBeTruthy();
        expect(markdown.split('\n').filter((line) => line.startsWith('## ')).length).toBe(4);
        expect(markdown).toContain('# Part wiring — test.wired');
        expect(markdown).toContain('Also known as');
        expect(markdown).toContain('vscode://file/');
        expect(markdown).not.toContain('](file:');
    });
});

// The gates are checked last and restore the indexes afterwards, because closing one means throwing
// away shared index state the rows above read.
describe('a closed coverage gate reads unknown rather than missing', () => {
    it('registration falls back to unknown while the forward alias walk has not run', async () => {
        const { part, identity } = await partOf('orphan_part.rules');
        aliasRootIndex.invalidate();
        try {
            const row = registrationRow(part, identity);
            expect(row.mark).toBe('unknown');
            expect(row.findings.join('\n')).toContain('Data folder is not configured');
        } finally {
            await buildIndexes();
        }
    });

    it('the mode row is unknown when no part declaration is indexed at all', async () => {
        const { sites } = await partOf('wired_part.rules');
        SchemaIdIndex.instance.reset();
        try {
            const row = await modeOfferingsRow(sites, [], token);
            expect(row.mark).toBe('unknown');
        } finally {
            SchemaIdIndex.instance.reset();
            await buildIndexes();
        }
    });

    it('the language row is unknown when the strings index holds nothing', async () => {
        const { part } = await partOf('orphan_part.rules');
        LocalizationKeyIndex.instance.reset();
        try {
            const row = await localizationRow(part, [], token);
            expect(row.mark).toBe('unknown');
        } finally {
            LocalizationKeyIndex.instance.reset();
            await buildIndexes();
        }
    });
});
