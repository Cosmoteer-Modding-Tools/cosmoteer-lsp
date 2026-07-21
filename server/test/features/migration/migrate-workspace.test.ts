import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { collectFileMigration } from '../../../src/features/migration/migrate-workspace';

// The workspace migration's per-file collector: migration-tagged findings become text edits (the
// exact same fixes the interactive quick fixes offer), fix-less findings become manual-review
// entries, and the result applies cleanly to the file text.
const token = CancellationToken.None;

const migrate = async (text: string, uri = 'file:///data/parts/t.rules', includeDeadFields = false) => {
    const doc = TextDocument.create(uri, 'rules', 0, text);
    const parserResult = parser(lexer(text), uri);
    expect(parserResult.parserErrors).toEqual([]);
    const result = await collectFileMigration(parserResult.value, doc, includeDeadFields, token);
    return { result, applied: TextDocument.applyEdits(doc, result.edits) };
};

describe('collectFileMigration', () => {
    it('renames a deprecated discriminator in place', async () => {
        const { result, applied } = await migrate(
            'Part\n{\n\tComponents\n\t{\n\t\tStore\n\t\t{\n\t\t\tType = AmmoStorage\n\t\t}\n\t}\n}\n'
        );
        expect(applied).toContain('Type = ResourceStorage');
        // The Ammo→Resource rename predates the recorded changelogs: the empty version key.
        expect(result.byVersion['']).toBe(1);
    });

    it('applies a field rename and groups it under its game version', async () => {
        const { result, applied } = await migrate('Part\n{\n\tCreatePartWhenDestroyed = cosmoteer.structure\n}\n');
        expect(applied).toContain('UnderlyingPart = cosmoteer.structure');
        expect(applied).not.toContain('CreatePartWhenDestroyed');
        expect(result.byVersion['0.23.0']).toBe(1);
    });

    it('rewrites Flammable = false into the local TypeCategories list and removes the line', async () => {
        const { result, applied } = await migrate(
            'Part\n{\n\tTypeCategories = [ammo_factory]\n\tFlammable = false\n}\n'
        );
        expect(applied).toContain('TypeCategories = [ammo_factory, non_flammable]');
        expect(applied).not.toContain('Flammable');
        expect(result.byVersion['0.30.0']).toBe(1);
        expect(result.manual).toEqual([]);
    });

    it('reports Flammable = false without a local TypeCategories as manual', async () => {
        const { result, applied } = await migrate('Part\n{\n\tFlammable = false\n}\n');
        expect(applied).toContain('Flammable = false');
        expect(result.manual).toHaveLength(1);
        expect(result.manual[0].message).toContain('non_flammable');
        expect(result.manual[0].line).toBe(3);
    });

    it('removes Flammable = true outright', async () => {
        const { applied } = await migrate('Part\n{\n\tFlammable = true\n\tMaxHealth = 100\n}\n');
        expect(applied).not.toContain('Flammable');
        expect(applied).toContain('MaxHealth = 100');
    });

    it('wraps ExplosiveDamageResistance into a DamageResistances map entry', async () => {
        const { applied } = await migrate('Part\n{\n\tExplosiveDamageResistance = 0.4\n}\n');
        expect(applied).toContain('DamageResistances = { explosive = 0.4 }');
    });

    it('renames the ModifiesMultiplayer manifest flag', async () => {
        const { result, applied } = await migrate(
            'ID = my.mod\nName = "My Mod"\nModifiesMultiplayer = true\n',
            'file:///mod/mod.rules'
        );
        expect(applied).toContain('ModifiesGameplay = true');
        expect(result.byVersion['0.24.0']).toBe(1);
    });

    it('leaves dead fields alone by default and strips them on request', async () => {
        const source = 'Part\n{\n\tFireDamageFactor = 2\n\tMaxHealth = 100\n}\n';
        const kept = await migrate(source);
        expect(kept.applied).toContain('FireDamageFactor');
        expect(kept.result.deadFieldsRemoved).toBe(0);
        const stripped = await migrate(source, 'file:///data/parts/t.rules', true);
        expect(stripped.applied).not.toContain('FireDamageFactor');
        expect(stripped.result.deadFieldsRemoved).toBe(1);
        expect(stripped.applied).toContain('MaxHealth = 100');
    });

    it('applies several migrations in one file without overlapping edits', async () => {
        const { result, applied } = await migrate(
            'Part\n{\n\tTypeCategories = [ammo_factory]\n\tFlammable = false\n\tCreatePartPerTileWhenDestroyed = cosmoteer.structure\n\tComponents\n\t{\n\t\tStore\n\t\t{\n\t\t\tType = AmmoConsumer\n\t\t}\n\t}\n}\n'
        );
        expect(applied).toContain('TypeCategories = [ammo_factory, non_flammable]');
        expect(applied).toContain('UnderlyingPartPerTile = cosmoteer.structure');
        expect(applied).toContain('Type = ResourceConsumer');
        expect(Object.values(result.byVersion).reduce((a, b) => a + b, 0)).toBe(3);
    });
});
