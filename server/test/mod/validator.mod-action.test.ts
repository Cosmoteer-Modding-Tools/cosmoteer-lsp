import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { parseModActions } from '../../src/mod/action-parser';
import { validateModActions } from '../../src/features/diagnostics/validator.mod-action';
import { clearModRootCache } from '../../src/mod/mod-root';
import { invalidateModContext } from '../../src/mod/mod-context';
import { parseFilePath } from '../../src/utils/ast.utils';
import { globalSettings } from '../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../workspace-helper';
import { FIXTURES_DIR } from '../helpers';

const token = CancellationToken.None;
// A uri with no ancestor manifest, so resolution is vanilla-only (no mod additions).
const NON_MOD_URI = 'file:///c%3A/no-mod-here/mod.rules';

const validate = async (src: string, uri = NON_MOD_URI) =>
    validateModActions(parseModActions(parser(lexer(src), uri).value), token);

const action = (verb: string, body: string) => `Actions\n[\n\t{\n\t\tAction = ${verb}\n${body}\n\t}\n]\n`;

beforeAll(async () => {
    await initWorkspace();
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    clearModRootCache();
    invalidateModContext();
});

describe('validateModActions', () => {
    it('does not flag a Replace whose target resolves in the game tree', async () => {
        const errors = await validate(action('Replace', '\t\tReplace = "<a.rules>/A/Direct"\n\t\tWith = 1'));
        expect(errors).toEqual([]);
    });

    it('flags a target that does not exist (no Ignore/Create flag)', async () => {
        const errors = await validate(action('Replace', '\t\tReplace = "<a.rules>/A/Nope"\n\t\tWith = 1'));
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Action target not found');
    });

    it('does not flag a missing target when IgnoreIfNotExisting is set', async () => {
        const errors = await validate(
            action('Replace', '\t\tReplace = "<a.rules>/A/Nope"\n\t\tWith = 1\n\t\tIgnoreIfNotExisting = true')
        );
        expect(errors).toEqual([]);
    });

    it('does not flag a missing target when CreateIfNotExisting is set', async () => {
        const errors = await validate(
            action('Add', '\t\tAddTo = "<a.rules>/A/Nope"\n\t\tToAdd = 1\n\t\tCreateIfNotExisting = true')
        );
        expect(errors).toEqual([]);
    });

    it('flags an unknown verb', async () => {
        const errors = await validate(action('Frobnicate', '\t\tFoo = 1'));
        expect(errors.some((e) => e.message === 'Unknown mod action verb')).toBe(true);
    });

    it('flags a missing required field (Replace without With)', async () => {
        const errors = await validate(action('Replace', '\t\tReplace = "<a.rules>/A/Direct"'));
        expect(errors.some((e) => e.message === 'Mod action is missing a required field')).toBe(true);
    });

    it('flags exactly the bad element of a RemoveMany (one good, one bad)', async () => {
        const src =
            'Actions\n[\n\t{\n\t\tAction = RemoveMany\n\t\tRemoveMany\n\t\t[\n\t\t\t"<a.rules>/A/Direct"\n\t\t\t"<a.rules>/A/Nope"\n\t\t]\n\t}\n]\n';
        const errors = await validate(src);
        expect(errors).toHaveLength(1);
        expect(String((errors[0].node as unknown as { valueType: { value: unknown } }).valueType.value)).toBe('<a.rules>/A/Nope');
    });

    it('does not flag Overrides whose source is a group', async () => {
        const errors = await validate(
            action('Overrides', '\t\tOverrideIn = "<a.rules>/A"\n\t\tIgnoreIfNotExisting = true\n\t\tOverrides\n\t\t{\n\t\t\tDirect = 2\n\t\t}')
        );
        expect(errors).toEqual([]);
    });

    it('flags Overrides whose source is a plain value (must be a group)', async () => {
        const errors = await validate(
            action('Overrides', '\t\tOverrideIn = "<a.rules>/A"\n\t\tIgnoreIfNotExisting = true\n\t\tOverrides = 5')
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action source has the wrong shape');
    });

    it('flags AddMany whose source is not a list', async () => {
        const errors = await validate(
            action('AddMany', '\t\tAddTo = "<a.rules>/A"\n\t\tIgnoreIfNotExisting = true\n\t\tManyToAdd = 1')
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action source has the wrong shape');
    });

    it('does not flag AddMany whose source is a list', async () => {
        const errors = await validate(
            action('AddMany', '\t\tAddTo = "<a.rules>/A"\n\t\tIgnoreIfNotExisting = true\n\t\tManyToAdd\n\t\t[\n\t\t\t1\n\t\t\t2\n\t\t]')
        );
        expect(errors).toEqual([]);
    });

    it('flags AddBase whose source is a plain value (needs a reference/group/list)', async () => {
        const errors = await validate(
            action('AddBase', '\t\tAddBaseTo = "<a.rules>/A"\n\t\tIgnoreIfNotExisting = true\n\t\tBaseToAdd = 5')
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action source has the wrong shape');
    });

    it('does not flag AddBase whose source is a reference', async () => {
        const errors = await validate(
            action('AddBase', '\t\tAddBaseTo = "<a.rules>/A"\n\t\tIgnoreIfNotExisting = true\n\t\tBaseToAdd = &<./Data/a.rules>/A')
        );
        expect(errors).toEqual([]);
    });

    it('flags Replace targeting a whole .rules file', async () => {
        const errors = await validate(action('Replace', '\t\tReplace = "<a.rules>"\n\t\tWith = 1'));
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action cannot target a whole .rules file');
    });

    it('flags Remove targeting a whole .rules file', async () => {
        const errors = await validate(action('Remove', '\t\tRemove = "<a.rules>"'));
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action cannot target a whole .rules file');
    });

    it('does not flag Overrides targeting a whole .rules file via a string path (its top level is a group)', async () => {
        const errors = await validate(
            action('Overrides', '\t\tOverrideIn = "<a.rules>"\n\t\tOverrides\n\t\t{\n\t\t\tDirect = 2\n\t\t}')
        );
        expect(errors).toEqual([]);
    });

    it('does not flag Overrides targeting a whole .rules file via a "&" reference', async () => {
        const errors = await validate(
            action('Overrides', '\t\tOverrideIn = &<a.rules>\n\t\tOverrides\n\t\t{\n\t\t\tDirect = 2\n\t\t}')
        );
        expect(errors).toEqual([]);
    });

    it('still flags Replace targeting a whole .rules file via a "&" reference', async () => {
        const errors = await validate(action('Replace', '\t\tReplace = &<a.rules>\n\t\tWith = 1'));
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action cannot target a whole .rules file');
    });

    it('flags Add to a whole .rules file with no Name', async () => {
        const errors = await validate(action('Add', '\t\tAddTo = "<a.rules>"\n\t\tToAdd = 1'));
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Add action is missing the Name field');
    });

    it('does not flag Add to a whole .rules file when Name is present', async () => {
        const errors = await validate(action('Add', '\t\tAddTo = "<a.rules>"\n\t\tName = NewThing\n\t\tToAdd = 1'));
        expect(errors).toEqual([]);
    });

    it('flags Add into a group node with no Name', async () => {
        const errors = await validate(action('Add', '\t\tAddTo = "<a.rules>/A"\n\t\tToAdd = 1'));
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Add action is missing the Name field');
    });

    it('does not require Name when Add targets a leaf value node', async () => {
        const errors = await validate(action('Add', '\t\tAddTo = "<a.rules>/A/Direct"\n\t\tToAdd = 1'));
        expect(errors).toEqual([]);
    });

    it('does not flag AddMany whose target is a list node', async () => {
        const errors = await validate(
            action('AddMany', '\t\tAddTo = "<action_targets.rules>/List"\n\t\tManyToAdd\n\t\t[\n\t\t\t3\n\t\t]')
        );
        expect(errors).toEqual([]);
    });

    it('flags AddMany whose target is a group node (must be a list)', async () => {
        const errors = await validate(
            action('AddMany', '\t\tAddTo = "<action_targets.rules>/Group"\n\t\tManyToAdd\n\t\t[\n\t\t\t3\n\t\t]')
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action target has the wrong shape');
    });

    it('flags AddMany whose target is a leaf value', async () => {
        const errors = await validate(
            action('AddMany', '\t\tAddTo = "<action_targets.rules>/Value"\n\t\tManyToAdd\n\t\t[\n\t\t\t3\n\t\t]')
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action target has the wrong shape');
    });

    it('does not flag AddBase whose target is a group node', async () => {
        const errors = await validate(
            action('AddBase', '\t\tAddBaseTo = "<action_targets.rules>/Group"\n\t\tBaseToAdd = &<./Data/a.rules>/A')
        );
        expect(errors).toEqual([]);
    });

    it('does not flag AddBase whose target is a list node', async () => {
        const errors = await validate(
            action('AddBase', '\t\tAddBaseTo = "<action_targets.rules>/List"\n\t\tBaseToAdd = &<./Data/a.rules>/A')
        );
        expect(errors).toEqual([]);
    });

    it('flags AddBase whose target is a leaf value (needs a list or group)', async () => {
        const errors = await validate(
            action('AddBase', '\t\tAddBaseTo = "<action_targets.rules>/Value"\n\t\tBaseToAdd = &<./Data/a.rules>/A')
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action target has the wrong shape');
    });

    it('flags an action targeting a node inside a language string file (under StringsFolder)', async () => {
        const errors = await validate(action('Replace', '\t\tReplace = "<strings/en.rules>/Greeting"\n\t\tWith = "Hi"'));
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action cannot target a language string file');
    });

    it('flags an action targeting a whole language string file, even for Overrides', async () => {
        const errors = await validate(
            action('Overrides', '\t\tOverrideIn = "<strings/en.rules>"\n\t\tOverrides\n\t\t{\n\t\t\tGreeting = "Hi"\n\t\t}')
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action cannot target a language string file');
    });

    it('does not flag an action targeting a normal (non-string) file', async () => {
        const errors = await validate(action('Replace', '\t\tReplace = "<a.rules>/A/Direct"\n\t\tWith = 1'));
        expect(errors).toEqual([]);
    });

    it('does not flag a target the mod itself adds (Overrides <cosmoteer.rules>/FOO after Add FOO)', async () => {
        // The fixture mod adds FOO to cosmoteer.rules then overrides it: the self-aware case.
        clearModRootCache();
        invalidateModContext();
        const manifest = await parseFilePath(join(FIXTURES_DIR, 'mod', 'mod.rules'));
        const errors = await validateModActions(parseModActions(manifest), token);
        expect(errors).toEqual([]);
    });
});
