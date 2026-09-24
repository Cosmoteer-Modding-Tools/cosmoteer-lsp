import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    ValueNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
} from '../../src/core/ast/ast';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { flattenGroup, invalidateEffectiveChainCache } from '../../src/semantics/effective-group';
import { findMemberThroughInheritance } from '../../src/semantics/inheritance-resolver';
import { resolveReference } from '../../src/semantics/effective-member';
import { evaluateNumericValue } from '../../src/semantics/value-evaluator';
import { registerInheritanceExtensionSource } from '../../src/document/reference-resolver';
import { clearNavigationMemo } from '../../src/semantics/navigate-reference';
import { walkAst } from '../helpers';
import { initWorkspace } from '../workspace-helper';

const token = CancellationToken.None;
let dir: string;

/** Writes a file into the temporary tree and parses it under its real uri. */
const put = (relative: string, source: string): AbstractNodeDocument => {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    return parser(lexer(source), pathToFileURL(path).href).value;
};

/** The first group with the given identifier. */
const group = (node: AbstractNode, name: string): GroupNode => {
    for (const found of walkAst(node)) if (isGroupNode(found) && found.identifier?.name === name) return found;
    throw new Error(`group ${name} not found`);
};

/** The first list with the given identifier. */
const list = (node: AbstractNode, name: string): ListNode => {
    for (const found of walkAst(node)) if (isListNode(found) && found.identifier?.name === name) return found;
    throw new Error(`list ${name} not found`);
};

/** The right-hand side of the named assignment. */
const rhsOf = (node: AbstractNode, name: string): AbstractNode => {
    for (const found of walkAst(node)) {
        if (isAssignmentNode(found) && found.left.name === name && found.right) return found.right;
    }
    throw new Error(`assignment ${name} not found`);
};

/** The effective member names of a container. */
const namesOf = async (node: GroupNode): Promise<string[]> =>
    (await flattenGroup(node, token)).members.map((member) => member.name);

beforeAll(async () => {
    await initWorkspace();
    dir = mkdtempSync(join(tmpdir(), 'base-scope-'));
});
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
    registerInheritanceExtensionSource(undefined);
    invalidateEffectiveChainCache();
    clearNavigationMemo();
});

// `OTInheritanceReferenceNode.GetFindRoot` climbs from the base reference through the inheritance
// list and the inheriting node to that node's own container, so a `..` in a base path counts from
// the container rather than from the inheriting node itself.
describe('a relative inheritance base', () => {
    it('folds in the base a list element names through its list', async () => {
        const doc = put(
            'listelem.rules',
            [
                'FACTORS',
                '{',
                '\tSPEED = 1.15',
                '}',
                'Holder',
                '{',
                '\tInner',
                '\t{',
                '\t\tSounds',
                '\t\t[',
                '\t\t\t{',
                '\t\t\t\tSpeed = 4',
                '\t\t\t\tVolume = 2',
                '\t\t\t}',
                '\t\t]',
                '\t}',
                '\tDerived : &Inner',
                '\t{',
                '\t\tSounds',
                '\t\t[',
                '\t\t\t: ../^/0/Sounds/0',
                '\t\t\t{',
                '\t\t\t\tSpeed = (&^/0/Speed) * (&~/FACTORS/SPEED)',
                '\t\t\t}',
                '\t\t]',
                '\t}',
                '}',
                '',
            ].join('\n')
        );
        const element = list(group(doc, 'Derived'), 'Sounds').elements[0] as GroupNode;
        expect(await namesOf(element)).toEqual(['Volume', 'Speed']);
        expect(await evaluateNumericValue(rhsOf(element, 'Speed'), token)).toBeCloseTo(4.6, 10);
    });

    it('folds in the base a group member names through its container', async () => {
        const doc = put(
            'groupmember.rules',
            [
                'Blueprints',
                '{',
                '\tInvalidMaterial',
                '\t{',
                '\t\tShader = "invalid"',
                '\t\tAlpha = 1',
                '\t}',
                '}',
                'Redprints',
                '{',
                '\tMaterial : ../Blueprints/InvalidMaterial',
                '\t{',
                '\t\tBeta = 2',
                '\t}',
                '}',
                '',
            ].join('\n')
        );
        expect(await namesOf(group(doc, 'Material'))).toEqual(['Shader', 'Alpha', 'Beta']);
    });

    it('still resolves a base named as a plain sibling, which counts from the value node', async () => {
        // The negative control for the two above: `Child : Parent` normalizes to `&Parent`, which
        // resolves one scope up from the entry and must keep doing so.
        const doc = put(
            'sibling.rules',
            ['Parent', '{', '\tA = 1', '}', 'Child : Parent', '{', '\tB = 2', '}', ''].join('\n')
        );
        expect(await namesOf(group(doc, 'Child'))).toEqual(['A', 'B']);
    });

    it('reports a relative base naming nothing as unreadable rather than inventing members', async () => {
        const doc = put(
            'missing.rules',
            [
                'Blueprints',
                '{',
                '\tInvalidMaterial',
                '\t{',
                '\t\tAlpha = 1',
                '\t}',
                '}',
                'Redprints',
                '{',
                '\tMaterial : ../Blueprints/NoSuchMaterial',
                '\t{',
                '\t\tBeta = 2',
                '\t}',
                '}',
                '',
            ].join('\n')
        );
        const flattened = await flattenGroup(group(doc, 'Material'), token);
        expect(flattened.members.map((member) => member.name)).toEqual(['Beta']);
        expect(flattened.complete).toBe(false);
        expect(flattened.unreadable[0].reason).toBe('unresolved');
    });
});

// A mod's `AddBase` appends its `BaseToAdd` to the target node's inheritance list. The reference is
// written in the manifest, so it resolves from the manifest's own scope and folder, not from the
// game file it is folded into.
describe('a base a mod appends', () => {
    /** Registers `entry` as the one appended base of `target`. */
    const appendBase = (target: AbstractNode, entry: ValueNode): void => {
        registerInheritanceExtensionSource((node, extraIndex) =>
            node === target && extraIndex === 0 ? entry : undefined
        );
        invalidateEffectiveChainCache();
        clearNavigationMemo();
    };

    it('folds in a base whose file is named relative to the manifest', async () => {
        put('booster.rules', ['BuffProvider', '{', '\tGridDistance = 1', '}', ''].join('\n'));
        const manifest = put(
            'mod.rules',
            ['Actions', '[', '\t{', '\t\tBaseToAdd = &<booster.rules>', '\t}', ']', ''].join('\n')
        );
        const part = put('parts/part.rules', ['Part', '{', '\tComponents', '\t{', '\t}', '}', ''].join('\n'));
        const components = group(part, 'Components');
        appendBase(components, rhsOf(manifest, 'BaseToAdd') as ValueNode);

        expect(await namesOf(components)).toEqual(['BuffProvider']);
        expect(await findMemberThroughInheritance(components, 'BuffProvider', resolveReference, token)).toBeTruthy();
    });

    it('leaves the node with its own members when nothing is appended', async () => {
        // The negative control: the same part, read with no extension source registered.
        const part = put('parts/plain.rules', ['Part', '{', '\tComponents', '\t{', '\t}', '}', ''].join('\n'));
        const components = group(part, 'Components');
        expect(await namesOf(components)).toEqual([]);
        expect(await findMemberThroughInheritance(components, 'BuffProvider', resolveReference, token)).toBeNull();
    });
});
