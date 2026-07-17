import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { FullNavigationStrategy } from '../../../src/features/navigation/full.navigation-strategy';
import { AbstractNode, AbstractNodeDocument } from '../../../src/core/ast/ast';
import { findNodeByIdentifier, parseFilePath } from '../../../src/utils/ast.utils';
import { initWorkspace, valueOf, workspaceFile } from '../../workspace-helper';

// Cross-file reference navigation. Unlike navigation.in-file.test.ts (which never
// leaves a single AST), these tests drive FullNavigationStrategy through the real
// workspace service against on-disk fixtures, covering every multi-file chain:
//
//   file -> in-file              <./Data/a.rules>/A/Direct
//   file -> file                 ...A/ToB          -> b.rules B/InnerValue
//   file -> file -> file         ...A/ToC          -> b.rules -> c.rules
//   file -> file -> in-file^2    ...A/ToNested     -> b.rules B/Nested/Deep/Leaf
//   in-file -> in-file           (single doc, multi-segment)
//   file -> inheritance          ...AChild/BaseOnly       (cross-file inherit)
//   file -> inheritance -> file  ...AChild/BaseToC -> c.rules
//   relative ../ file path       <../c.rules>/... from a subdir (real readdir)
//   super-path /...              resolved via cosmoteer.rules
//
// NOTE: the cross-file grammar is `<file.rules>/path`. The slash after `>` is
// required. `<file.rules>path` lexes `file.rules>path` as a single segment.
const nav = new FullNavigationStrategy();
const token = CancellationToken.None;

let docA: AbstractNodeDocument;

beforeAll(async () => {
    await initWorkspace();
    docA = await parseFilePath(workspaceFile('a.rules'));
});

const navigate = (path: string, start = docA, location = workspaceFile('a.rules')) =>
    nav.navigate(path, start, location, token);

describe('FullNavigationStrategy: cross-file references', () => {
    it('file -> in-file: resolves a path walked inside the target file', async () => {
        const result = await navigate('<./Data/a.rules>/A/Direct');
        expect(valueOf(result)).toBe(1);
    });

    it('file -> file: follows a member that points at another file', async () => {
        const result = await navigate('<./Data/a.rules>/A/ToB');
        expect(valueOf(result)).toBe(100);
    });

    it('file -> file -> file: follows a two-hop reference chain to the final leaf', async () => {
        const result = await navigate('<./Data/a.rules>/A/ToC');
        expect(valueOf(result)).toBe(300);
    });

    it('file -> file -> in-file -> in-file: crosses one file then walks a nested path', async () => {
        const result = await navigate('<./Data/a.rules>/A/ToNested');
        expect(valueOf(result)).toBe(200);
    });

    it('in-file -> in-file: multi-segment path within a single document', async () => {
        const docB = await parseFilePath(workspaceFile('b.rules'));
        const result = await nav.navigate('B/Nested/Deep/Leaf', docB, docB.uri, token);
        expect(valueOf(result)).toBe(200);
    });

    it('inheritance (cross-file): finds a member defined only on a base in another file', async () => {
        const aChild = findNodeByIdentifier(docA, 'AChild')!;
        const result = await nav.navigate('BaseOnly', aChild, docA.uri, token);
        expect(valueOf(result)).toBe(999);
    });

    it('file -> inheritance: enters a file then resolves an inherited cross-file member', async () => {
        const result = await navigate('<./Data/a.rules>/AChild/BaseOnly');
        expect(valueOf(result)).toBe(999);
    });

    it('file -> inheritance -> file -> file: inherited member chains onward into another file', async () => {
        const result = await navigate('<./Data/a.rules>/AChild/BaseToC');
        expect(valueOf(result)).toBe(300);
    });

    it('relative ../ file path: resolves through the real filesystem from a subdirectory', async () => {
        const shipPath = workspaceFile('ships', 'ship.rules');
        const shipDoc = await parseFilePath(shipPath);
        const result = await nav.navigate('&<../c.rules>/C/Leaf', shipDoc, shipPath, token);
        expect(valueOf(result)).toBe(300);
    });

    it('super-path /...: resolves against the workspace cosmoteer.rules root', async () => {
        const result = await nav.navigate('/Palette/Main', docA, docA.uri, token);
        expect(valueOf(result)).toBe(8);
    });

    it('returns null for a cross-file path whose final member does not exist', async () => {
        const result = await navigate('<./Data/a.rules>/A/DoesNotExist');
        expect(result).toBeNull();
    });

    // Nested `^/0/<Name>` inheritance, the real factory pattern (factory_durasteel.rules),
    // where each nested group re-declares inheritance from the matching node in a base
    // file. The inheritance reference is relative to the inheritance value node, so it
    // must be resolved from that node's scope (regression: resolving it from the group
    // shifted `^` up one level and flagged every `X : ^/0/X` line as unknown).
    describe('nested ^/0/<Name> cross-file inheritance', () => {
        const derivedPath = workspaceFile('parts', 'derived_part.rules');

        it("resolves a nested group's `^/0/<Name>` inheritance reference to the base-file node", async () => {
            const derived = await parseFilePath(derivedPath);
            const part = findNodeByIdentifier(derived, 'Part')!;
            const components = findNodeByIdentifier(part, 'Components')!;
            const isOperational = findNodeByIdentifier(components, 'IsOperational')!;

            type InhNode = AbstractNode & { valueType: { value: string } };
            const compInh = (components as unknown as { inheritance: InhNode[] }).inheritance[0];
            const isoInh = (isOperational as unknown as { inheritance: InhNode[] }).inheritance[0];

            const resolvedComp = await nav.navigate(compInh.valueType.value, compInh, derived.uri, token);
            const resolvedIso = await nav.navigate(isoInh.valueType.value, isoInh, derived.uri, token);

            expect(resolvedComp && 'identifier' in resolvedComp && (resolvedComp.identifier as { name?: string })?.name).toBe('Components');
            expect(resolvedIso && 'identifier' in resolvedIso && (resolvedIso.identifier as { name?: string })?.name).toBe('IsOperational');
        });

        it('reaches a member defined only on the cross-file base through nested inheritance', async () => {
            const derived = await parseFilePath(derivedPath);
            const part = findNodeByIdentifier(derived, 'Part')!;
            const components = findNodeByIdentifier(part, 'Components')!;
            const isOperational = findNodeByIdentifier(components, 'IsOperational')!;

            // `Type` is defined only on the base IsOperational; the derived one only sets Mode.
            const result = await nav.navigate('Type', isOperational, derived.uri, token);
            expect(valueOf(result)).toBe('MultiToggle');
        });

        it('resolves an absolute `&~/Part/^/0/<Name>` reference to an inherited base member', async () => {
            // factory_durasteel.rules lines 401/420 use `&~/Part/^/0/HEAT_TARGET_STORAGE`
            // from deep inside a component. `~/Part` jumps to the local Part; `^/0` must
            // then select Part's own inheritance base (regression: `^` has no grandparent
            // on a top-level group, so this returned null and was flagged).
            const derived = await parseFilePath(derivedPath);
            const part = findNodeByIdentifier(derived, 'Part')!;
            const components = findNodeByIdentifier(part, 'Components')!;
            const heatProducer = findNodeByIdentifier(components, 'HeatProducer')!;
            const valueNode = (heatProducer as unknown as { elements: { type: string; left?: { name: string }; right: AbstractNode }[] })
                .elements.find((e) => e.type === 'Assignment' && e.left?.name === 'ResourceStorage')!.right;

            const result = await nav.navigate('&~/Part/^/0/HeatTarget', valueNode, derived.uri, token);
            expect(valueOf(result)).toBe('HeatStorageDistribution');
        });
    });
});
