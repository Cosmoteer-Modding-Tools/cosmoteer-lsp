import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    invalidateLooseDeclarationCache,
    validateCrossFileIdReferences,
} from '../../../src/features/diagnostics/validator.schema-id-reference';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { ParserResultRegistrar } from '../../../src/document/parser-result-registrar';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { globalSettings } from '../../../src/settings';

// `ID` means one thing on a part (this is who I am) and another inside a part criteria (this is who
// I match), and the loose declaration probe reads the written shape rather than the position, so a
// criteria used to declare its own typo and then excuse it. A separate file from the main
// id-reference suite, because the label-field derivation memoizes per field and class for the
// session and a shared fixture would decide this field's verdict before the tests below run.
const token = CancellationToken.None;

const parse = (source: string, uri: string) => {
    const document = parser(lexer(source), uri).value;
    ParserResultRegistrar.instance.setResult(uri, document);
    return document;
};

/** A part whose buff provider matches other parts by the given criteria member. */
const partWithCriteria = (member: string, value: string) =>
    parse(
        [
            'Part',
            '{',
            '\tID = my_part',
            '\tComponents',
            '\t{',
            '\t\tBelt',
            '\t\t{',
            '\t\t\tType = AreaBuffProvider',
            '\t\t\tCriteria',
            '\t\t\t{',
            `\t\t\t\t${member} = ${value}`,
            '\t\t\t}',
            '\t\t}',
            '\t}',
            '}',
            '',
        ].join('\n'),
        'file:///c%3A/mod/ships/belt.rules'
    );

describe('an ID written where the class reads one rather than declares one', () => {
    let tmpRoot: string;
    let workspaceUri: string;
    let folders: string[];

    beforeAll(() => {
        tmpRoot = mkdtempSync(join(tmpdir(), 'idref-criteria-'));
        // The project's own parts, the pool every part-id reference is judged against.
        const partsDir = join(tmpRoot, 'data', 'ships');
        mkdirSync(partsDir, { recursive: true });
        writeFileSync(join(partsDir, 'armor.rules'), ['Part', '{', '\tID = test.armor', '}', ''].join('\n'));
        workspaceUri = pathToFileURL(join(tmpRoot, 'data')).href;
        // A miniature game data root, whose part writes an id that resolves inside it, so the
        // label-field derivation reads `ID` as the resolving reference it is.
        const gameDir = join(tmpRoot, 'game', 'Data');
        mkdirSync(join(gameDir, 'ships'), { recursive: true });
        writeFileSync(
            join(gameDir, 'ships', 'armor.rules'),
            ['Part', '{', '\tID = cosmoteer.armor', '\tEditorParentParts = [cosmoteer.armor]', '}', ''].join('\n')
        );
        folders = [workspaceUri, pathToFileURL(gameDir).href];
        globalSettings.cosmoteerPath = gameDir;
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        const noop: WorkDoneProgressReporter = {
            begin: () => undefined,
            report: () => undefined,
            done: () => undefined,
        };
        return service.initialize(gameDir, noop);
    });

    afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

    beforeEach(() => {
        SchemaIdIndex.instance.reset();
        invalidateLooseDeclarationCache();
    });

    it('flags a criteria ID naming a part nothing declares', async () => {
        const errors = await validateCrossFileIdReferences(
            partWithCriteria('ID', 'test.zz_not_a_part'),
            folders,
            token
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('test.zz_not_a_part');
    });

    it('reports the singular and the plural spelling the same way', async () => {
        const singular = await validateCrossFileIdReferences(
            partWithCriteria('ID', 'test.zz_not_a_part'),
            folders,
            token
        );
        SchemaIdIndex.instance.reset();
        invalidateLooseDeclarationCache();
        const plural = await validateCrossFileIdReferences(
            partWithCriteria('IDs', '[test.zz_not_a_part]'),
            folders,
            token
        );
        expect(singular.map((error) => error.message)).toEqual(plural.map((error) => error.message));
        expect(singular).toHaveLength(1);
    });

    it('says nothing when the criteria names a part the project declares', async () => {
        expect(await validateCrossFileIdReferences(partWithCriteria('ID', 'test.armor'), folders, token)).toHaveLength(
            0
        );
    });

    it('still lets an unrooted fragment declare its own part id', async () => {
        // Nothing types the fragment's container, so the probe keeps its leniency there, which is
        // the case it was written for.
        const fragment = parse(
            ['ID = test.zz_fragment_part', 'MaxHealth = 100', ''].join('\n'),
            'file:///c%3A/mod/ships/fragment.rules'
        );
        expect(await validateCrossFileIdReferences(fragment, folders, token)).toHaveLength(0);
    });
});
