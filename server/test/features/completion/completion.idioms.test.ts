import { describe, expect, it } from 'vitest';
import { idiomCompletions, IDIOMS } from '../../../src/features/completion/idioms';
import { Completion } from '../../../src/features/completion/autocompletion.service.types';

// An idiom is a technique written as one assignment, offered beside the field names of the class it
// belongs to. The schema can say a part has an `AIValueFactor`, it cannot say that writing zero is
// how the shipped armour drops out of the enemy's target scoring.
const PART = 'Cosmoteer.Ships.Parts.PartRules';

const labels = (completions: Completion[]): string[] =>
    completions.map((completion) => (typeof completion === 'string' ? completion : completion.label));

const only = (completions: Completion[], label: string): Exclude<Completion, string> => {
    const found = completions.find((completion) => typeof completion !== 'string' && completion.label === label);
    if (!found || typeof found === 'string') throw new Error(`no idiom labelled ${label}`);
    return found;
};

describe('the idioms offered beside a class', () => {
    it('offers the armour technique on a part', () => {
        expect(labels(idiomCompletions([PART], new Set()))).toContain('AIValueFactor = 0');
    });

    it('writes the whole assignment, so the technique arrives complete', () => {
        expect(only(idiomCompletions([PART], new Set()), 'AIValueFactor = 0').insertText).toBe('AIValueFactor = 0');
    });

    it('matches the letters of the field name, which is what the author reaches for', () => {
        expect(only(idiomCompletions([PART], new Set()), 'AIValueFactor = 0').filterText).toBe('AIValueFactor');
    });

    it('says what the value does not do, which is the part people get wrong', () => {
        const documentation = only(idiomCompletions([PART], new Set()), 'AIValueFactor = 0').documentation ?? '';
        expect(documentation).toContain('does not make the part untargetable');
        expect(documentation).toContain('picked at random');
    });

    it('withholds the idiom once the file already writes that field', () => {
        expect(labels(idiomCompletions([PART], new Set(['aivaluefactor'])))).toHaveLength(0);
    });

    it('offers nothing to a class that owns no idiom', () => {
        expect(idiomCompletions(['Cosmoteer.Ships.ShipRules'], new Set())).toHaveLength(0);
    });

    it('names a field of the class it is offered beside, so an idiom cannot go stale unnoticed', () => {
        // The withholding above is keyed on the field name, so an entry naming a field its class does
        // not have would be offered forever and could never be written away.
        for (const idiom of IDIOMS) expect(idiom.insertText.startsWith(idiom.field)).toBe(true);
    });
});
