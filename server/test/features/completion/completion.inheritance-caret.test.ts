import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, isAssignmentNode, isGroupNode, isValueNode, ValueNode } from '../../../src/core/ast/ast';
import { ReferenceAutoCompletionStrategy } from '../../../src/features/completion/strategy/reference.autocompletion-strategy';
import { AutoCompletionService } from '../../../src/features/completion/autocompletion.service';
import { findNodeAtPosition } from '../../../src/utils/ast.utils';
import { Completion } from '../../../src/features/completion/autocompletion.service';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

// Completing a caret-inheritance reference path (`&^/0/`, or the vanilla `&~/Part/^/0/`) must list the
// members of the resolved inheritance base, not the base file's root. `^` selects the current node's own
// inheritance anchor and the following `/N` indexes it, matching the shared resolver used by navigation
// and go-to in semantics/reference-resolver.ts. The regression this guards: the completion traversal
// jumped to the original node's grandparent, which for a value parented to its group is the document, so
// `/0` found no member and it listed the base file's root (`[Part]`) instead of the base Part's members.
const strat = new ReferenceAutoCompletionStrategy();
const token = CancellationToken.None;

beforeAll(async () => {
    await initWorkspace();
});

/**
 * Complete a caret-inheritance reference inside a derived part that inherits base_part.rules, returning
 * the suggested labels.
 * @param ampPrefix whether the part's inheritance is written with a leading `&` (`&<...>`) or the bare
 * vanilla form (`<...>`), so the test covers both.
 * @param ref the reference value to complete, for example `&^/0/` or `&~/Part/^/0/`.
 * @returns the completion labels the reference strategy offers at that reference.
 */
const completeCaretRef = async (ampPrefix: '&' | '', ref: string): Promise<string[]> => {
    const src = `Part : ${ampPrefix}<./Data/parts/base_part.rules>/Part\n{\n\tX = ${ref}\n}\n`;
    const doc = parser(lexer(src), workspaceFile('parts', 'probe.rules').replace(/\\/g, '/')).value;
    let refNode: ValueNode | undefined;
    const walk = (n: AbstractNode): void => {
        if (isValueNode(n) && n.valueType.type === 'Reference' && String(n.valueType.value).includes('^/0/')) refNode = n;
        if (isGroupNode(n)) {
            n.elements.forEach(walk);
            (n.inheritance ?? []).forEach(walk);
        }
        if (isAssignmentNode(n)) {
            walk(n.left);
            if (n.right) walk(n.right);
        }
    };
    doc.elements.forEach(walk);
    expect(refNode, `no reference node found for ${ref}`).toBeDefined();
    return strat.complete({ node: refNode!, isInheritanceNode: false, cancellationToken: token });
};

describe('caret-inheritance reference completion', () => {
    // base_part.rules declares Part with members HeatTarget and Components.
    it('`&^/0/` lists the inherited base Part members', async () => {
        const labels = await completeCaretRef('&', '&^/0/');
        expect(labels).toContain('HeatTarget');
        expect(labels).toContain('Components');
        expect(labels).not.toContain('Part'); // must not list the base file's root
    });

    it('`&~/Part/^/0/` (vanilla form) lists the inherited base Part members', async () => {
        const labels = await completeCaretRef('&', '&~/Part/^/0/');
        expect(labels).toContain('HeatTarget');
        expect(labels).toContain('Components');
    });

    it('works when inheritance omits the `&` (the vanilla `: <path>/Part` form)', async () => {
        const labels = await completeCaretRef('', '&^/0/');
        expect(labels).toContain('HeatTarget');
        expect(labels).toContain('Components');
    });
});

/**
 * Complete at the caret of a lone `&` in `src`.
 * @param src the document source, which must contain exactly one `X = &` line to complete at.
 * @returns the completion labels the service offers at that caret.
 */
const completeAtAmp = async (src: string): Promise<string[]> => {
    const doc = parser(lexer(src), workspaceFile('parts', 'probe.rules').replace(/\\/g, '/')).value;
    const line = src.slice(0, src.indexOf('X = &')).split('\n').length - 1;
    const character = 'X = &'.length + 1; // one tab of indentation before `X`
    const node = findNodeAtPosition(doc, { line, character });
    const svc: Completion[] = node
        ? await AutoCompletionService.instance.getCompletions(node, token)
        : [];
    return svc.map((c) => (typeof c === 'string' ? c : c.label));
};

describe('reference-start completion offers the caret path', () => {
    // Typing `&` should immediately offer the reference prefixes, including a `&^/N/` caret path for each
    // base the enclosing part inherits, so inherited members are discoverable from the first keystroke.
    it('offers `&^/0/` and the reference prefixes when the part inherits a base', async () => {
        const labels = await completeAtAmp('Part : &<./Data/parts/base_part.rules>/Part\n{\n\tX = &\n}\n');
        expect(labels).toEqual(expect.arrayContaining(['&<', '&/', '&~/', '&^/0/']));
    });

    it('omits the `&^/N/` caret path when the enclosing part has no inheritance', async () => {
        const labels = await completeAtAmp('Part\n{\n\tX = &\n}\n');
        expect(labels).toEqual(expect.arrayContaining(['&<', '&/']));
        expect(labels.some((l) => l.startsWith('&^/'))).toBe(false);
    });
});
