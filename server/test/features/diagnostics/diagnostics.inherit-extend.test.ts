import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { ValidationForValue } from '../../../src/features/diagnostics/validator.value';
import { AbstractNode, isAssignmentNode, isListNode, isGroupNode, ValueNode } from '../../../src/core/ast/ast';
import { parseFilePath, findNodeByIdentifier } from '../../../src/utils/ast.utils';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, workspaceFile, WORKSPACE_DATA_DIR } from '../../workspace-helper';

const token = CancellationToken.None;

// `X : ^/0/X [extra]`: inheriting-and-extending a member the base doesn't define is
// valid in Cosmoteer (the missing base member just contributes nothing). It must not be
// flagged, but an inheritance whose base itself is missing is still a real error.
describe('inheritance that extends a missing base member', () => {
    let editorGroupsInh: ValueNode;
    let badBaseInh: ValueNode;
    let nestedExtrasInh: ValueNode;
    let deepInVirtualInh: ValueNode;
    let typoedInh: ValueNode;

    const inhOf = (container: AbstractNode & { elements: AbstractNode[] }, name: string) => {
        const member = container.elements.find(
            (e) => (isListNode(e) || isGroupNode(e)) && e.identifier?.name === name
        ) as unknown as { inheritance: ValueNode[] };
        return member.inheritance[0];
    };

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        const doc = await parseFilePath(workspaceFile('parts', 'eg_derived.rules'));
        const thing = findNodeByIdentifier(doc, 'Thing')! as AbstractNode & { elements: AbstractNode[] };
        editorGroupsInh = inhOf(thing, 'EditorGroups');
        badBaseInh = inhOf(thing, 'BadBase');
        typoedInh = inhOf(thing, 'Typoed');
        const inner = findNodeByIdentifier(thing, 'Inner')! as AbstractNode & { elements: AbstractNode[] };
        nestedExtrasInh = inhOf(inner, 'Extras');
        const virtual = findNodeByIdentifier(thing, 'Virtual')! as AbstractNode & { elements: AbstractNode[] };
        deepInVirtualInh = inhOf(virtual, 'Deep');
    });

    it('does not flag `EditorGroups : ^/0/EditorGroups` when the base lacks EditorGroups', async () => {
        // The base (`^/0`) resolves to the base part, EditorGroups just isn't on it.
        expect(await ValidationForValue.callback(editorGroupsInh, token)).toBeUndefined();
    });

    it('does not flag a NESTED `^/0/Extras` whose base prefix resolves through inheritance', async () => {
        // `^/0` here resolves to the `^/0/Inner` reference; it must be dereferenced to the
        // base Inner (which lacks Extras) for the extend-missing rule to apply.
        expect(await ValidationForValue.callback(nestedExtrasInh, token)).toBeUndefined();
    });

    it('does not flag an extend nested inside a VIRTUAL container (`Deep : ^/0/Deep` in `Virtual`)', async () => {
        // Virtual itself extends a missing base member, so its `^/0` deref is null, but the
        // inheritance slot exists, which is what makes `Deep`'s extend valid (roof_headlight
        // `Toggles : ^/0/Toggles` inside the virtual `IsOperational`).
        expect(await ValidationForValue.callback(deepInVirtualInh, token)).toBeUndefined();
    });

    it('still flags an inheritance whose BASE itself does not resolve (`^/9/Whatever`)', async () => {
        const diagnostic = await ValidationForValue.callback(badBaseInh, token);
        expect(diagnostic?.message).toBe('Reference name is not known');
    });

    it('still flags a typo where the member name differs from the inheriting member (`Typoed : ^/0/Tpyoed`)', async () => {
        // Only the extend-MY-OWN-member idiom (`X : ^/0/X`) is suppressed; a mismatched name
        // is a likely typo and must still be reported.
        const diagnostic = await ValidationForValue.callback(typoedInh, token);
        expect(diagnostic?.message).toBe('Reference name is not known');
    });
});

// A plain value reference (not an inheritance clause) that steps through a `^/N` caret base. When a
// member genuinely exists on the base, it resolves. When it does not, and no `AddBase` action
// extends that base (none in this fixture), it is a real miss and flags, exactly like a member
// reached without a caret hop. The `AddBase`-added-base case (`^/1` into an appended base) resolves
// through the shared resolver's AddBase index and is verified end-to-end by the LSP drivers.
describe('value reference through a caret-inheritance base', () => {
    let caretGood: ValueNode;
    let caretMissing: ValueNode;
    let nonCaretMissing: ValueNode;

    const valueOf = (container: AbstractNode & { elements: AbstractNode[] }, name: string): ValueNode => {
        const assignment = container.elements.find((e) => isAssignmentNode(e) && e.left.name === name);
        return (assignment as unknown as { right: ValueNode }).right;
    };

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        const doc = await parseFilePath(workspaceFile('parts', 'eg_caret_ref.rules'));
        const thing = findNodeByIdentifier(doc, 'CaretThing')! as AbstractNode & { elements: AbstractNode[] };
        caretGood = valueOf(thing, 'CaretGood');
        caretMissing = valueOf(thing, 'CaretMissing');
        nonCaretMissing = valueOf(thing, 'NonCaretMissing');
    });

    it('does not flag `&^/0/Density`: the member exists on the caret base', async () => {
        expect(await ValidationForValue.callback(caretGood, token)).toBeUndefined();
    });

    it('flags `&^/0/NotOnBase` when the base lacks the member and no AddBase extends it', async () => {
        const diagnostic = await ValidationForValue.callback(caretMissing, token);
        expect(diagnostic?.message).toBe('Reference name is not known');
    });

    it('still flags a missing member reached WITHOUT a caret hop (`&<eg_base.rules>/EgBase/NotOnBase`)', async () => {
        const diagnostic = await ValidationForValue.callback(nonCaretMissing, token);
        expect(diagnostic?.message).toBe('Reference name is not known');
    });
});
