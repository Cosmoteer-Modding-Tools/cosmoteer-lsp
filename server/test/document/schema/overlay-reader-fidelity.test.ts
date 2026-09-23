import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import { Completion } from '../../../src/features/completion/autocompletion.service.types';
import { validateIgnoredFields } from '../../../src/features/diagnostics/validator.ignored-field';

// The hand-written overlay stands for the reads schemagen cannot see, so each of its members has to
// name a key the game's own deserializer reads, and each key that deserializer reads has to be
// there. A member either side of that line shows up as editor advice: one the game discards, or a
// hint that the game ignores what it does read.
const token = CancellationToken.None;
const parseUri = (src: string, uri: string) => parser(lexer(src), uri).value;
const fieldLabels = (cs: Completion[]) => cs.map((c) => (typeof c === 'string' ? c : c.label));

describe('the Texture group form', () => {
    // The caret sits on the blank line inside a `Texture { }` group of a particle effect file.
    const src =
        'Type = Particles\nDef\n{\n\tMaterial\n\t{\n\t\tTexture\n\t\t{\n\t\t\tFile = spark.png\n\t\t\t\n\t\t}\n\t}\n}\n';
    const offset = src.indexOf('\n', src.indexOf('File = spark.png')) + 3;
    const labels = async () => {
        const doc = parseUri(src, 'file:///c%3A/mod/common_effects/p.rules');
        return fieldLabels(await schemaFieldNameCompletions(doc, offset, token));
    };

    it('does not offer a key the texture reader never looks for', async () => {
        expect(await labels()).not.toContain('PreMultiplyByAlpha');
    });

    it('offers the key the texture reader does look for', async () => {
        expect(await labels()).toContain('MultiplyByAlpha');
    });
});

describe("a ship spawner's AI group", () => {
    // A career sector file roots as a spawner, so its `AI` group is the one the game reads as an
    // `AIInfo`: the AI id, the patrol tag, and the parameters inlined beside them.
    const src = 'Type = Ships\nShip = x\nAI\n{\n\t\n}\n';
    const labels = async (offset: number) => {
        const doc = parseUri(src, 'file:///c%3A/mod/modes/career/sectors/s.rules');
        return fieldLabels(await schemaFieldNameCompletions(doc, offset, token));
    };
    const insideAI = src.indexOf('\n\t\n') + 3;

    it('offers the id the game reads out of it', async () => {
        expect(await labels(insideAI)).toContain('Type');
    });

    it('offers the patrol tag the game reads out of it', async () => {
        expect(await labels(insideAI)).toContain('PatrolOriginTag');
    });

    it('still offers the parameters written beside them', async () => {
        expect(await labels(insideAI)).toContain('PatrolRadius');
    });

    it('does not offer the reader path as a member name of the spawner', async () => {
        const offered = await labels(src.indexOf('Ship = x'));
        expect(offered).not.toContain('AI/Type');
        expect(offered).not.toContain('AI/PatrolOriginTag');
    });
});

describe('a widget Children group', () => {
    // `Widgets` is read by `WidgetChildren`1`'s content deserializer, so the game does not ignore it.
    const childrenGroup = (member: string) =>
        parseUri(
            `EffectBuckets\n{\n}\nWidgets\n{\n\tSimpleBox\n\t{\n\t\tChildren\n\t\t{\n\t\t\t${member}\n\t\t}\n\t}\n}\n`,
            'file:///c%3A/mod/cosmoteer.rules'
        );

    it('does not claim the game ignores the child list', async () => {
        const errors = await validateIgnoredFields(childrenGroup('Widgets [ ]'), token);
        expect(errors.filter((e) => e.message.includes("'Widgets'"))).toHaveLength(0);
    });

    it('still says so for a member the group does not read', async () => {
        const errors = await validateIgnoredFields(childrenGroup('ZzNotAChildrenKey = 1'), token);
        expect(errors.filter((e) => e.message.includes("'ZzNotAChildrenKey'"))).toHaveLength(1);
    });
});
