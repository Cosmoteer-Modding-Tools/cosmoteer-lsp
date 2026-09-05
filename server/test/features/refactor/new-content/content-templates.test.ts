import { existsSync } from 'fs';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { isGroupNode, isValueNode } from '../../../../src/core/ast/ast';
import { lexer } from '../../../../src/core/lexer/lexer';
import { parser } from '../../../../src/core/parser/parser';
import { validateDefaultValuedFields } from '../../../../src/features/diagnostics/validator.default-value';
import { validateIgnoredFields } from '../../../../src/features/diagnostics/validator.ignored-field';
import { validatePathValues } from '../../../../src/features/diagnostics/validator.path-value';
import { validateRequiredFields } from '../../../../src/features/diagnostics/validator.required-fields';
import { validateSchema } from '../../../../src/features/diagnostics/validator.schema';
import { canonicalWorkshopEscape } from '../../../../src/features/diagnostics/workshop-escape';
import { filePathToUri } from '../../../../src/features/navigation/navigation-strategy';
import {
    contentFilePathOf,
    contentFolderPathOf,
    emitContent,
    pointedAtByFor,
    usageFor,
} from '../../../../src/features/refactor/new-content/content-templates';
import { CONTENT_KINDS, ContentKind } from '../../../../src/features/refactor/new-content/new-content.types';
import { globalSettings } from '../../../../src/settings';
import { namedMembersOf, parseText } from '../../../../src/utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../../../src/workspace/cosmoteer-workspace.service';
import { FIXTURES_DIR } from '../../../helpers';

// The five templates, judged the way a file the author wrote by hand would be judged: parsed by the
// real parser, then run through every default-on check that has anything to say about a file's
// fields. A template our own editor immediately fades or flags is a template nobody would keep.
const FIXTURE = join(FIXTURES_DIR, 'new-content-mod').replace(/\\/g, '/');
const DATA_DIR = `${FIXTURE}/steamapps/common/Cosmoteer/Data`;
const MOD_DIR = `${FIXTURE}/mod`;
const token = CancellationToken.None;

/** The file a template would be written to, so the path rules that type it apply in the test too. */
const pathFor = (kind: ContentKind): string => contentFilePathOf(MOD_DIR, kind, 'test_thing');

/** The id a template would carry, empty for the kinds that declare none. */
const idFor = (kind: ContentKind): string => {
    switch (kind) {
        case 'mediaEffect':
        case 'decalFolder':
        case 'logoShip':
            return '';
        case 'resource':
        case 'codexPage':
            return 'test_thing';
        case 'editorGroup':
        case 'partStat':
        case 'buff':
            return 'TestThing';
        case 'partToggle':
            return 'test_test_thing';
        default:
            return 'test.test_thing';
    }
};

/** The kinds whose template borrows no game asset: a stat line, a buff and a codex page are text through and through. */
const ASSETLESS_KINDS: readonly ContentKind[] = ['partStat', 'buff', 'codexPage'];

// A logo ship is a saved ship the command copies, so it has no template to judge here.
const TEMPLATED_KINDS = CONTENT_KINDS.filter((kind) => kind !== 'logoShip');

/** Every `<…>` reference the text carries. */
const referencesIn = (text: string): string[] => [...text.matchAll(/<[^>]*>/g)].map((match) => match[0]);

beforeAll(async () => {
    globalSettings.cosmoteerPath = DATA_DIR;
    const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
    const service = CosmoteerWorkspaceService.instance;
    service.setConnection({
        languages: { diagnostics: { refresh: () => undefined } },
        window: { showWarningMessage: () => undefined },
    } as unknown as Connection);
    await service.initialize(DATA_DIR, noop);
});

describe('the content templates', () => {
    for (const kind of TEMPLATED_KINDS) {
        it(`emits a ${kind} file the real parser reads without complaint`, () => {
            const fsPath = pathFor(kind);
            const emitted = emitContent(kind, 'test_thing', idFor(kind));
            const parsed = parser(lexer(emitted.text), filePathToUri(fsPath));
            expect(parsed.parserErrors.map((error) => error.message)).toEqual([]);
            expect(emitted.text.endsWith('\n')).toBe(true);
        });

        it(`emits a ${kind} file no default-on check has anything to say about`, async () => {
            const fsPath = pathFor(kind);
            const emitted = emitContent(kind, 'test_thing', idFor(kind));
            const document = parseText(emitted.text, fsPath);
            const findings = [
                ...(await validateSchema(document, token)),
                ...(await validateIgnoredFields(document, token)),
                ...(await validateDefaultValuedFields(document, token)),
                ...(await validatePathValues(document, token)),
                ...(await validateRequiredFields(document, token)),
            ];
            expect(findings.map((finding) => finding.message)).toEqual([]);
        });

        it(`points the ${kind} template only at install assets that exist`, () => {
            const emitted = emitContent(kind, 'test_thing', idFor(kind));
            if (!ASSETLESS_KINDS.includes(kind)) expect(emitted.placeholderAssets.length).toBeGreaterThan(0);
            for (const asset of emitted.placeholderAssets) {
                expect(asset.startsWith('./Data/'), `${asset} is not an install-root path`).toBe(true);
                expect(existsSync(join(DATA_DIR, asset.slice('./Data/'.length))), `${asset} is missing`).toBe(true);
            }
        });

        it(`keeps the ${kind} file's line endings whole when the mod uses \\r\\n`, () => {
            const emitted = emitContent(kind, 'test_thing', idFor(kind), '\r\n');
            expect(emitted.text.replace(/\r\n/g, '')).not.toContain('\n');
            expect(emitted.text).toContain('\r\n');
        });

        it(`writes no relative escape in the ${kind} file`, () => {
            const fsPath = pathFor(kind);
            const emitted = emitContent(kind, 'test_thing', idFor(kind));
            for (const reference of referencesIn(emitted.text)) {
                expect(reference, `${reference} climbs out of the mod`).not.toContain('..');
                // The rewrite hint exists for exactly the spelling a naive emitter would produce, so
                // it having nothing to say is the proof that none was produced.
                expect(canonicalWorkshopEscape(reference, filePathToUri(fsPath))).toBeNull();
            }
        });
    }

    it('gives a part the base every terran part inherits, named from the install root', () => {
        const emitted = emitContent('part', 'test_thing', 'test.test_thing');
        const document = parseText(emitted.text, pathFor('part'));
        const group = document.elements.find(isGroupNode);
        expect(group?.identifier?.name).toBe('Part');
        expect(group?.inheritance?.length).toBe(1);
        expect(String(group?.inheritance?.[0].valueType.value)).toBe(
            '<./Data/ships/terran/base_part_terran.rules>/Part'
        );
    });

    it('writes the fields the part base does not supply, and the resource cost no base declares', () => {
        const emitted = emitContent('part', 'test_thing', 'test.test_thing');
        const document = parseText(emitted.text, pathFor('part'));
        const group = document.elements.find(isGroupNode)!;
        const names = [...namedMembersOf(group)].map(([name]) => name);
        for (const required of ['ID', 'NameKey', 'Size', 'MaxHealth', 'EditorIcon', 'Resources']) {
            expect(names, `the part template dropped ${required}`).toContain(required);
        }
    });

    it('never writes a field the game deleted', () => {
        // The obvious template source is the game's own example mod, which still writes `Flammable`.
        // It was removed in 0.30 and our own dead-field check fades it on sight, so copying vanilla
        // verbatim would ship a template the editor greys out the moment it is created.
        for (const kind of TEMPLATED_KINDS) {
            expect(emitContent(kind, 'test_thing', idFor(kind)).text).not.toContain('Flammable');
        }
    });

    it('gives a resource a bare id and a part a dotted one, the way the game writes them', () => {
        expect(emitContent('resource', 'tri_steel', 'tri_steel').text).toContain('ID = tri_steel');
        expect(emitContent('part', 'tri_armor', 'evans.tri_armor').text).toContain('ID = evans.tri_armor');
        expect(emitContent('bullet', 'tri_shot', 'evans.tri_shot').text).toContain('ID = "evans.tri_shot"');
    });

    it('names the localization keys the game reads, in the spelling its own files use', () => {
        expect(emitContent('part', 'tri_armor_2x2', 'evans.tri_armor_2x2').localization.map((entry) => entry.key)).toEqual([
            'Parts/TriArmor2x2',
            'Parts/TriArmor2x2Desc',
        ]);
        expect(emitContent('resource', 'tri_steel', 'tri_steel').localization.map((entry) => entry.key)).toEqual([
            'Resource/TriSteel',
            'Resource/TriSteelPlural',
            'Resource/TriSteelDesc',
        ]);
        // A shot and a media effect carry no name the game shows, so they name no key either.
        expect(emitContent('bullet', 'tri_shot', 'evans.tri_shot').localization).toEqual([]);
        expect(emitContent('mediaEffect', 'tri_boom', '').localization).toEqual([]);
    });

    it('says plainly that nothing reaches a shot or an effect, and nothing else does', () => {
        expect(pointedAtByFor('bullet')).toContain('Nothing reaches this shot yet');
        expect(pointedAtByFor('mediaEffect')).toContain('Nothing reaches this effect yet');
        expect(pointedAtByFor('part')).toBeUndefined();
        expect(pointedAtByFor('resource')).toBeUndefined();
        expect(pointedAtByFor('logoShip')).toBeUndefined();
        expect(pointedAtByFor('decalFolder')).toBeUndefined();
        expect(pointedAtByFor('editorGroup')).toBeUndefined();
        expect(pointedAtByFor('partStat')).toBeUndefined();
        expect(pointedAtByFor('partToggle')).toBeUndefined();
        expect(pointedAtByFor('buff')).toBeUndefined();
        expect(pointedAtByFor('codexPage')).toBeUndefined();
    });

    it('says how a part uses a registry entry, and says nothing of the kind for the rest', () => {
        expect(usageFor('editorGroup', 'Experimental')).toBe('Write EditorGroup = "Experimental" in a part to put it in this group.');
        expect(usageFor('partStat', 'BulletVolley')).toContain('BulletVolley = <value>');
        expect(usageFor('partToggle', 'evans_thrust')).toContain('ToggleID = "evans_thrust"');
        expect(usageFor('partToggle', 'evans_thrust')).toContain('OperationalToggle');
        expect(usageFor('buff', 'PhaseEngine')).toContain('ReceivableBuffs');
        expect(usageFor('buff', 'PhaseEngine')).toContain('{ Type = Buff; BuffType = PhaseEngine }');
        expect(usageFor('codexPage', 'mining')).toContain('TempShowCondition');
        for (const kind of ['part', 'resource', 'bullet', 'mediaEffect', 'logoShip', 'decalFolder'] as ContentKind[]) {
            expect(usageFor(kind, 'x'), `${kind} carries a usage note`).toBeUndefined();
        }
    });

    it('puts each kind where the editor can find it, and gives the asset-owning kinds a folder', () => {
        expect(contentFilePathOf(MOD_DIR, 'part', 'x')).toBe(`${MOD_DIR}/parts/x/x.rules`);
        expect(contentFilePathOf(MOD_DIR, 'resource', 'x')).toBe(`${MOD_DIR}/resources/x/x.rules`);
        expect(contentFilePathOf(MOD_DIR, 'bullet', 'x')).toBe(`${MOD_DIR}/shots/x/x.rules`);
        expect(contentFilePathOf(MOD_DIR, 'mediaEffect', 'x')).toBe(`${MOD_DIR}/effects/x.rules`);
        expect(contentFilePathOf(MOD_DIR, 'logoShip', 'x')).toBe(`${MOD_DIR}/gui/x.ship.png`);
        expect(contentFilePathOf(MOD_DIR, 'decalFolder', 'x')).toBe(`${MOD_DIR}/roof_decals/x/decal_group_x.rules`);
        expect(contentFolderPathOf(MOD_DIR, 'part', 'x')).toBe(`${MOD_DIR}/parts/x`);
        expect(contentFolderPathOf(MOD_DIR, 'mediaEffect', 'x')).toBeUndefined();
        expect(contentFolderPathOf(MOD_DIR, 'logoShip', 'x')).toBeUndefined();
        // The folder is the content for a decal group, so it has to be free as well as the file.
        expect(contentFolderPathOf(MOD_DIR, 'decalFolder', 'x')).toBe(`${MOD_DIR}/roof_decals/x`);
        // A registry entry borrows the game's icons and owns no asset, so it gets no folder.
        expect(contentFilePathOf(MOD_DIR, 'editorGroup', 'x')).toBe(`${MOD_DIR}/gui/editor_groups/x.rules`);
        expect(contentFilePathOf(MOD_DIR, 'partStat', 'x')).toBe(`${MOD_DIR}/gui/stats/x.rules`);
        expect(contentFilePathOf(MOD_DIR, 'partToggle', 'x')).toBe(`${MOD_DIR}/gui/toggles/x.rules`);
        expect(contentFolderPathOf(MOD_DIR, 'editorGroup', 'x')).toBeUndefined();
        expect(contentFolderPathOf(MOD_DIR, 'partStat', 'x')).toBeUndefined();
        expect(contentFolderPathOf(MOD_DIR, 'partToggle', 'x')).toBeUndefined();
        // A buff owns nothing, while a codex page reads its entry images from its own directory.
        expect(contentFilePathOf(MOD_DIR, 'buff', 'x')).toBe(`${MOD_DIR}/buffs/x.rules`);
        expect(contentFolderPathOf(MOD_DIR, 'buff', 'x')).toBeUndefined();
        expect(contentFilePathOf(MOD_DIR, 'codexPage', 'x')).toBe(`${MOD_DIR}/codex/x/x.rules`);
        expect(contentFolderPathOf(MOD_DIR, 'codexPage', 'x')).toBe(`${MOD_DIR}/codex/x`);
    });

    it('writes a buff as a map with one member named by the id, declaring no key', () => {
        const emitted = emitContent('buff', 'phase_engine', 'PhaseEngine');
        const document = parseText(emitted.text, pathFor('buff'));
        const groups = document.elements.filter(isGroupNode);
        expect(groups.map((group) => group.identifier?.name)).toEqual(['PhaseEngine']);
        const names = [...namedMembersOf(groups[0])].map(([name]) => name);
        expect(names).toEqual([
            'CombineMode',
            'BaseValue',
            'IconTextFormatKey',
            'IconTextMultiply',
            'IconTextAdd',
            'ShowIconTextForZeroValue',
            'RectBorderColor',
            'RectFillColor',
        ]);
        expect(emitted.text).toContain('BuffType = PhaseEngine');
        expect(emitted.localization).toEqual([]);
        expect(emitted.placeholderAssets).toEqual([]);
    });

    it('writes a codex page under the tutorials tab with a title and two paragraph keys', () => {
        const emitted = emitContent('codexPage', 'mining_guide', 'mining_guide');
        const document = parseText(emitted.text, pathFor('codexPage'));
        const names = [...namedMembersOf(document)].map(([name]) => name);
        expect(names).toEqual(['ID', 'TitleKey', 'TabNameKey', 'Entries']);
        expect(emitted.text).toContain('ID = mining_guide');
        expect(emitted.text).toContain('TabNameKey = "Codex/Tutorials"');
        expect(emitted.localization).toEqual([
            { key: 'Tutorials/MiningGuide/Title', value: '"Mining Guide"' },
            { key: 'Tutorials/MiningGuide/Text1', value: '"Write this part of the help here."' },
            { key: 'Tutorials/MiningGuide/Text2', value: '"Write this part of the help here."' },
        ]);
        expect(emitted.placeholderAssets).toEqual([]);
    });

    it('writes a toolbar category as a named member whose name is the id, sorted before Structure', () => {
        const emitted = emitContent('editorGroup', 'tri_weapons', 'TriWeapons');
        const document = parseText(emitted.text, pathFor('editorGroup'));
        const group = document.elements.find(isGroupNode);
        expect(group?.identifier?.name).toBe('TriWeapons');
        expect(emitted.text).toContain('SortOrder = 950');
        expect(emitted.localization).toEqual([{ key: 'EditorGroups/TriWeapons', value: '"Tri Weapons"' }]);
        expect(emitted.placeholderAssets).toEqual(['./Data/gui/game/designer/group_utilities.png']);
    });

    it('writes a stat line with its id and the format key the tooltip reads', () => {
        const emitted = emitContent('partStat', 'tri_volley', 'TriVolley');
        const document = parseText(emitted.text, pathFor('partStat'));
        const group = document.elements.find(isGroupNode);
        expect(group?.identifier?.name).toBe('Stat');
        expect(emitted.text).toContain('ID = TriVolley');
        expect(emitted.localization).toEqual([
            { key: 'Stats/TriVolleyFmt', value: '"<white>Tri Volley:</white> <good>{0:0.##}</good>"' },
        ]);
    });

    it('writes a toggle whose choice ids and hotkey tooltips carry the prefixed toggle id', () => {
        const emitted = emitContent('partToggle', 'thrust_mode', 'evans_thrust_mode');
        const document = parseText(emitted.text, pathFor('partToggle'));
        const group = document.elements.find(isGroupNode);
        expect(group?.identifier?.name).toBe('Toggle');
        expect(emitted.text).toContain('ToggleID = "evans_thrust_mode"');
        expect(emitted.text).toContain('ChoiceID = "evans_thrust_mode_off"');
        expect(emitted.text).toContain('ChoiceID = "evans_thrust_mode_on"');
        expect(emitted.localization.map((entry) => entry.key)).toEqual(['PartToggles/ThrustMode_Off', 'PartToggles/ThrustMode_On']);
        expect(emitted.localization[1].value).toBe(
            '"<b>Thrust Mode: <good>On</good></b>\\n\\nHotkey: <btn id=\'PartToggles.evans_thrust_mode_on\'/>"'
        );
    });

    it('writes a decal group that names its own folder, its key and the game icon it borrows', () => {
        const emitted = emitContent('decalFolder', 'tri_shapes', '');
        const document = parseText(emitted.text, pathFor('decalFolder'));
        const group = document.elements.find(isGroupNode);
        expect(group?.identifier?.name).toBe('Group');
        expect(emitted.text).toContain('Folders = ["."]');
        expect(emitted.localization).toEqual([{ key: 'DecalGroups/TriShapes', value: '"Tri Shapes"' }]);
        expect(emitted.placeholderAssets).toEqual(['./Data/roof_decals/shapes.png']);
    });

    it('emits nothing for a logo ship, which is copied rather than written', () => {
        const emitted = emitContent('logoShip', 'flagship', '');
        expect(emitted.text).toBe('');
        expect(emitted.localization).toEqual([]);
        expect(emitted.placeholderAssets).toEqual([]);
    });

    it('gives the media effect a type the registry knows, since that is all that types the file', () => {
        const document = parseText(emitContent('mediaEffect', 'test_thing', '').text, pathFor('mediaEffect'));
        const type = [...namedMembersOf(document)].find(([name]) => name === 'Type')?.[1];
        expect(type && isValueNode(type) ? String(type.valueType.value) : undefined).toBe('Audio');
    });
});
