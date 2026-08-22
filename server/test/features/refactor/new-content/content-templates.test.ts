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
} from '../../../../src/features/refactor/new-content/content-templates';
import { CONTENT_KINDS, ContentKind } from '../../../../src/features/refactor/new-content/new-content.types';
import { globalSettings } from '../../../../src/settings';
import { namedMembersOf, parseText } from '../../../../src/utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../../../src/workspace/cosmoteer-workspace.service';
import { FIXTURES_DIR } from '../../../helpers';

// The four templates, judged the way a file the author wrote by hand would be judged: parsed by the
// real parser, then run through every default-on check that has anything to say about a file's
// fields. A template our own editor immediately fades or flags is a template nobody would keep.
const FIXTURE = join(FIXTURES_DIR, 'new-content-mod').replace(/\\/g, '/');
const DATA_DIR = `${FIXTURE}/steamapps/common/Cosmoteer/Data`;
const MOD_DIR = `${FIXTURE}/mod`;
const token = CancellationToken.None;

/** The file a template would be written to, so the path rules that type it apply in the test too. */
const pathFor = (kind: ContentKind): string => contentFilePathOf(MOD_DIR, kind, 'test_thing');

/** The id a template would carry, empty for the kind that declares none. */
const idFor = (kind: ContentKind): string => (kind === 'mediaEffect' ? '' : kind === 'resource' ? 'test_thing' : 'test.test_thing');

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
    for (const kind of CONTENT_KINDS) {
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
            expect(emitted.placeholderAssets.length).toBeGreaterThan(0);
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
        for (const kind of CONTENT_KINDS) {
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
    });

    it('puts each kind where the editor can find it, and gives the asset-owning kinds a folder', () => {
        expect(contentFilePathOf(MOD_DIR, 'part', 'x')).toBe(`${MOD_DIR}/parts/x/x.rules`);
        expect(contentFilePathOf(MOD_DIR, 'resource', 'x')).toBe(`${MOD_DIR}/resources/x/x.rules`);
        expect(contentFilePathOf(MOD_DIR, 'bullet', 'x')).toBe(`${MOD_DIR}/shots/x/x.rules`);
        expect(contentFilePathOf(MOD_DIR, 'mediaEffect', 'x')).toBe(`${MOD_DIR}/effects/x.rules`);
        expect(contentFolderPathOf(MOD_DIR, 'part', 'x')).toBe(`${MOD_DIR}/parts/x`);
        expect(contentFolderPathOf(MOD_DIR, 'mediaEffect', 'x')).toBeUndefined();
    });

    it('gives the media effect a type the registry knows, since that is all that types the file', () => {
        const document = parseText(emitContent('mediaEffect', 'test_thing', '').text, pathFor('mediaEffect'));
        const type = [...namedMembersOf(document)].find(([name]) => name === 'Type')?.[1];
        expect(type && isValueNode(type) ? String(type.valueType.value) : undefined).toBe('Audio');
    });
});
