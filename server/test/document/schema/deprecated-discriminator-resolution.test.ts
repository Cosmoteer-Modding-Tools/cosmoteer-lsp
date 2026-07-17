import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { classByDiscriminator, firstRegistryDeclaring } from '../../../src/document/schema/schema';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';
import { Completion } from '../../../src/features/completion/autocompletion.service';

// A mod written against an older Cosmoteer still spells a renamed `Type=` (e.g. `AmmoDrain`, now
// `ResourceDrain`). The deprecation hint on the `Type =` line says so, but the group must not go
// dark: its class resolves through the rename so hover, completion and validation inside keep
// working while the modder migrates.
const token = CancellationToken.None;
const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;
const labelsOf = (cs: Completion[]) => cs.map((c) => (typeof c === 'string' ? c : c.label));

describe('deprecated discriminator resolution', () => {
    it('resolves a renamed discriminator to the current class', () => {
        expect(classByDiscriminator('AmmoDrain')).toBe('Cosmoteer.Simulation.HitEffects.ResourceDrainEffectRules');
        expect(classByDiscriminator('AmmoStorage')).toBe('Cosmoteer.Ships.Parts.Resources.ResourceStorageRules');
    });

    it('pins the registry of a renamed discriminator through the current name', () => {
        expect(firstRegistryDeclaring('AmmoDrain')?.name).toBe(firstRegistryDeclaring('ResourceDrain')?.name);
    });

    it('offers the current class fields inside a group typed with the old name', async () => {
        const SRC =
            'Part\n{\n\tComponents\n\t{\n\t\tKnown\n\t\t{\n\t\t\tType = ResourceStorage\n\t\t}\n\t\tX\n\t\t{\n\t\t\tType = AmmoStorage\n\t\t\t\n\t\t}\n\t}\n}';
        const gapOffset = SRC.indexOf('Type = AmmoStorage') + 'Type = AmmoStorage\n\t\t\t'.length;
        const labels = labelsOf(await schemaFieldNameCompletions(parse(SRC), gapOffset, token));
        // ResourceStorageRules fields appear even though the written Type is the pre-rename name.
        expect(labels).toContain('ResourceType');
    });

    it('still flags the rename on the Type line', async () => {
        const SRC =
            'Part\n{\n\tComponents\n\t{\n\t\tKnown\n\t\t{\n\t\t\tType = ResourceStorage\n\t\t}\n\t\tX\n\t\t{\n\t\t\tType = AmmoStorage\n\t\t}\n\t}\n}';
        const errors = await validateSchema(parse(SRC), token);
        const renamed = errors.filter((e) => e.message.includes('renamed'));
        expect(renamed).toHaveLength(1);
        expect(renamed[0].data?.quickFix?.newText).toBe('ResourceStorage');
    });
});
