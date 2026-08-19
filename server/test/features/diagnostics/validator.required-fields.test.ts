import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateRequiredFields } from '../../../src/features/diagnostics/validator.required-fields';

const token = CancellationToken.None;
const parse = (src: string, uri = 'file:///t.rules') => parser(lexer(src), uri).value;

// A `Components` group dispatched to PartMultiToggleRules, whose only required field is `Mode`.
const toggle = (body: string) =>
    `Part\n{\n\tComponents\n\t{\n\t\tX\n\t\t{\n\t\t\tType = MultiToggle\n${body}\n\t\t}\n\t}\n}`;

describe('validateRequiredFields', () => {
    it('flags a group missing its required field', async () => {
        const errors = await validateRequiredFields(parse(toggle('')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('Mode');
        expect(errors[0].message).toContain('PartMultiToggleRules');
        expect(errors[0].severity).toBe('warning');
    });

    it('does not flag when the required field is present', async () => {
        expect(await validateRequiredFields(parse(toggle('\t\t\tMode = All')), token)).toHaveLength(0);
    });

    it('does not flag when the required field is inherited from a resolvable base', async () => {
        const src =
            'Part\n{\n\tComponents\n\t{\n' +
            '\t\tBase\n\t\t{\n\t\t\tType = MultiToggle\n\t\t\tMode = All\n\t\t}\n' +
            '\t\tDerived : &Base\n\t\t{\n\t\t\tType = MultiToggle\n\t\t}\n' +
            '\t}\n}';
        expect(await validateRequiredFields(parse(src), token)).toHaveLength(0);
    });

    it('stays silent when an inheritance base cannot be resolved (no false positive)', async () => {
        // Mode is absent here, but the unresolved base might supply it, so the group is skipped.
        const src = 'Part\n{\n\tComponents\n\t{\n\t\tX : &NoSuchBase\n\t\t{\n\t\t\tType = MultiToggle\n\t\t}\n\t}\n}';
        expect(await validateRequiredFields(parse(src), token)).toHaveLength(0);
    });

    it('does not flag a template base that another group inherits from (even if it lacks the field)', async () => {
        // BASE_TOGGLE omits Mode but is a template completed by Real, so it must not be flagged.
        const src =
            'Part\n{\n\tComponents\n\t{\n' +
            '\t\tBASE_TOGGLE\n\t\t{\n\t\t\tType = MultiToggle\n\t\t}\n' +
            '\t\tReal : &BASE_TOGGLE\n\t\t{\n\t\t\tType = MultiToggle\n\t\t\tMode = All\n\t\t}\n' +
            '\t}\n}';
        expect(await validateRequiredFields(parse(src), token)).toHaveLength(0);
    });

    it('does not flag a group named as a base in the workspace index (cross-file template)', async () => {
        // X has its own Type and lacks Mode, but the project index says its name is an inheritance base.
        const doc = parse(toggle(''));
        const groupName = 'X';
        expect(await validateRequiredFields(doc, token, new Set([groupName]))).toHaveLength(0);
        // Without the index entry it IS flagged (sanity that the set is what suppresses it).
        expect(await validateRequiredFields(doc, token, new Set())).toHaveLength(1);
    });

    it('does not flag a group inheriting from a `~`-rooted runtime template', async () => {
        const src = 'Part\n{\n\tComponents\n\t{\n\t\tX : ~/LIB/TOGGLE\n\t\t{\n\t\t\tType = MultiToggle\n\t\t}\n\t}\n}';
        expect(await validateRequiredFields(parse(src), token)).toHaveLength(0);
    });

    it('does not flag groups whose class cannot be resolved', async () => {
        const src = 'Foo\n{\n\tBar\n\t{\n\t\tBaz = 1\n\t}\n}';
        expect(await validateRequiredFields(parse(src), token)).toHaveLength(0);
    });

    it('ignores mod.rules documents', async () => {
        expect(await validateRequiredFields(parse(toggle(''), 'file:///mod.rules'), token)).toHaveLength(0);
    });

    // The schema overlay marks the parallel-deserialized music track collections required, since the
    // game dereferences them without a null guard, so an absent key crashes the load. schemagen leaves
    // every collection optional, so this check only fires through the overlay.
    const musicUri = 'file:///data/music/test.rules';
    // A nested Layers sub-track inside a Layers list, so it is a resolvable group the check reaches
    // (the whole-file track at the document root is not a group node and is not inspected).
    const nestedLayers = (inner: string) => `Type = Layers\nLayers\n[\n\t{\n\t\tType = Layers\n${inner}\n\t}\n]\n`;

    it('flags a Layers music track missing its required Layers collection', async () => {
        const errors = await validateRequiredFields(parse(nestedLayers(''), musicUri), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('Layers');
        expect(errors[0].message).toContain('MusicLayersTrackRules');
    });

    it('does not flag a Layers music track that writes its Layers collection', async () => {
        const src = nestedLayers('\t\tLayers\n\t\t[\n\t\t\t{\n\t\t\t\tType = File\n\t\t\t\tFile = "x.music"\n\t\t\t}\n\t\t]');
        expect(await validateRequiredFields(parse(src, musicUri), token)).toHaveLength(0);
    });

    // The finding is anchored on the group's name, which is not a place anything can be written, so
    // the quick fix needs the insert offset handed to it on the diagnostic.
    it('carries the insert payload the quick fix needs', async () => {
        const src = toggle('');
        const errors = await validateRequiredFields(parse(src), token);
        const insert = errors[0].data?.insertRequiredFields;
        expect(insert).toBeDefined();
        // `Mode` is an enum, so the fix has a value it may write.
        expect(insert?.fields.map((field) => field.name)).toEqual(['Mode']);
        expect(insert?.fieldIndex).toBe(0);
        // The offset sits at the end of the last member and before the group's own `}`.
        expect(src.slice(0, insert!.offset).endsWith('Type = MultiToggle')).toBe(true);
        expect(src[insert!.groupEnd - 1]).toBe('}');
    });
});
