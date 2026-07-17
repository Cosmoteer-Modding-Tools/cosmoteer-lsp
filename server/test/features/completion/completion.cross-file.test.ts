import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { ReferenceAutoCompletionStrategy } from '../../../src/features/completion/strategy/reference.autocompletion-strategy';
import { FullNavigationStrategy } from '../../../src/features/navigation/full.navigation-strategy';
import { AbstractNode, AbstractNodeDocument, ValueNode } from '../../../src/core/ast/ast';
import { findNodeByIdentifier, parseFilePath } from '../../../src/utils/ast.utils';
import { globalSettings } from '../../../src/settings';
import { findReferenceNode, parseFixture } from '../../helpers';
import { initWorkspace, valueOf, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';

// Characterization tests for cross-file and cross-reference autocompletion. They
// pin the current behavior of ReferenceAutoCompletionStrategy so a future fix is a
// deliberate, visible change. Several cases below are known-broken and documented
// as such. They return [] today where they should list the target's members.
const completion = new ReferenceAutoCompletionStrategy();
const navigation = new FullNavigationStrategy();
const token = CancellationToken.None;
const pos = { line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 };

/** A reference Value node typed at `value`, anchored under `parent` (drives getStartOfAstNode → uri). */
const refNode = (value: string, parent: AbstractNode): ValueNode => ({
    type: 'Value',
    valueType: { type: 'Reference', value },
    position: pos,
    parent: parent as unknown as AbstractNodeDocument,
});

const complete = (value: string, parent: AbstractNode, isInheritanceNode = false) =>
    completion.complete({ node: refNode(value, parent), isInheritanceNode, cancellationToken: token });

describe('ReferenceAutoCompletionStrategy, cross-file', () => {
    let docA: AbstractNodeDocument;
    let shipDoc: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        // <./Data/…> directory listings resolve against CosmoteerWorkspacePath, which
        // derives from this setting. Point it at the fixture workspace.
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        docA = await parseFilePath(workspaceFile('a.rules'));
        shipDoc = await parseFilePath(workspaceFile('ships', 'ship.rules'));
    });

    describe('working today', () => {
        it('<./Data/ lists the workspace Data directory (files as `name>`, dirs as `name/`)', async () => {
            const result = await complete('&<./Data/', docA);
            expect(result.sort()).toEqual(
                [
                    'a.rules>',
                    'action_targets.rules>',
                    'atlas_source.rules>',
                    'atlas_target.rules>',
                    'b.rules>',
                    'base.rules>',
                    'c.rules>',
                    'cosmoteer.rules>',
                    'embedded-ref.rules>',
                    'repeated-refs.rules>',
                    'whole_file_base.rules>',
                    'whole_file_consumer.rules>',
                    'effects/',
                    'indicators/',
                    'modes/',
                    'parts/',
                    'resources/',
                    'ships/',
                    'sounds/',
                    'strings/',
                ].sort()
            );
        });

        it('<../ lists the sibling directory via the real filesystem (own relative path)', async () => {
            // ship.rules lives in Data/ships, so `../` lists Data/.
            const result = await complete('&<../', shipDoc);
            expect(result).toContain('c.rules>');
            expect(result).toContain('ships/');
        });

        it('/… lists members of the workspace cosmoteer.rules root', async () => {
            const result = await complete('&/', docA);
            expect(result).toEqual(['StringsFolder', 'RootMarker', 'Palette', 'BASE_AUDIO', 'BASE_SHAKE', 'INDICATORS']);
        });

        it('/Palette/ drills into a nested group of cosmoteer.rules', async () => {
            const result = await complete('&/Palette/', docA);
            expect(result).toEqual(['Main']);
        });

        it('~/ lists members of the current document root', async () => {
            const result = await complete('&~/', docA);
            expect(result).toEqual(['A', 'AChild']);
        });
    });

    // Drilling into a referenced/cross-file target. These were all broken (returned [])
    // before the completion strategy was fixed. Navigation always resolved them.
    describe('drilling into a referenced target', () => {
        it('<./Data/a.rules>/ lists the target file root members', async () => {
            expect((await complete('&<./Data/a.rules>/', docA)).sort()).toEqual(['A', 'AChild'].sort());
        });

        it('<./Data/a.rules>/A/ lists members of A inside the target file', async () => {
            expect((await complete('&<./Data/a.rules>/A/', docA)).sort()).toEqual(
                ['Direct', 'ToB', 'ToC', 'ToNested', 'RefToB'].sort()
            );
        });

        it('<./Data/a.rules>/A/To partial-matches members of A by prefix', async () => {
            expect((await complete('&<./Data/a.rules>/A/To', docA)).sort()).toEqual(['ToB', 'ToC', 'ToNested'].sort());
        });

        it('<./data/a.rules>/A/ with a lowercase game-root prefix lists the same members', async () => {
            // Mods commonly write `&<./data/...>` and the game resolves it through the
            // case-insensitive Windows FS, so completion must match navigation here.
            expect((await complete('&<./data/a.rules>/A/', docA)).sort()).toEqual(
                ['Direct', 'ToB', 'ToC', 'ToNested', 'RefToB'].sort()
            );
        });

        it('<./data/ with a lowercase game-root prefix lists the workspace Data directory', async () => {
            const result = await complete('&<./data/', docA);
            expect(result).toContain('a.rules>');
            expect(result).toContain('ships/');
        });

        it('<./DATA/A.RULES>/A/ with arbitrary casing throughout still lists members of A', async () => {
            // Prefix, directory and extension casing all fold: the game resolves the whole path
            // through the case-insensitive Windows FS.
            expect((await complete('&<./DATA/A.RULES>/A/', docA)).sort()).toEqual(
                ['Direct', 'ToB', 'ToC', 'ToNested', 'RefToB'].sort()
            );
        });

        it('<../c.rules>/ lists members of c.rules via the own relative path', async () => {
            expect(await complete('&<../c.rules>/', shipDoc)).toEqual(['C']);
        });

        it('<./Data/../workshop/…/wm.rules>/ workshop escape lists the target file root members', async () => {
            expect((await complete('&<./Data/../workshop/wm/wm.rules>/', docA)).sort()).toEqual(['WM', 'WMList'].sort());
        });

        it('<./Data/../workshop/…/wm.rules>/WM/ drills into a member of the workshop file', async () => {
            expect((await complete('&<./Data/../workshop/wm/wm.rules>/WM/', docA)).sort()).toEqual(
                ['Alpha', 'Beta'].sort()
            );
        });

        it('<./Data/../workshop/wm/ lists the workshop directory contents', async () => {
            expect(await complete('&<./Data/../workshop/wm/', docA)).toEqual(['wm.rules>']);
        });

        it('&RefToB/ drills through A.RefToB into group B and lists its members', async () => {
            const aObj = findNodeByIdentifier(docA, 'A')!;
            expect((await complete('&RefToB/', aObj)).sort()).toEqual(['InnerValue', 'ToC', 'Nested'].sort());
        });
    });
});

describe('ReferenceAutoCompletionStrategy & FullNavigationStrategy, in-file reference-to-reference', () => {
    // The user's case:
    //   TestBase { TestValue = 1 }
    //   Test1 = &TestBase
    //   Test2 = &Test1/TestValue
    let doc: AbstractNodeDocument;

    beforeAll(() => {
        doc = parseFixture('ref-chain.rules', 'file:///ref-chain.rules');
    });

    it('navigation resolves a direct group ref + member (&TestBase/TestValue) to 1', async () => {
        const node = findReferenceNode(doc, '&Test1/TestValue');
        const result = await navigation.navigate('&TestBase/TestValue', node, doc.uri, token);
        expect(valueOf(result)).toBe(1);
    });

    it('navigation follows an alias (&Test1, where Test1 = &TestBase) to the TestBase group', async () => {
        const node = findReferenceNode(doc, '&Test1/TestValue');
        const result = await navigation.navigate('&Test1', node, doc.uri, token);
        expect(result && 'identifier' in result && (result as { identifier?: { name: string } }).identifier?.name).toBe(
            'TestBase'
        );
    });

    it('navigation drills through the alias chain (&Test1/TestValue) to TestValue = 1', async () => {
        // The user's case: Test1 = &TestBase, Test2 = &Test1/TestValue. Previously null.
        const node = findReferenceNode(doc, '&Test1/TestValue');
        const result = await navigation.navigate('&Test1/TestValue', node, doc.uri, token);
        expect(valueOf(result)).toBe(1);
    });

    it('navigation of a self-referential alias cycle terminates (returns null, no infinite loop)', async () => {
        const cyclic = parseFixture('ref-cycle.rules', 'file:///ref-cycle.rules');
        const node = findReferenceNode(cyclic, '&A/x');
        const result = await navigation.navigate('&A/x', node, cyclic.uri, token);
        expect(result).toBeNull();
    });

    it('completion at parent level offers the alias names (Test1, Test2)', async () => {
        const result = await complete('&Test', doc);
        expect(result).toEqual(expect.arrayContaining(['Test1', 'Test2']));
    });

    it('completion drills through the alias: &Test1/ lists the aliased members (TestValue)', async () => {
        expect(await complete('&Test1/', doc)).toEqual(['TestValue']);
    });
});
