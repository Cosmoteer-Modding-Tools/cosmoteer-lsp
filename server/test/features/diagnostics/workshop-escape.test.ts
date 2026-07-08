import { join, relative } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { ValidationForValue } from '../../../src/features/diagnostics/validator.value';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { FIXTURES_DIR, findReferenceNode } from '../../helpers';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';

const token = CancellationToken.None;

const MOD_DIR = join(FIXTURES_DIR, 'workshop', 'content', '799600', '111').replace(/\\/g, '/');
const TARGET_LIB = join(FIXTURES_DIR, 'workshop', 'content', '799600', '222', 'lib.rules');
const SOURCE_URI = `${MOD_DIR}/weapon.rules`;

/** The fixture-layout equivalent of `../../../workshop/...`, computed from the real directories. */
const relFromData = relative(WORKSPACE_DATA_DIR, TARGET_LIB).replace(/\\/g, '/');

const validate = (reference: string) => {
    const source = `Weapon\n{\n\tDamage = ${reference}\n}\n`;
    const doc = parser(lexer(source), SOURCE_URI).value;
    return ValidationForValue.callback(findReferenceNode(doc, reference), token);
};

describe('workshop escape recommendation', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('recommends the game-root form for a resolving relative reference into another workshop mod', async () => {
        const error = await validate('&<../222/lib.rules>/Shared');
        expect(error?.message).toBe('Fragile relative path into the workshop folder');
        expect(error?.severity).toBe('information');
        expect(error?.data?.quickFix?.newText).toBe(`&<./Data/${relFromData}>/Shared`);
    });

    it('offers the game-root rewrite when a workshop path is written from the wrong depth', async () => {
        const error = await validate('&<../../../../../workshop/content/799600/222/lib.rules>/Shared');
        expect(error?.message).toBe('Reference name is not known');
        expect(error?.severity).toBe('warning');
        expect(error?.data?.quickFix?.newText).toBe(`&<./Data/${relFromData}>/Shared`);
    });

    it('leaves a relative reference inside the same mod alone', async () => {
        expect(await validate('&<../111/local.rules>/LocalShared')).toBeUndefined();
    });

    it('leaves the game-root form itself alone', async () => {
        expect(await validate(`&<./Data/${relFromData}>/Shared`)).toBeUndefined();
    });

    it('leaves an action target in a non-manifest file alone', async () => {
        const reference = '<../../../workshop/content/799600/222/lib.rules>/Shared';
        const source = `Actions\n[\n\t{\n\t\tAction = Overrides\n\t\tOverrideIn = "${reference}"\n\t\tOverrides { }\n\t}\n]\n`;
        const doc = parser(lexer(source), SOURCE_URI).value;
        expect(await ValidationForValue.callback(findReferenceNode(doc, reference), token)).toBeUndefined();
    });
});
