import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { findNodeAtPosition } from '../../../src/utils/ast.utils';
import {
    AutoCompletionMathFunction,
    mathFunctionCompletionsAtLinePrefix,
} from '../../../src/features/completion/autocompletion.math-function';
import { Completion } from '../../../src/features/completion/autocompletion.service';

const token = CancellationToken.None;
const completer = new AutoCompletionMathFunction();

/** Runs the completer on the AST leaf at `character` of `source`'s single line. */
const completeAt = async (source: string, character: number): Promise<string[]> => {
    const document = parser(lexer(source), 'file:///t.rules').value;
    const node = findNodeAtPosition(document, { line: 0, character });
    expect(node).toBeDefined();
    const completions = await completer.getCompletions(node as never, token);
    return labels(completions);
};

const labels = (completions: Completion[]): string[] =>
    completions.map((completion) => (typeof completion === 'string' ? completion : completion.label));

describe('AutoCompletionMathFunction, function names inside expressions', () => {
    it('offers function names for an operand of a math expression', async () => {
        const found = await completeAt('Damage = 2 * sq', 15);
        expect(found).toContain('sqrt');
        expect(found).toContain('ceil');
        expect(found).toContain('pi');
    });

    it('offers function names for a partial word after a completed call', async () => {
        const found = await completeAt('Damage = ceil(17/2) + sq', 24);
        expect(found).toContain('sqrt');
    });

    it('offers function names inside a function call argument', async () => {
        const found = await completeAt('Damage = ceil(2 + sq)', 20);
        expect(found).toContain('sqrt');
    });

    it('inserts a call snippet with the cursor between the parentheses', async () => {
        const document = parser(lexer('Damage = 2 * sq'), 'file:///t.rules').value;
        const node = findNodeAtPosition(document, { line: 0, character: 15 });
        const completions = await completer.getCompletions(node as never, token);
        const sqrt = completions.find((c) => typeof c !== 'string' && c.label === 'sqrt');
        expect(sqrt).toMatchObject({ insertText: 'sqrt($0)', isSnippet: true });
    });

    it('offers nothing for a plain value of an untyped field', async () => {
        expect(await completeAt('Name = sq', 9)).toEqual([]);
    });

    it('offers function names for a plain value of a schema-numeric field', async () => {
        const source = 'Turret { Type = TurretWeapon; TargetingRange = sq }';
        const document = parser(lexer(source), 'file:///t.rules').value;
        const node = findNodeAtPosition(document, { line: 0, character: 49 });
        expect(node).toBeDefined();
        const found = labels(await completer.getCompletions(node as never, token));
        expect(found).toContain('sqrt');
    });

    it('offers nothing for a plain value of an enum field', async () => {
        const source = 'Toggle { Type = MultiToggle; Mode = A }';
        const document = parser(lexer(source), 'file:///t.rules').value;
        const node = findNodeAtPosition(document, { line: 0, character: 37 });
        expect(node).toBeDefined();
        expect(labels(await completer.getCompletions(node as never, token))).toEqual([]);
    });

    it('offers nothing for a plain value of a schema-string field', async () => {
        const source = 'Consumer { Type = ResourceConsumer; OverridePriorityName = sq }';
        const document = parser(lexer(source), 'file:///t.rules').value;
        const node = findNodeAtPosition(document, { line: 0, character: 61 });
        expect(node).toBeDefined();
        expect(labels(await completer.getCompletions(node as never, token))).toEqual([]);
    });

    it('offers nothing for a plain value of a bool field', async () => {
        const source = 'Turret { Type = TurretWeapon; ReturnToCenter = t }';
        const document = parser(lexer(source), 'file:///t.rules').value;
        const node = findNodeAtPosition(document, { line: 0, character: 48 });
        expect(node).toBeDefined();
        expect(labels(await completer.getCompletions(node as never, token))).toEqual([]);
    });

    it('offers nothing for a plain value of a reference field', async () => {
        const source = 'Turret { Type = TurretWeapon; AllowRotationToggle = sq }';
        const document = parser(lexer(source), 'file:///t.rules').value;
        const node = findNodeAtPosition(document, { line: 0, character: 54 });
        expect(node).toBeDefined();
        expect(labels(await completer.getCompletions(node as never, token))).toEqual([]);
    });

    it('offers nothing even inside an expression on a schema-string field', async () => {
        const source = 'Consumer { Type = ResourceConsumer; OverridePriorityName = 2 * sq }';
        const document = parser(lexer(source), 'file:///t.rules').value;
        const node = findNodeAtPosition(document, { line: 0, character: 65 });
        expect(node).toBeDefined();
        expect(labels(await completer.getCompletions(node as never, token))).toEqual([]);
    });

    it('offers function names inside an expression on a numeric field', async () => {
        const source = 'Turret { Type = TurretWeapon; TargetingRange = 2 * sq }';
        const document = parser(lexer(source), 'file:///t.rules').value;
        const node = findNodeAtPosition(document, { line: 0, character: 53 });
        expect(node).toBeDefined();
        expect(labels(await completer.getCompletions(node as never, token))).toContain('sqrt');
    });

    it('offers nothing for an inheritance base', async () => {
        const source = 'Child : sq { }';
        const document = parser(lexer(source), 'file:///t.rules').value;
        const node = findNodeAtPosition(document, { line: 0, character: 10 });
        if (!node) return; // an inheritance base may not resolve to a leaf, silence either way
        expect(labels(await completer.getCompletions(node as never, token))).toEqual([]);
    });

    it('offers nothing for a quoted string operand', async () => {
        const source = 'Sound = db2vol("-6")';
        const document = parser(lexer(source), 'file:///t.rules').value;
        const node = findNodeAtPosition(document, { line: 0, character: 17 });
        if (!node) return;
        expect(labels(await completer.getCompletions(node as never, token))).toEqual([]);
    });
});

describe('mathFunctionCompletionsAtLinePrefix, unclosed-call fallback', () => {
    /** Runs the fallback with `linePrefix` as the whole single-line document, cursor at its end. */
    const fallback = (linePrefix: string): string[] => {
        const document = parser(lexer(linePrefix), 'file:///t.rules').value;
        return labels(mathFunctionCompletionsAtLinePrefix(document, linePrefix.length, linePrefix));
    };

    it('offers function names inside an unclosed call', () => {
        expect(fallback('Damage = ceil(sq')).toContain('sqrt');
    });

    it('offers nothing at a bare value position', () => {
        expect(fallback('Damage = ')).toEqual([]);
    });

    it('offers nothing inside a plain grouping parenthesis', () => {
        expect(fallback('Damage = (sq')).toEqual([]);
    });

    it('offers nothing once the call is closed again', () => {
        expect(fallback('Damage = ceil(2) + ')).toEqual([]);
    });

    it('offers nothing inside a line comment', () => {
        expect(fallback('Damage = 5 // like ceil(sq')).toEqual([]);
    });

    /** Fallback inside a well-formed group where only the value line is mid-edit. */
    const fallbackInGroup = (groupHead: string, valueLine: string): string[] => {
        const source = `${groupHead}\n{\n\tType = ${groupHead === 'Turret' ? 'TurretWeapon' : 'ResourceConsumer'}\n\t${valueLine}\n}\n`;
        const document = parser(lexer(source), 'file:///t.rules').value;
        const offset = source.indexOf(valueLine) + valueLine.length;
        return labels(mathFunctionCompletionsAtLinePrefix(document, offset, `\t${valueLine}`));
    };

    it('offers function names for an unclosed call on a numeric field', () => {
        expect(fallbackInGroup('Turret', 'TargetingRange = ceil(sq')).toContain('sqrt');
    });

    it('offers nothing for an unclosed call on a schema-string field', () => {
        expect(fallbackInGroup('Consumer', 'OverridePriorityName = ceil(sq')).toEqual([]);
    });
});
