import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { FullNavigationStrategy } from '../../src/features/navigation/full.navigation-strategy';
import { ValidationForValue } from '../../src/features/diagnostics/validator.value';
import { AbstractNode, isGroupNode, isListNode, ValueNode } from '../../src/core/ast/ast';
import { parseFilePath, findNodeByIdentifier } from '../../src/utils/ast.utils';
import { globalSettings } from '../../src/settings';
import { initWorkspace, valueOf, workspaceFile, WORKSPACE_DATA_DIR } from '../workspace-helper';

// Whole-file inheritance (`Comp : <base.rules>`, no `/member` suffix) inherits the base file's
// ROOT-level members. Reference resolution used to skip a base that resolved to a File/Document, so
// every `&<file>`-inherited member was reported as an unknown reference. And the extend-own-member
// tolerance (`X : <file>/X` where X is absent) only accepted group/list bases, flagging the vanilla
// terran.rules `Fire : <../base_ship.rules>/Fire`. Both are covered here.
const token = CancellationToken.None;
const nav = new FullNavigationStrategy();

const inhOf = (n: AbstractNode) => (n as unknown as { inheritance: ValueNode[] }).inheritance[0];

describe('whole-file inheritance', () => {
    let consumer: Awaited<ReturnType<typeof parseFilePath>>;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        consumer = await parseFilePath(workspaceFile('whole_file_consumer.rules'));
    });

    it('resolves a root-level base member through `Comp : <base.rules>` whole-file inheritance', async () => {
        const comp = findNodeByIdentifier(consumer, 'WFComp')! as AbstractNode & { elements: AbstractNode[] };
        // `&WFRootLeaf` from inside WFComp must reach WFRootLeaf at the base FILE root (value 42).
        const usesRoot = comp.elements.find(
            (e) => e.type === 'Assignment' && (e as unknown as { left: { name: string } }).left.name === 'UsesRoot'
        )! as unknown as { right: AbstractNode };
        const result = await nav.navigate('&WFRootLeaf', usesRoot.right, consumer.uri, token);
        expect(valueOf(result)).toBe(42);
    });

    it('does not flag a cross-file extend of a member the base file DOES define', async () => {
        const present = findNodeByIdentifier(consumer, 'WFExtendPresent')!;
        expect(await ValidationForValue.callback(inhOf(present), token)).toBeUndefined();
    });

    it('does not flag a cross-file extend of a member ABSENT on the whole-file base (`X : <file>/X`)', async () => {
        // The base prefix `<file>` resolves to the base Document; the missing member is tolerated,
        // mirroring vanilla terran.rules `Fire : <../base_ship.rules>/Fire`.
        const absent = findNodeByIdentifier(consumer, 'WFExtendAbsent')!;
        expect(isGroupNode(absent) || isListNode(absent)).toBe(true);
        expect(await ValidationForValue.callback(inhOf(absent), token)).toBeUndefined();
    });
});
