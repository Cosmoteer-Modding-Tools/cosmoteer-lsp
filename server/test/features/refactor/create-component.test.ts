import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    createComponent,
    CreateComponentResult,
} from '../../../src/features/refactor/create-component/create-component.command';
import { plainTextOf } from '../../../src/features/refactor/snippet-action';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { globalSettings, setGlobalSettings } from '../../../src/settings';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const PART_PATH = workspaceFile('parts', 'wired_part.rules');
const URI = filePathToUri(PART_PATH);
const token = CancellationToken.None;

const WIRED = [
    'Part',
    '{',
    '\tID = wired_part',
    '\tComponents',
    '\t{',
    '\t\tturret',
    '\t\t{',
    '\t\t\tType = TurretWeapon',
    '\t\t\tFireTrigger = trigger',
    '\t\t}',
    '\t}',
    '}',
    '',
].join('\n');

/** The command run against a buffer the editor has open, which is what the quick fix does. */
const run = (text: string, name: string, type?: string): Promise<CreateComponentResult> => {
    const open = TextDocument.create(URI, 'rules', 0, text);
    // The quick fix anchors on the reference that named nothing, wherever the name itself resolves.
    const offset = text.indexOf('trigger', text.indexOf('FireTrigger') + 'FireTrigger'.length);
    return createComponent({ uri: URI, offset, name, type }, { openDocuments: () => [open] }, token);
};

/** The document as the declaration would leave it, read through the plain form of the snippet. */
const applied = (result: CreateComponentResult, text: string): string => {
    if (!('insert' in result)) throw new Error(`no insert: ${JSON.stringify(result)}`);
    const document = TextDocument.create(URI, 'rules', 0, text);
    return TextDocument.applyEdits(document, [
        { range: result.insert.range, newText: plainTextOf(result.insert.snippet) },
    ]);
};

// Wiring a component before declaring it is how a part gets written, and the editor already completes
// the name from the reference. What was missing was the declaration the name points at.
describe('create a referenced component', () => {
    beforeAll(async () => {
        await initWorkspace();
        setGlobalSettings({ ...globalSettings, allowEditingVanillaFiles: true });
    });

    it('reports the component kinds the part may declare', async () => {
        const result = await run(WIRED, 'trigger');
        if (!('choices' in result)) throw new Error('no choices');
        expect(result.choices.length).toBeGreaterThan(50);
        expect(result.choices.map((choice) => choice.type)).toContain('BurstTrigger');
    });

    it('declares the component beside the one that references it', async () => {
        const result = await run(WIRED, 'trigger', 'BurstTrigger');
        const text = applied(result, WIRED);
        expect(text).toContain('\t\ttrigger\n\t\t{\n\t\t\tType = BurstTrigger');
        expect(text.indexOf('trigger\n\t\t{')).toBeGreaterThan(text.indexOf('turret'));
    });

    it('scaffolds every field the game throws without', async () => {
        const result = await run(WIRED, 'trigger', 'BurstTrigger');
        if (!('insert' in result)) throw new Error('no insert');
        // A required field carries a tab stop, so the author walks them rather than hunting for them.
        expect(result.insert.snippet).toMatch(/\$\{1:/);
    });

    it('writes a components group when the part inherits the one it has', async () => {
        const inheriting = [
            'Part : <base_part.rules>/Part',
            '{',
            '\tID = derived_part',
            '\tFireTrigger = trigger',
            '}',
            '',
        ].join('\n');
        const result = await run(inheriting, 'trigger', 'BurstTrigger');
        const text = applied(result, inheriting);
        expect(text).toContain('Components\n\t{\n\t\ttrigger');
    });

    it('refuses a name the file already declares', async () => {
        const result = await run(WIRED, 'turret', 'TurretWeapon');
        expect(result).toEqual({ failure: 'alreadyDeclared' });
    });

    it('refuses a kind that is not a component of this owner', async () => {
        const result = await run(WIRED, 'trigger', 'NotAComponentKind');
        expect(result).toEqual({ failure: 'unknownType' });
    });
});
