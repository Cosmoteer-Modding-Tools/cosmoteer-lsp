import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { TemplateBaseIndex } from '../../../src/features/diagnostics/template-base.index';
import { clearFsCaches } from '../../../src/workspace/fs-cache';
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

    it('still flags a group whose name only collides with a workspace base name', async () => {
        // A shared name proves nothing: 15.7% of vanilla's typed groups are named like some base leaf
        // elsewhere in the install, and nothing in this workspace inherits from this X.
        const doc = parse(toggle(''));
        expect(await validateRequiredFields(doc, token, new Set(['X']))).toHaveLength(1);
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

    // Beyond the registry-dispatched groups: a nested group whose declaring field names one concrete
    // class is judged the same way, which is 1686 required fields the check never reached.
    describe('slot-typed nested groups', () => {
        // A part's salvage effects: the field names `MultiMediaEffectRules` outright, the group carries
        // no `Type=`, and the game throws on an absent `Effects` (`[Serialize]` with no `Optional = true`).
        const effects = (body: string, base = '') => `Part${base}\n{\n\tSalvageProgressMediaEffects\n\t{\n${body}\n\t}\n}`;

        it('flags a slot-typed group missing a required field', async () => {
            const errors = await validateRequiredFields(parse(effects('')), token);
            expect(errors.map((error) => error.message)).toEqual([
                "Missing required field 'Effects' on MultiMediaEffectRules.",
            ]);
        });

        it('does not flag the complete group', async () => {
            expect(await validateRequiredFields(parse(effects('\t\tEffects\n\t\t[\n\t\t]')), token)).toHaveLength(0);
        });

        it('does not flag anything under a container that inherits', async () => {
            // The base merges its own tree in member by member, so a nested group may be completed by a
            // node this file never mentions.
            expect(await validateRequiredFields(parse(effects('', ' : &<other.rules>/Part')), token)).toHaveLength(0);
        });

        it('does not flag a class the game also reads in another write form', async () => {
            // `Size { X … Y … }` is one spelling of an IntVector2, which the engine also reads
            // positionally, so an absent member is not an absent value.
            const src = 'Part\n{\n\tSize\n\t{\n\t\tX = 1\n\t}\n}';
            expect(await validateRequiredFields(parse(src), token)).toHaveLength(0);
        });

        it('does not flag a file root, whose class is only how something else pulls the file in', async () => {
            expect(await validateRequiredFields(parse('Part\n{\n}'), token)).toHaveLength(0);
        });
    });

    // A real cross-file template: another file inherits from this very group, so it is completed by its
    // deriver and must stay silent. This is the positional half of the workspace-base test above.
    describe('cross-file template base', () => {
        let dir: string | undefined;

        afterEach(() => {
            TemplateBaseIndex.instance.reset();
            clearFsCaches();
            if (dir) rmSync(dir, { recursive: true, force: true });
            dir = undefined;
        });

        const component = (name: string, body: string) =>
            `Part\n{\n\tComponents\n\t{\n\t\t${name}\n\t\t{\n\t\t\tType = MultiToggle\n${body}\n\t\t}\n\t}\n}`;
        const BASE = component('X', '');
        const DERIVED = component('Real : <base.rules>/Part/Components/X', '\t\t\tMode = All');

        const buildWorkspace = async (files: Record<string, string>): Promise<string> => {
            dir = mkdtempSync(join(tmpdir(), 'required-fields-'));
            for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
            TemplateBaseIndex.instance.reset();
            clearFsCaches();
            await TemplateBaseIndex.instance.baseNames([dir], token);
            return dir;
        };

        const validateBase = async (root: string): Promise<number> => {
            const names = await TemplateBaseIndex.instance.baseNames([root], token);
            const doc = parse(BASE, pathToFileURL(join(root, 'base.rules')).href);
            return (await validateRequiredFields(doc, token, names)).length;
        };

        it('does not flag the base another file really inherits from', async () => {
            expect(await validateBase(await buildWorkspace({ 'base.rules': BASE, 'derived.rules': DERIVED }))).toBe(0);
        });

        it('flags the same group when the other file inherits a same-named group elsewhere', async () => {
            // `Other/X` shares X's name but is a different node, so the group under test is no template.
            const elsewhere =
                'Other\n{\n\tX\n\t{\n\t\tType = MultiToggle\n\t\tMode = All\n\t}\n}\n' +
                component('Real : <other.rules>/Other/X', '');
            expect(await validateBase(await buildWorkspace({ 'base.rules': BASE, 'other.rules': elsewhere }))).toBe(1);
        });
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
