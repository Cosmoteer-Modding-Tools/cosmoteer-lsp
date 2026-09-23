import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { findNodeAtPosition } from '../../../src/utils/ast.utils';
import {
    AutoCompletionModRules,
    modRulesOffsetCompletions,
} from '../../../src/features/completion/autocompletion.mod-rules';
import { Completion, CompletionSuggestion } from '../../../src/features/completion/autocompletion.service.types';

const token = CancellationToken.None;
const completer = new AutoCompletionModRules();
const MANIFEST = 'file:///mod.rules';

const labels = (completions: Completion[]): string[] =>
    completions.map((completion) => (typeof completion === 'string' ? completion : completion.label));

/** The line and character the offset sits at in `source`. */
const positionAt = (source: string, offset: number): { line: number; character: number } => {
    const before = source.slice(0, offset);
    const line = before.split('\n').length - 1;
    return { line, character: offset - (before.lastIndexOf('\n') + 1) };
};

/** The completions the empty-insertion-point path answers with at `offset`. */
const atOffset = (source: string, offset: number): Promise<Completion[]> => {
    const document = parser(lexer(source), MANIFEST).value;
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    return modRulesOffsetCompletions(document, offset, source.slice(lineStart, offset), token);
};

/** The completions the node path answers with for the leaf at `offset`. */
const atNode = (source: string, offset: number): Promise<Completion[]> => {
    const document = parser(lexer(source), MANIFEST).value;
    const node = findNodeAtPosition(document, positionAt(source, offset));
    expect(node).toBeDefined();
    return completer.getCompletions(node as never, token, offset);
};

/** The document text a client writes when the user accepts `label`, using the item's own range. */
const accept = (source: string, completions: Completion[], label: string): string => {
    const item = completions.find(
        (completion): completion is CompletionSuggestion => typeof completion !== 'string' && completion.label === label
    );
    expect(item, `no suggestion labelled ${label}`).toBeDefined();
    expect(item?.range, `suggestion ${label} carries no replace range`).toBeDefined();
    const range = item!.range!;
    const lines = source.split('\n');
    const line = lines[range.start.line];
    lines[range.start.line] =
        line.slice(0, range.start.character) +
        (item!.insertText ?? item!.label) +
        line.slice(range.end.character);
    return lines.join('\n');
};

describe('manifest member completion', () => {
    const manifest = 'ID = "me.mod"\nName = "Mod"\n\nActions\n[\n]\n';

    it('offers the manifest members on an empty line at the top level', async () => {
        const found = labels(await atOffset(manifest, manifest.indexOf('"Mod"\n\n') + 6));
        expect(found).toContain('Version');
        expect(found).toContain('StringsFolder');
        expect(found).toContain('ShipLibraries');
    });

    it('leaves out the members the manifest already carries', async () => {
        const found = labels(await atOffset(manifest, manifest.indexOf('"Mod"\n\n') + 6));
        expect(found).not.toContain('ID');
        expect(found).not.toContain('Name');
        expect(found).not.toContain('Actions');
    });

    it('offers only the spelling the game documents, never the legacy alias', async () => {
        const found = labels(await atOffset(manifest, manifest.indexOf('"Mod"\n\n') + 6));
        expect(found).toContain('ModifiesGameplay');
        expect(found).not.toContain('ModifiesMultiplayer');
    });

    it('treats the legacy alias as the member it binds to', async () => {
        const source = 'ID = "me.mod"\nModifiesMultiplayer = true\n\n';
        const found = labels(await atOffset(source, source.length - 1));
        expect(found).not.toContain('ModifiesGameplay');
    });

    it('offers the manifest members for a half-typed name at the top level', async () => {
        const source = 'ID = "me.mod"\nNam\n';
        const found = labels(await atNode(source, source.indexOf('Nam') + 3));
        expect(found).toContain('Name');
    });

    it('offers the ship-library members inside a ShipLibraries entry', async () => {
        const source = 'ID = "me.mod"\nShipLibraries\n[\n\t{\n\t\t\n\t}\n]\n';
        const found = labels(await atOffset(source, source.indexOf('{\n\t\t\n') + 4));
        expect(found.sort()).toEqual(['Folder', 'NameKey', 'TooltipKey']);
    });

    it('offers the ship-library members for a half-typed name inside an entry', async () => {
        const source = 'ID = "me.mod"\nShipLibraries\n[\n\t{\n\t\tFol\n\t}\n]\n';
        const found = labels(await atNode(source, source.indexOf('Fol') + 3));
        expect(found).toEqual(['Folder']);
    });

    it('offers nothing inside a list that is not Actions', async () => {
        const source = 'ID = "me.mod"\nCompatibleGameVersions\n[\n\t\n]\n';
        expect(await atOffset(source, source.indexOf('[\n\t\n') + 3)).toEqual([]);
    });

    it('offers no manifest member inside an action entry', async () => {
        const source = 'Actions\n[\n\t{\n\t\tAction = Add\n\t\t\n\t}\n]\n';
        const found = labels(await atOffset(source, source.indexOf('Add\n\t\t\n') + 5));
        expect(found).not.toContain('StringsFolder');
        expect(found).toContain('AddTo');
    });
});

describe('manifest member completion with the caret inside a written name', () => {
    const entry = 'Actions\n[\n\t{\n\t\tAction = AddMany\n\t\tAddTo = "x"\n\t}\n]\n';

    it('keeps offering the field name the caret is retyping', async () => {
        const found = labels(await atOffset(entry, entry.indexOf('AddTo') + 3));
        expect(found).toContain('AddTo');
    });

    it('writes another field name over the whole name being retyped', async () => {
        const offset = entry.indexOf('AddTo') + 3;
        const written = accept(entry, await atOffset(entry, offset), 'ManyToAdd');
        expect(written).toContain('\t\tManyToAdd = "x"');
        expect(written).not.toContain('AddManyToAddTo');
    });

    it('writes a manifest member over the whole name being retyped', async () => {
        const source = 'ID = "me.mod"\nVersion = "1"\n';
        const offset = source.indexOf('Version') + 3;
        const written = accept(source, await atOffset(source, offset), 'Description');
        expect(written).toContain('Description = "1"');
    });

    it('leaves the caret in front of a name an insert, with the name still taken', async () => {
        const found = await atOffset(entry, entry.indexOf('AddTo'));
        expect(labels(found)).not.toContain('AddTo');
        expect(found.every((completion) => typeof completion === 'string' || !completion.range)).toBe(true);
    });
});
