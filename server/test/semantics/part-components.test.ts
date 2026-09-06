import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { GroupNode, isGroupNode } from '../../src/core/ast/ast';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { componentsOfPart, proxyTargetsOf, targetsAnotherPart } from '../../src/semantics/part-components';
import { globalSettings } from '../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../workspace-helper';

const token = CancellationToken.None;

// Which part a component's ids belong to is one rule with three signals, and four features have to
// agree about it: the sibling check reports an id it cannot find, both component completions offer
// this part's ids for it, and the drawn views point an arrow at it. They read one implementation, so
// the union of what each of them used to know separately is pinned here.
const PART = [
    'Part',
    '{',
    '\tID = t.proxies',
    '\tComponents',
    '\t{',
    '\t\tStore',
    '\t\t{',
    '\t\t\tType = ResourceStorage',
    '\t\t\tResourceType = heat',
    '\t\t}',
    '\t\tNear',
    '\t\t{',
    '\t\t\tType = ResourceStorageProxy',
    '\t\t\tComponentID = Store',
    '\t\t}',
    '\t\tAtACell',
    '\t\t{',
    '\t\t\tType = ResourceStorageProxy',
    '\t\t\tPartLocation = [0, 1]',
    '\t\t\tComponentID = Store',
    '\t\t}',
    '\t\tByCriteria',
    '\t\t{',
    '\t\t\tType = ResourceStorageProxy',
    '\t\t\tPartCriteria',
    '\t\t\t{',
    '\t\t\t\tCategory = anything',
    '\t\t\t}',
    '\t\t\tComponentID = Store',
    '\t\t}',
    '\t\tChained',
    '\t\t{',
    '\t\t\tType = ChainableProxy',
    '\t\t\tComponentID = Store',
    '\t\t}',
    '\t\tNarrowed : AtACell',
    '\t\t{',
    '\t\t\tComponentID = Store',
    '\t\t}',
    '\t}',
    '}',
    '',
].join('\n');

const componentNamed = async (name: string): Promise<GroupNode> => {
    const document = parser(lexer(PART), 'file:///proxies.rules').value;
    const part = document.elements.find(isGroupNode);
    if (!part) throw new Error('no part in the test source');
    const found = (await componentsOfPart(part, token)).find((entry) => entry.name === name);
    if (!found) throw new Error(`no component named ${name}`);
    return found.group;
};

describe('which part a component resolves its ids against', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('reads a proxy that names no other part as naming a sibling', async () => {
        expect(targetsAnotherPart(await componentNamed('Near'))).toBe(false);
    });

    it('reads a cell, a criteria and a chained proxy as naming another part', async () => {
        // The engine has exactly these three signals. `ChainableProxy` resolves against whichever
        // part is chained to this one, and carries neither of the other two.
        expect(targetsAnotherPart(await componentNamed('AtACell'))).toBe(true);
        expect(targetsAnotherPart(await componentNamed('ByCriteria'))).toBe(true);
        expect(targetsAnotherPart(await componentNamed('Chained'))).toBe(true);
    });

    it('follows a proxy to the sibling it names', async () => {
        const targets = await proxyTargetsOf(await componentNamed('Near'), token);
        expect(targets).toHaveLength(1);
        expect(targets[0].otherPart).toBe(false);
    });

    it('keeps a location the proxy takes from the base it narrows', async () => {
        // `Narrowed : AtACell` overwrites the id and keeps the location, so its target is on the
        // other part as much as its base's is. Reading only what is written locally loses that.
        const targets = await proxyTargetsOf(await componentNamed('Narrowed'), token);
        expect(targets).toHaveLength(1);
        expect(targets[0].otherPart).toBe(true);
    });
});
