import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { parseModActions } from '../../src/mod/action-parser';
import { validateModActions } from '../../src/features/diagnostics/validator.mod-action';
import { clearModRootCache } from '../../src/mod/mod-root';
import { invalidateModContext } from '../../src/mod/mod-context';
import { globalSettings } from '../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../workspace-helper';

const token = CancellationToken.None;
const NON_MOD_URI = 'file:///c%3A/no-mod-here/mod.rules';

const validate = async (src: string) => validateModActions(parseModActions(parser(lexer(src), NON_MOD_URI).value), token);
const action = (verb: string, body: string) => `Actions\n[\n\t{\n\t\tAction = ${verb}\n${body}\n\t}\n]\n`;
const detailFor = (errors: Awaited<ReturnType<typeof validate>>, message: string) =>
    errors.find((e) => e.message === message)?.additionalInfo;

beforeAll(async () => {
    await initWorkspace();
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    clearModRootCache();
    invalidateModContext();
});

describe('mod action diagnostics — explanatory detail lines', () => {
    it('lists every valid verb when the verb is unknown', async () => {
        const errors = await validate(action('Frobnicate', '\t\tFoo = 1'));
        expect(detailFor(errors, 'Unknown mod action verb')).toBe(
            'Valid verbs are: Add, AddMany, Overrides, Replace, Remove, RemoveMany, AddBase'
        );
    });

    it('names the action and the missing field', async () => {
        const errors = await validate(action('Replace', '\t\tReplace = "<a.rules>/A/Direct"'));
        expect(detailFor(errors, 'Mod action is missing a required field')).toBe(
            'The "Replace" action requires the field "With"'
        );
    });

    it('names the action, the field, and the required shape', async () => {
        const errors = await validate(
            action('Overrides', '\t\tOverrideIn = "<a.rules>/A"\n\t\tIgnoreIfNotExisting = true\n\t\tOverrides = 5')
        );
        expect(detailFor(errors, 'Mod action source has the wrong shape')).toBe(
            'The "Overrides" action requires its "Overrides" to be a group "{ }"'
        );
    });

    it('explains where the target was looked for', async () => {
        const errors = await validate(action('Replace', '\t\tReplace = "<a.rules>/A/Nope"\n\t\tWith = 1'));
        expect(detailFor(errors, 'Action target not found')).toBe(
            'The target of this action could not be found in the game data (or in what this mod adds)'
        );
    });
});
