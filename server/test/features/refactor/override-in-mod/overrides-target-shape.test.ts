import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../../src/core/lexer/lexer';
import { parser } from '../../../../src/core/parser/parser';
import { validateModActions } from '../../../../src/features/diagnostics/validator.mod-action';
import { parseModActions } from '../../../../src/mod/action-parser';
import { invalidateModContext } from '../../../../src/mod/mod-context';
import { clearModRootCache } from '../../../../src/mod/mod-root';
import { globalSettings } from '../../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../../workspace-helper';

// The adjacent check the override generator relies on. `ModOverridesAction.ApplyAction` resolves the
// target and then throws "must be a {} group node or file" on anything that is not an OTGroupNode, so
// an Overrides pointed at a list or a plain value costs the user the whole mod at load time. Until
// this shape was declared, the editor said nothing about it.
const NON_MOD_URI = 'file:///c%3A/no-mod-here/mod.rules';

const overrides = (target: string, source = 'Overrides\n\t\t{\n\t\t\tLeaf = 2\n\t\t}'): string =>
    `Actions\n[\n\t{\n\t\tAction = Overrides\n\t\tOverrideIn = "${target}"\n\t\t${source}\n\t}\n]\n`;

const validate = async (src: string) =>
    validateModActions(parseModActions(parser(lexer(src), NON_MOD_URI).value), CancellationToken.None);

beforeAll(async () => {
    await initWorkspace();
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    clearModRootCache();
    invalidateModContext();
});

describe('the shape an Overrides target must have', () => {
    it('accepts a group', async () => {
        expect(await validate(overrides('<action_targets.rules>/Group'))).toEqual([]);
    });

    it('accepts a whole file, whose top level is a group in the game own tree', async () => {
        expect(await validate(overrides('<action_targets.rules>'))).toEqual([]);
    });

    it('accepts a member that is itself a whole-file reference', async () => {
        // `BASE_AUDIO = &<sounds/base_audio.rules>` resolves to the file it names, and a file is a
        // group in the game's own tree, so overriding into it is what the game does.
        expect(await validate(overrides('<cosmoteer.rules>/BASE_AUDIO'))).toEqual([]);
    });

    it('reports a list, which the game refuses to override', async () => {
        const errors = await validate(overrides('<action_targets.rules>/List'));
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action target has the wrong shape');
        expect(errors[0].additionalInfo).toContain('a group "{ }"');
    });

    it('reports a plain value, which the game refuses to override', async () => {
        const errors = await validate(overrides('<action_targets.rules>/Value'));
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action target has the wrong shape');
    });
});
