import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { FullNavigationStrategy } from '../../../src/features/navigation/full.navigation-strategy';
import { AbstractNode } from '../../../src/core/ast/ast';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';

const nav = new FullNavigationStrategy();
const token = CancellationToken.None;

// A node "inside a mod" whose ./data reference points into the merged game tree (NOT the mod dir).
const refNode = (ref: string): AbstractNode =>
    (parser(lexer(`X = ${ref}\n`), 'file:///c%3A/mod/sub/file.rules').value.elements[0] as unknown as { right: AbstractNode }).right;

// `&<./Data/...>` addresses the merged game `Data` tree. Mods write it lowercase (`./data/...`)
// too; the resolver used to match only the capital `Data`, so a mod referencing vanilla via a
// lowercase `&<./data/.../foo.rules>` fell through to mod-relative resolution and was wrongly flagged.
describe('case-insensitive ./Data overlay references resolve into the game tree', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('resolves a LOWERCASE `&<./data/a.rules>` into the game Data tree', async () => {
        const result = await nav.navigate('&<./data/a.rules>', refNode('&<./data/a.rules>'), 'file:///c%3A/mod/sub/file.rules', token);
        expect(result).not.toBeNull();
    });

    it('still resolves the capital `&<./Data/a.rules>` (regression)', async () => {
        const result = await nav.navigate('&<./Data/a.rules>', refNode('&<./Data/a.rules>'), 'file:///c%3A/mod/sub/file.rules', token);
        expect(result).not.toBeNull();
    });
});
