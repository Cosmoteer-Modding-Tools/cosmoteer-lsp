import { describe, expect, it } from 'vitest';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    InsertSchemaFieldArgs,
    buildInsertSchemaFieldEdit,
} from '../../../src/features/schema-search/schema-search.insert';
import { fieldEntryId } from '../../../src/features/schema-search/schema-search.index';

const PART = 'Cosmoteer.Ships.Parts.PartRules';
const STATUS = 'Cosmoteer.Ships.Statuses.StatusType';
const MEDIA_EFFECT = 'Cosmoteer.Simulation.MediaEffects.MediaEffectRules';

/** Builds the insert for the caret marked by `|`, against a document of the given uri. */
const insertAt = async (source: string, uri: string, id: string, args: Partial<InsertSchemaFieldArgs> = {}) => {
    const offset = source.indexOf('|');
    const text = source.replace('|', '');
    const document = TextDocument.create(uri, 'rules', 1, text);
    const parserResult = parser(lexer(text), uri).value;
    return buildInsertSchemaFieldEdit(
        { uri, id, position: document.positionAt(offset), ...args },
        document,
        parserResult,
        CancellationToken.None
    );
};

/** The document as it reads once the built edit is applied. */
const applied = (source: string, uri: string, edit: TextEdit): string => {
    const text = source.replace('|', '');
    return TextDocument.applyEdits(TextDocument.create(uri, 'rules', 1, text), [edit]);
};

/** Asserts the build produced an edit and hands it back. */
const editOf = (result: Awaited<ReturnType<typeof insertAt>>): TextEdit => {
    if ('failure' in result) throw new Error(`expected an edit, got failure "${result.failure}"`);
    return result.edit;
};

// The insert writes into the user's file from a picker that may have been open while they typed, so
// every rule that decides whether the field belongs where the caret is has to hold at write time,
// not at search time.
describe('buildInsertSchemaFieldEdit', () => {
    const partUri = 'file:///parts/test.rules';

    it('writes a scalar field on its own line at the group members indentation', async () => {
        const source = 'Part\n{\n\tMaxHealth = 100|\n}\n';
        const result = await insertAt(source, partUri, fieldEntryId(PART, 'MaxDoors'));
        expect(editOf(result).newText).toBe('\n\tMaxDoors = 0');
        expect(applied(source, partUri, editOf(result))).toBe('Part\n{\n\tMaxHealth = 100\n\tMaxDoors = 0\n}\n');
    });

    it('writes a group field as the multi-line scaffold, every line indented with the members', async () => {
        const source = 'Part\n{\n\tMaxHealth = 100|\n}\n';
        const result = await insertAt(source, partUri, fieldEntryId(PART, 'Size'));
        expect(editOf(result).newText).toBe('\n\tSize\n\t{\n\t\t\n\t}');
    });

    it('primes the discriminator of a polymorphic group field', async () => {
        const source = 'ID = test|\n';
        const result = await insertAt(source, 'file:///statuses/test.rules', fieldEntryId(STATUS, 'ValueCombiner'));
        expect(editOf(result).newText).toBe('\nValueCombiner\n{\n\tType = \n}');
    });

    it('keeps the line ending the file already uses', async () => {
        const source = 'Part\r\n{\r\n\tMaxHealth = 100|\r\n}\r\n';
        const result = await insertAt(source, partUri, fieldEntryId(PART, 'MaxDoors'));
        expect(editOf(result).newText).toBe('\r\n\tMaxDoors = 0');
    });

    it('opens a line under the brace when the caret sits before every member', async () => {
        const source = 'Part\n{|\n\tMaxHealth = 100\n}\n';
        const result = await insertAt(source, partUri, fieldEntryId(PART, 'MaxDoors'));
        expect(applied(source, partUri, editOf(result))).toBe('Part\n{\n\tMaxDoors = 0\n\tMaxHealth = 100\n}\n');
    });

    it('indents one level past the brace in a group that has no members yet', async () => {
        const source = 'Part\n{|\n}\n';
        const result = await insertAt(source, partUri, fieldEntryId(PART, 'MaxDoors'));
        expect(applied(source, partUri, editOf(result))).toBe('Part\n{\n    MaxDoors = 0\n}\n');
    });

    it('accepts a field declared on a base class when the caret resolves to a deriver', async () => {
        // The caret's document is a whole-file `Beam` effect, and `Delay` is declared three classes
        // up on MediaEffectRules. The game reads it there, so the picker must be allowed to write it.
        const source = 'Type = Beam\nZ = 1|\n';
        const uri = 'file:///common_effects/test.rules';
        const result = await insertAt(source, uri, fieldEntryId(MEDIA_EFFECT, 'Delay'));
        expect(editOf(result).newText).toBe('\nDelay = 0');
        expect(applied(source, uri, editOf(result))).toBe('Type = Beam\nZ = 1\nDelay = 0\n');
    });

    it('refuses a field that belongs to an unrelated class', async () => {
        const result = await insertAt(
            'Type = Beam\nZ = 1|\n',
            'file:///common_effects/test.rules',
            fieldEntryId(PART, 'MaxHealth')
        );
        expect(result).toEqual({ failure: 'classMismatch' });
    });

    it('refuses a caret whose position has no schema class at all', async () => {
        const result = await insertAt('Foo = 1|\n', 'file:///random.rules', fieldEntryId(PART, 'MaxHealth'));
        expect(result).toEqual({ failure: 'noContext' });
    });

    it('refuses a list element position, where a named field is not a member', async () => {
        const source = 'Part\n{\n\tOtherIDs [ a, |b ]\n}\n';
        const result = await insertAt(source, partUri, fieldEntryId(PART, 'MaxDoors'));
        expect(result).toEqual({ failure: 'noContext' });
    });

    it('refuses an entry that is not a field', async () => {
        const result = await insertAt('Part\n{\n\tMaxHealth = 100|\n}\n', partUri, `t:${PART}`);
        expect(result).toEqual({ failure: 'notAField' });
    });

    it('refuses a caret captured against a version the buffer has moved past', async () => {
        const result = await insertAt('Part\n{\n\tMaxHealth = 100|\n}\n', partUri, fieldEntryId(PART, 'MaxDoors'), {
            documentVersion: 7,
        });
        expect(result).toEqual({ failure: 'stale' });
    });
});
