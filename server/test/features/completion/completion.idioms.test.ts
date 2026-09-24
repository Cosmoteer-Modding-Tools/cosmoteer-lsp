import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import { Completion } from '../../../src/features/completion/autocompletion.service.types';

// An idiom is a technique written as one assignment, offered beside the field names of the class it
// belongs to. The schema can say a part has an `AIValueFactor`, it cannot say that writing zero is
// how the shipped armour drops out of the enemy's target scoring.
const token = CancellationToken.None;

/** A part whose body the caret sits at the end of, and the source the caret's offset counts in. */
const PART = 'Part\n{\n\tID = cosmoteer.test\n\t';
/** The same part, with the field the idiom writes already written. */
const PART_WITH_FACTOR = 'Part\n{\n\tID = cosmoteer.test\n\tAIValueFactor = 1\n\t';
/** A sprite group inside a part, which owns no idiom of its own. */
const SPRITE = 'Part\n{\n\tSprite\n\t{\n\t\t';

/**
 * What the field-name popup offers where the given prefix ends.
 *
 * @param prefix the file up to the caret, closed off below with the brackets it left open.
 * @param closing the rest of the file.
 * @returns the offered completions, the bare-string ones dropped.
 */
const offeredAt = async (prefix: string, closing: string): Promise<Array<Exclude<Completion, string>>> => {
    const source = prefix + closing;
    const document = parser(lexer(source), 'file:///t.rules').value;
    const completions = await schemaFieldNameCompletions(document, prefix.length, token);
    return completions.filter((completion): completion is Exclude<Completion, string> => typeof completion !== 'string');
};

const idiomIn = (completions: Array<Exclude<Completion, string>>) =>
    completions.find((completion) => completion.label === 'AIValueFactor = 0');

describe('the idioms offered beside a class', () => {
    it('offers the armour technique on a part', async () => {
        expect(idiomIn(await offeredAt(PART, '\n}'))).toBeDefined();
    });

    it('writes the whole assignment, so the technique arrives complete', async () => {
        expect(idiomIn(await offeredAt(PART, '\n}'))?.insertText).toBe('AIValueFactor = 0');
    });

    it('matches the letters of the field name, which is what the author reaches for', async () => {
        expect(idiomIn(await offeredAt(PART, '\n}'))?.filterText).toBe('AIValueFactor');
    });

    it('says what the value does not do, which is the part people get wrong', async () => {
        const documentation = idiomIn(await offeredAt(PART, '\n}'))?.documentation ?? '';
        expect(documentation).toContain('does not make the part untargetable');
        expect(documentation).toContain('picked at random');
    });

    it('withholds the idiom once the file already writes that field', async () => {
        expect(idiomIn(await offeredAt(PART_WITH_FACTOR, '\n}'))).toBeUndefined();
    });

    it('offers nothing to a class that owns no idiom', async () => {
        expect(idiomIn(await offeredAt(SPRITE, '\n\t}\n}'))).toBeUndefined();
    });

    it('names a field of the class it is offered beside, so an idiom cannot go stale unnoticed', async () => {
        // The withholding above is keyed on the field name, so an idiom naming a field its class does
        // not have would be offered forever and could never be written away.
        const labels = (await offeredAt(PART, '\n}')).map((completion) => completion.label);
        expect(labels).toContain('AIValueFactor');
    });
});
