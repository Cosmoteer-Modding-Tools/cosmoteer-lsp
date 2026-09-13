import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    asBareFieldNames,
    crossFileReferenceTargetAtOffset,
    atFinishedQuotedValue,
    isInsideComment,
    schemaFieldNameCompletions,
    schemaValueCompletionsAtOffset,
} from '../../../src/features/completion/autocompletion.schema-fields';
import { modRulesOffsetCompletions } from '../../../src/features/completion/autocompletion.mod-rules';
import { Completion } from '../../../src/features/completion/autocompletion.service';

const token = CancellationToken.None;
const labels = (cs: Completion[] | undefined): string[] =>
    (cs ?? []).map((c) => (typeof c === 'string' ? c : c.label));

const parse = (src: string, uri = 'file:///part.rules') => parser(lexer(src), uri).value;

/** The line text up to the offset, the way the server hands it to the completers. */
const prefixAt = (src: string, offset: number): string => src.slice(src.lastIndexOf('\n', offset - 1) + 1, offset);

describe('a comment takes no completions', () => {
    it('sees a line comment', () => {
        const src = 'Part\n{\n\t// Foo = \n}\n';
        expect(isInsideComment(src, src.indexOf('Foo = ') + 6)).toBe(true);
    });

    it('sees a block comment spanning lines', () => {
        const src = 'Part\n{\n\t/* Mode = \n\t   more */\n\tMaxHealth = 1\n}\n';
        expect(isInsideComment(src, src.indexOf('Mode = ') + 7)).toBe(true);
        expect(isInsideComment(src, src.indexOf('MaxHealth'))).toBe(false);
    });

    it('does not read a path written in a value as a comment', () => {
        const src = 'Part\n{\n\tFile = "a//b.png"\n\tMaxHealth = 1\n}\n';
        expect(isInsideComment(src, src.indexOf('MaxHealth'))).toBe(false);
    });
});

describe('a value position lasts to the end of the written value', () => {
    const PART = 'Part\n{\n\tID = test.part\n\tDensity = 1 / \n}\n';

    it('does not offer field names mid-expression', async () => {
        const offset = PART.indexOf('1 / ') + 4;
        const values = await schemaValueCompletionsAtOffset(parse(PART), offset, prefixAt(PART, offset), token);
        // Defined (so the caller offers no field snippets), and a float field has no listable values.
        expect(values).toEqual([]);
    });

    it('still reads a half-typed quoted value as a value position', async () => {
        const src = 'Part\n{\n\tEditorGroup = "Weap\n}\n';
        const offset = src.indexOf('"Weap') + 5;
        expect(await schemaValueCompletionsAtOffset(parse(src), offset, prefixAt(src, offset), token)).toBeDefined();
    });

    it('treats a closed quoted value as finished', async () => {
        const src = 'Part\n{\n\tEditorGroup = "Weapons"\n}\n';
        const offset = src.indexOf('"Weapons"') + 9;
        expect(
            await schemaValueCompletionsAtOffset(parse(src), offset, prefixAt(src, offset), token)
        ).toBeUndefined();
    });

    it('keeps a label field free of the project ids', () => {
        const src = 'Part\n{\n\tSelectionTypeID = \n\tEditorReplacementPartID = \n}\n';
        const label = src.indexOf('SelectionTypeID = ') + 18;
        const real = src.indexOf('EditorReplacementPartID = ') + 26;
        expect(crossFileReferenceTargetAtOffset(parse(src), label, prefixAt(src, label))).toBeUndefined();
        // A field the engine really resolves keeps its id completion.
        expect(crossFileReferenceTargetAtOffset(parse(src), real, prefixAt(src, real))).toBeDefined();
    });
});

describe('the caret behind a finished quoted value', () => {
    it('is no place for a field name, since a member needs a separator first', () => {
        expect(atFinishedQuotedValue('	NameKey = "Parts/Test"')).toBe(true);
        expect(atFinishedQuotedValue('	EditorGroup = "Weapons"  ')).toBe(true);
    });

    it('leaves every position something can still be written at alone', () => {
        expect(atFinishedQuotedValue('	NameKey = "Parts/Te')).toBe(false);
        expect(atFinishedQuotedValue('	MaxHealth = 100')).toBe(false);
        expect(atFinishedQuotedValue('	')).toBe(false);
        expect(atFinishedQuotedValue('	G { A = "x"; ')).toBe(false);
        expect(atFinishedQuotedValue('	// NameKey = "Parts/Test"')).toBe(false);
    });
});

describe('a name retyped over an existing key', () => {
    it('inserts the bare name instead of a second assignment', async () => {
        const src = 'Part\n{\n\tMax = 1\n}\n';
        const offset = src.indexOf('Max') + 3;
        const fields = await schemaFieldNameCompletions(parse(src), offset, token);
        const range = { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } };
        const bare = asBareFieldNames(fields, range).find(
            (c) => typeof c !== 'string' && c.label === 'MaxHealth'
        );
        expect(bare).toBeDefined();
        const suggestion = bare as { insertText?: string; isSnippet?: boolean };
        expect(suggestion.insertText).toBe('MaxHealth');
        expect(suggestion.isSnippet).toBe(false);
    });
});

describe('manifest value positions', () => {
    const MANIFEST = (line: string) => `ID = x\nActions\n[\n\t{\n\t\t${line}\n\t}\n]\n`;
    const completeAt = async (line: string) => {
        const src = MANIFEST(line);
        const offset = src.indexOf(line) + line.length;
        return modRulesOffsetCompletions(parse(src, 'file:///mod.rules'), offset, prefixAt(src, offset), token);
    };

    it('offers the verbs after `Action = `', async () => {
        const names = labels(await completeAt('Action = '));
        expect(names).toContain('Add');
        expect(names).toContain('Overrides');
        expect(names).not.toContain('AddTo');
    });

    it('offers true and false for a flag field', async () => {
        expect(labels(await completeAt('OnlyIfNotExisting = '))).toEqual(['true', 'false']);
    });

    it('offers the game-root path prefixes for a target field', async () => {
        expect(labels(await completeAt('AddTo = '))).toEqual(['<./Data/', '<']);
    });

    it('offers the reference prefixes for a source field', async () => {
        expect(labels(await completeAt('ToAdd = '))).toContain('&<');
    });

    it('offers nothing where nothing fits', async () => {
        expect(await completeAt('Name = ')).toEqual([]);
    });

    it('still offers the field names where no value is being written', async () => {
        const src = MANIFEST('Action = Add\n\t\t');
        const offset = src.indexOf('Action = Add') + 'Action = Add\n\t\t'.length;
        const names = labels(
            await modRulesOffsetCompletions(parse(src, 'file:///mod.rules'), offset, prefixAt(src, offset), token)
        );
        expect(names).toContain('AddTo');
        expect(names).toContain('ToAdd');
    });
});
