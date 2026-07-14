import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { parseModActions } from '../../src/mod/action-parser';
import { normalizeTargetPath, resolveActionTarget } from '../../src/mod/action-target-resolver';
import { ValueNode } from '../../src/core/ast/ast';
import { globalSettings } from '../../src/settings';
import { initWorkspace, valueOf, WORKSPACE_DATA_DIR } from '../workspace-helper';

const token = CancellationToken.None;

/** Parse a mod.rules whose single action has the given target field, return that target node. */
const targetOf = (field: string, path: string): ValueNode => {
    const src = `Actions\n[\n\t{\n\t\tAction = Replace\n\t\t${field} = "${path}"\n\t\tWith = 1\n\t}\n]\n`;
    const actions = parseModActions(parser(lexer(src), 'file:///mod/mod.rules').value);
    return actions[0].targets[0];
};

describe('normalizeTargetPath', () => {
    it('rewrites bare `<file>` targets to the game-root `<./Data/file>` form', () => {
        expect(normalizeTargetPath('<a.rules>/A')).toBe('<./Data/a.rules>/A');
        expect(normalizeTargetPath('<cosmoteer.rules>')).toBe('<./Data/cosmoteer.rules>');
    });

    it('canonicalizes the `./data` casing (the branch in navigateRules is case-sensitive)', () => {
        expect(normalizeTargetPath('<./data/gui/build_gui.rules>/X')).toBe('<./Data/gui/build_gui.rules>/X');
        expect(normalizeTargetPath('<./Data/buffs/buffs.rules>')).toBe('<./Data/buffs/buffs.rules>');
    });

    it('keeps workshop escapes intact', () => {
        expect(normalizeTargetPath('<./Data/../../../workshop/content/1/2/foo.rules>/F')).toBe(
            '<./Data/../../../workshop/content/1/2/foo.rules>/F'
        );
    });

    it('resolves a `./` path that does not name Data against the install root (the game CWD)', () => {
        expect(normalizeTargetPath('<./Bin/x.rules>/A')).toBe('<./Data/../Bin/x.rules>/A');
    });

    it('accepts a `&`-prefixed target string (legal for the game, same resolution)', () => {
        expect(normalizeTargetPath('&<a.rules>/A')).toBe('<./Data/a.rules>/A');
        expect(normalizeTargetPath('&<./data/gui/x.rules>')).toBe('<./Data/gui/x.rules>');
    });
});

describe('resolveActionTarget (game root)', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('resolves a bare `<file>` target against the game tree (not mod-relative)', async () => {
        const result = await resolveActionTarget(targetOf('Replace', '<a.rules>/A/Direct'), token);
        expect(valueOf(result)).toBe(1);
    });

    it('resolves the explicit `<./Data/file>` form to the same node', async () => {
        const result = await resolveActionTarget(targetOf('Replace', '<./Data/a.rules>/A/Direct'), token);
        expect(valueOf(result)).toBe(1);
    });

    it('resolves a target with numeric list indices', async () => {
        const result = await resolveActionTarget(
            targetOf('Replace', '<modes/career/career.rules>/EconDifficultyLevels/1/StartingMoney'),
            token
        );
        expect(valueOf(result)).toBe(150000);
    });

    it('returns null for a target that does not exist in the game tree', async () => {
        const result = await resolveActionTarget(targetOf('Replace', '<a.rules>/A/Nope'), token);
        expect(result).toBeNull();
    });
});
