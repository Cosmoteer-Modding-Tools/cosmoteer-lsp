import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, isGroupNode } from '../../src/core/ast/ast';
import { parseFilePath } from '../../src/utils/ast.utils';
import { clearModRootCache } from '../../src/mod/mod-root';
import { MemberInjectionIndex } from '../../src/mod/member-injection.index';
import { globalSettings } from '../../src/settings';
import { FIXTURES_DIR } from '../helpers';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../workspace-helper';

const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'override-inherit-mod');

// A mod adds a few entries to a table by writing them beside a file of its own:
// `Overrides : &<shared.rules> { Inline = 2 }`. The game merges the base into the group before it
// reads the pairs, so the target ends up carrying both halves and neither may go missing.
describe('an Overrides source that inherits from a file of the mod', () => {
    let group: AbstractNode | undefined;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        clearModRootCache();
        MemberInjectionIndex.instance.reset();
        await MemberInjectionIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, MOD_DIR], token);
        const document = await parseFilePath(workspaceFile('action_targets.rules'));
        group = document.elements.find((element) => isGroupNode(element) && element.identifier?.name === 'Group');
    });

    afterAll(() => {
        MemberInjectionIndex.instance.reset();
    });

    it('merges the members written inline', () => {
        expect(group && MemberInjectionIndex.instance.injectedMemberNames(group)).toContain('Inline');
    });

    it('merges the members the base supplies as well', () => {
        const names = group ? MemberInjectionIndex.instance.injectedMemberNames(group) : [];
        expect(names).toContain('FromBase');
        expect(names).toContain('AlsoFromBase');
    });
});
