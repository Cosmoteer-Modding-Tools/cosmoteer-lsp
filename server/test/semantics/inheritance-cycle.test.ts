import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { navigate } from '../../src/semantics/navigate-reference';
import { AbstractNode } from '../../src/core/ast/ast';
import { parseFixture } from '../helpers';
import { valueOf } from '../workspace-helper';

// Regression: a cyclic multi-segment inheritance chain used to recurse `navigate <->
// findMemberThroughInheritance` until the stack overflowed (surfaced by find-all-references,
// which resolves every reference in the project). The shared inheritance-visited guard must
// terminate it.
const token = CancellationToken.None;

describe('navigate: cyclic inheritance', () => {
    const doc = parseFixture('inheritance-cycle.rules');

    it('a missing member through a cyclic inheritance chain resolves to null (no overflow)', async () => {
        // Without the fix this throws RangeError: Maximum call stack size exceeded.
        const result = await navigate('CycleA/Missing', doc, doc.uri, token);
        expect(result).toBeNull();
    });

    it('resolving the inheritance refs themselves terminates instead of looping', async () => {
        // `&CycleB/Shared` (CycleA's base) loops too, so it must settle to null, not hang.
        const result = await navigate('CycleB/AlsoMissing', doc, doc.uri, token);
        expect(result).toBeNull();
    });

    it('a real own member still resolves normally', async () => {
        const result = await navigate('CycleA/OwnA', doc, doc.uri, token);
        expect(valueOf(result as AbstractNode)).toBe(1);
    });
});
