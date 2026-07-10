import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { TemplateBaseIndex } from '../../src/features/diagnostics/template-base.index';
import { findInheritorsOf, resolveVirtualInheritanceTargets } from '../../src/semantics/inheritor-resolver';
import { splitVirtualColon } from '../../src/utils/reference.utils';
import { AbstractNode, isGroupNode, isListNode, isValueNode } from '../../src/core/ast/ast';
import { clearFsCaches } from '../../src/workspace/fs-cache';

const token = CancellationToken.None;

// A base group whose virtual member is overridden by two same-file list-element inheritors, mirroring the
// only vanilla usage (`modes/career/sectors/sysgen_sim_global_missions.rules`): the `&Base/:/Member`
// reference inside the base selects the deriving overrides at runtime.
const MISSIONS = [
    'Missions',
    '[',
    '\t: ~/BaseExploration { v_DiscoverCountFraction = 25% }',
    '\t: ~/BaseExploration { v_DiscoverCountFraction = 50% }',
    ']',
    '',
    'BaseExploration',
    '{',
    '\tv_DiscoverCountFraction // VIRTUAL; must be inherited',
    '\tDiscoverCountFraction = &~/BaseExploration/:/v_DiscoverCountFraction',
    '}',
    '',
].join('\n');

describe('splitVirtualColon', () => {
    it('splits a `&~/Base/:/Member` path into base and member', () => {
        expect(splitVirtualColon('&~/BaseExploration/:/v_DiscoverCountFraction')).toEqual({
            basePath: '&~/BaseExploration',
            memberPath: 'v_DiscoverCountFraction',
        });
    });

    it('splits a leading `&:/Member` (own most-derived self) into the bare `&` base', () => {
        expect(splitVirtualColon('&:/v_A')).toEqual({ basePath: '&', memberPath: 'v_A' });
    });

    it('returns undefined for a path with no virtual-inheritance colon', () => {
        expect(splitVirtualColon('&~/BaseExploration/DiscoverCountFraction')).toBeUndefined();
        // An inheritance-declaration colon (`Child : Parent`) is not a path segment and must not match.
        expect(splitVirtualColon('&Parent')).toBeUndefined();
    });

    it('does not crash or false-match on degenerate and adversarial inputs', () => {
        for (const input of ['', ':', '::', '/', '&', '&:', ':/', '///', '&/:/', '&<C:/x/y.rules>/M', '::::/', '&a/:/:/b']) {
            expect(() => splitVirtualColon(input)).not.toThrow();
        }
        // A bare `:/M` (colon at the very start, not after `&` or `/`) is not our segment.
        expect(splitVirtualColon(':/M')).toBeUndefined();
        // A Windows drive colon inside a `<file>` path must not be taken for a virtual colon.
        expect(splitVirtualColon('&<C:/x/y.rules>/Member')).toBeUndefined();
        // The first virtual colon wins when the path (pathologically) has more than one.
        expect(splitVirtualColon('&a/:/b/:/c')).toEqual({ basePath: '&a', memberPath: 'b/:/c' });
    });
});

describe('virtual-inheritance inheritor resolution', () => {
    let dir: string | undefined;

    afterEach(() => {
        TemplateBaseIndex.instance.reset();
        clearFsCaches();
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    const buildWorkspace = async (files: Record<string, string>): Promise<string> => {
        dir = mkdtempSync(join(tmpdir(), 'inheritor-'));
        for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
        TemplateBaseIndex.instance.reset();
        clearFsCaches();
        await TemplateBaseIndex.instance.baseNames([dir], token);
        return dir;
    };

    const baseGroupOf = (root: string, file: string, content: string): AbstractNode => {
        const doc = parser(lexer(content), pathToFileURL(join(root, file)).href).value;
        const base = doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'BaseExploration');
        if (!base) throw new Error('no BaseExploration base group');
        return base;
    };

    it('indexes the inheriting file under the base name (reverse edge)', async () => {
        const root = await buildWorkspace({ 'missions.rules': MISSIONS });
        const uris = TemplateBaseIndex.instance.documentsForBaseName('BaseExploration');
        expect(uris.length).toBe(1);
        // Case-insensitive, like the game's member lookup.
        expect(TemplateBaseIndex.instance.documentsForBaseName('baseexploration').length).toBe(1);
        expect(uris[0].toLowerCase()).toContain('missions.rules');
        void root;
    });

    it('finds every concrete inheritor of a same-file base', async () => {
        const root = await buildWorkspace({ 'missions.rules': MISSIONS });
        const base = baseGroupOf(root, 'missions.rules', MISSIONS);
        const inheritors = await findInheritorsOf(base, token);
        expect(inheritors.length).toBe(2);
    });

    it('resolves the virtual member to each deriving override value', async () => {
        const root = await buildWorkspace({ 'missions.rules': MISSIONS });
        const base = baseGroupOf(root, 'missions.rules', MISSIONS);
        const targets = await resolveVirtualInheritanceTargets(base, 'v_DiscoverCountFraction', token);
        const values = targets
            .filter(isValueNode)
            .map((node) => String(node.valueType.value))
            .sort();
        expect(values).toEqual(['25%', '50%']);
    });

    it('finds inheritors that live in a different file (the cross-file / mod case)', async () => {
        const BASE = ['BaseExploration', '{', '\tv_DiscoverCountFraction // VIRTUAL', '}', ''].join('\n');
        const DERIVED = [
            'Missions',
            '[',
            '\t: <base.rules>/BaseExploration { v_DiscoverCountFraction = 75% }',
            ']',
            '',
        ].join('\n');
        const root = await buildWorkspace({ 'base.rules': BASE, 'derived.rules': DERIVED });
        const base = baseGroupOf(root, 'base.rules', BASE);
        const targets = await resolveVirtualInheritanceTargets(base, 'v_DiscoverCountFraction', token);
        const values = targets.filter(isValueNode).map((node) => String(node.valueType.value));
        expect(values).toEqual(['75%']);
    });

    it('returns nothing for a base no file inherits yet (a template awaiting a deriver)', async () => {
        const LONELY = ['BaseExploration', '{', '\tv_DiscoverCountFraction // VIRTUAL', '}', ''].join('\n');
        const root = await buildWorkspace({ 'lonely.rules': LONELY });
        const base = baseGroupOf(root, 'lonely.rules', LONELY);
        expect(await findInheritorsOf(base, token)).toEqual([]);
        expect(await resolveVirtualInheritanceTargets(base, 'v_DiscoverCountFraction', token)).toEqual([]);
    });

    it('terminates on a cyclic inheritance chain (A : B, B : A) instead of looping', async () => {
        const CYCLE = ['A : B { v_X = 1 }', 'B : A { v_X = 2 }', ''].join('\n');
        const root = await buildWorkspace({ 'cycle.rules': CYCLE });
        const doc = parser(lexer(CYCLE), pathToFileURL(join(root, 'cycle.rules')).href).value;
        const a = doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'A')!;
        // B inherits A, so A's inheritor is B; resolving a member that only exists via the cycle must
        // not recurse forever (findMemberThroughInheritance's visited guard bounds it).
        const inheritors = await findInheritorsOf(a, token);
        expect(inheritors.length).toBe(1);
        expect(await resolveVirtualInheritanceTargets(a, 'nonexistent', token)).toEqual([]);
    });

    it('terminates on self-inheritance (A : A)', async () => {
        const SELF = ['A : A { v_X = 1 }', ''].join('\n');
        const root = await buildWorkspace({ 'self.rules': SELF });
        const doc = parser(lexer(SELF), pathToFileURL(join(root, 'self.rules')).href).value;
        const a = doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'A')!;
        expect(async () => await resolveVirtualInheritanceTargets(a, 'v_X', token)).not.toThrow();
    });

    it('is a no-op for a base with no identifier (an anonymous list element)', async () => {
        const ANON = ['List', '[', '\t{ v_X = 1 }', ']', ''].join('\n');
        const root = await buildWorkspace({ 'anon.rules': ANON });
        const doc = parser(lexer(ANON), pathToFileURL(join(root, 'anon.rules')).href).value;
        const list = doc.elements.find((e) => isListNode(e) && e.identifier?.name === 'List')! as unknown as {
            elements: AbstractNode[];
        };
        const anonElement = list.elements[0];
        expect(anonElement).toBeDefined();
        // The base has no name to index by, so there is nothing to resolve inheritors against.
        expect(await findInheritorsOf(anonElement, token)).toEqual([]);
    });

    it('returns nothing (not a crash) when the member exists on no inheritor', async () => {
        const root = await buildWorkspace({ 'missions.rules': MISSIONS });
        const base = baseGroupOf(root, 'missions.rules', MISSIONS);
        expect(await resolveVirtualInheritanceTargets(base, 'TotallyMissingMember', token)).toEqual([]);
        expect(await resolveVirtualInheritanceTargets(base, '', token)).toEqual([]);
    });

    it('honours a cancelled token without throwing', async () => {
        const root = await buildWorkspace({ 'missions.rules': MISSIONS });
        const base = baseGroupOf(root, 'missions.rules', MISSIONS);
        expect(await findInheritorsOf(base, CancellationToken.Cancelled)).toEqual([]);
        expect(await resolveVirtualInheritanceTargets(base, 'v_DiscoverCountFraction', CancellationToken.Cancelled)).toEqual([]);
    });
});
