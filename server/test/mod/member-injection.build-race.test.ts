import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, GroupNode, isGroupNode, isListNode } from '../../src/core/ast/ast';
import { parseFilePath } from '../../src/utils/ast.utils';
import { clearModRootCache } from '../../src/mod/mod-root';
import { MemberInjectionIndex } from '../../src/mod/member-injection.index';
import { flattenGroup } from '../../src/semantics/effective-group';
import { globalSettings } from '../../src/settings';
import { FIXTURES_DIR } from '../helpers';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../workspace-helper';

const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'override-inherit-mod');

/** The effective member names of a container. */
const namesOf = async (node: GroupNode): Promise<string[]> =>
    (await flattenGroup(node, token)).members.map((member) => member.name);

/** The named top-level group of the parsed fixture. */
const groupOf = (document: { elements: AbstractNode[] }, name: string): GroupNode => {
    const found = document.elements.find((element) => isGroupNode(element) && element.identifier?.name === name);
    if (!found) throw new Error(`group ${name} not found`);
    return found as GroupNode;
};

// A request can reach the resolver before the manifests are indexed, and until then the injection
// index answers "nothing injected" for every node. Whatever was read in that window has to stop
// being served once the index can speak for the project, or a mod's own override stays invisible
// for the rest of the session and a refresh answers from the same reading.
describe('a value read before the manifests are indexed', () => {
    let target: GroupNode;
    let untouched: GroupNode;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        clearModRootCache();
        MemberInjectionIndex.instance.reset();
        const document = await parseFilePath(workspaceFile('action_targets.rules'));
        target = groupOf(document, 'Group');
        const entries = document.elements.find((element) => isListNode(element) && element.identifier?.name === 'Entries');
        untouched = (entries as unknown as { elements: AbstractNode[] }).elements[0] as GroupNode;
    });

    afterAll(() => {
        MemberInjectionIndex.instance.reset();
    });

    it('is read again once the index is built, rather than served from the empty window', async () => {
        expect(await namesOf(target)).toEqual(['Leaf']);
        await MemberInjectionIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, MOD_DIR], token);
        expect(await namesOf(target)).toContain('Inline');
    });

    it('leaves a node no action touches reading exactly what it writes', async () => {
        // The negative control: the drop above must not invent members anywhere else.
        expect(await namesOf(untouched)).toEqual(['A']);
    });
});
