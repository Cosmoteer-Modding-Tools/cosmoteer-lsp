import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { FullNavigationStrategy } from '../../../src/features/navigation/full.navigation-strategy';
import { ValueNode } from '../../../src/core/ast/ast';
import { isValidReference } from '../../../src/utils/reference.utils';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';

const nav = new FullNavigationStrategy();
const token = CancellationToken.None;

// A referencing file that lives at the workspace Data root, so `<effects/assets.rules>` resolves
// relative to it. Forward slashes + a `.rules` suffix → filePathToDirectoryPath yields the Data dir.
const currentLocation = WORKSPACE_DATA_DIR.replace(/\\/g, '/') + '/somefile.rules';

// Parse `X = <ref>` through the REAL lexer+parser and return the reference value node. Going through
// the lexer is the point: the bug was the lexer treating `\` as whitespace and SPLITTING the path.
const refNode = (ref: string): ValueNode =>
    (parser(lexer(`X = ${ref}\n`), currentLocation).value.elements[0] as { right: ValueNode }).right;

// ObjectText `<...>` file paths accept a Windows backslash separator (`<hit_effects\foo.rules>`):
// `\` is not an invalid path char, so the game's PATH_RE accepts it and .NET resolves it on Windows.
// Two layers had to cooperate: the LEXER must keep `\` inside `<...>` (it is whitespace elsewhere, so
// it used to split `&<effects\assets.rules>` into `&<effects` + `assets.rules>`), and navigateRules
// must normalize `\`→`/` for the directory walk.
describe('backslash-separated `<...>` file references resolve like forward-slash ones', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('the lexer keeps `\\` inside `<...>` as one reference value (not split, and a valid reference)', () => {
        const node = refNode('&<effects\\assets.rules>');
        expect(node.valueType.type).toBe('Reference');
        expect(node.valueType.value).toBe('&<effects\\assets.rules>');
        expect(isValidReference(String(node.valueType.value))).toBe(true);
    });

    it('resolves a BACKSLASH reference `&<effects\\assets.rules>` (through the parsed value)', async () => {
        const node = refNode('&<effects\\assets.rules>');
        const result = await nav.navigate(String(node.valueType.value), node, currentLocation, token);
        expect(result).not.toBeNull();
    });

    it('still resolves the forward-slash form `&<effects/assets.rules>` (regression)', async () => {
        const node = refNode('&<effects/assets.rules>');
        const result = await nav.navigate(String(node.valueType.value), node, currentLocation, token);
        expect(result).not.toBeNull();
    });

    it('still returns null for a backslash path to a NON-existent file (genuine bad ref)', async () => {
        const node = refNode('&<effects\\does_not_exist.rules>');
        const result = await nav.navigate(String(node.valueType.value), node, currentLocation, token);
        expect(result).toBeNull();
    });
});
