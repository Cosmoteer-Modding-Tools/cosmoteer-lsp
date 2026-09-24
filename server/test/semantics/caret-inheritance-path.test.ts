import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { navigate } from '../../src/semantics/navigate-reference';
import { stepIntoNode } from '../../src/document/reference-resolver';
import { AbstractNode, GroupNode, isAssignmentNode, isGroupNode, isListNode } from '../../src/core/ast/ast';

const token = CancellationToken.None;

const SOURCE =
    'Base\n{\n\tLabel = hello\n\tSub\n\t{\n\t\tDeep = 3\n\t}\n}\n' +
    'Other\n{\n\tOnlyOther = 7\n}\n' +
    'Derived : Base, Other\n{\n\tOwn = 9\n' +
    '\tByIndex = &^/0/Label\n\tByOtherIndex = &^/1/OnlyOther\n\tDeepIndex = &^/0/Sub/Deep\n' +
    '\tByName = &^/Label\n\tOtherByName = &^/OnlyOther\n\tOwnByCaret = &^/Own\n\tDeepByName = &^/Sub/Deep\n' +
    '\tCaretDotDot = &^/../Base/Label\n\tCaretColon = &^/:/Label\n\tBare = &Label\n}\n';

const doc = parser(lexer(SOURCE), 'file:///caret.rules').value;
const derived = doc.elements.find(
    (element) => (isGroupNode(element) || isListNode(element)) && element.identifier?.name === 'Derived'
) as GroupNode;

/** What the reference written under `name` resolves to, navigated from the value node itself. */
const targetOf = async (name: string): Promise<unknown> => {
    const member = derived.elements.find((element) => isAssignmentNode(element) && element.left.name === name);
    const value = isAssignmentNode(member!) ? member.right! : undefined;
    const written = String((value as unknown as { valueType: { value: unknown } }).valueType.value);
    const found = await navigate(written, value as AbstractNode, doc.uri, token);
    return found && 'valueType' in found ? (found as { valueType: { value: unknown } }).valueType.value : found;
};

// `^` lands on the node's `OTInheritanceListNode`, and every name lookup on that list runs through
// `int.TryParse` (`OTInheritanceListNode.ChildCollection`), so only a base index resolves there.
// Running the shipped HalflingCore navigator over this very document answers
// `^/0/Label -> OTGroupedFieldNode value=hello` and `^/1/OnlyOther -> value=7`, and finds nothing for
// `^/Label`, `^/Sub/Deep`, `^/../Base/Label` and `^/:/Label`. Dereferencing one of the misses throws
// `OTNavigateException`, so answering with a target would be a definition, a hover, a reference list
// and a rename on a path the game cannot reach.
describe('a path through the caret', () => {
    it('resolves a base by index', async () => {
        expect(await targetOf('ByIndex')).toBe('hello');
        expect(await targetOf('ByOtherIndex')).toBe(7);
        expect(await targetOf('DeepIndex')).toBe(3);
    });

    it('does not resolve a member name straight after the caret', async () => {
        expect(await targetOf('ByName')).toBeNull();
        expect(await targetOf('OtherByName')).toBeNull();
    });

    it('does not resolve a member of the node itself straight after the caret', async () => {
        expect(await targetOf('OwnByCaret')).toBeNull();
    });

    it('does not resolve a deeper path straight after the caret', async () => {
        expect(await targetOf('DeepByName')).toBeNull();
    });

    it('does not resolve `..` or `:` straight after the caret', async () => {
        expect(await targetOf('CaretDotDot')).toBeNull();
        expect(await targetOf('CaretColon')).toBeNull();
    });

    it('still resolves the same member without the caret, which is what the game reads', async () => {
        // The ordinary inherited-member lookup, and the repair the author wants.
        expect(await targetOf('Bare')).toBe('hello');
    });

    it('steps into a base index and refuses every other segment after the caret', () => {
        expect(stepIntoNode(derived, '0', true)).toBeTruthy();
        expect(stepIntoNode(derived, 'Label', true)).toBeNull();
        expect(stepIntoNode(derived, '..', true)).toBeNull();
        expect(stepIntoNode(derived, ':', true)).toBeNull();
    });

    it('leaves a bare caret alone, which the game answers with the inheritance list', () => {
        expect(stepIntoNode(derived, '^')).toBe(derived);
    });
});
