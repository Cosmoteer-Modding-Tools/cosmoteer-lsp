import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ValidationForFunctionCall } from '../../../src/features/diagnostics/validator.functioncall';
import { FUNCTION_ARITY, KNOWN_FUNCTION_NAMES } from '../../../src/semantics/value-evaluator';
import {
    AbstractNode,
    FunctionCallNode,
    isFunctionCallNode,
} from '../../../src/core/ast/ast';
import { walkAst } from '../../helpers';

const token = CancellationToken.None;

const firstCall = (src: string): FunctionCallNode => {
    const doc = parser(lexer(src), 'file:///fn.rules').value;
    for (const node of walkAst(doc as AbstractNode)) if (isFunctionCallNode(node)) return node;
    throw new Error('no function call parsed from: ' + src);
};
const validate = (src: string) => ValidationForFunctionCall.callback(firstCall(src), token);

describe('unknown function name diagnostics', () => {
    it('flags a misspelled function name', async () => {
        const error = await validate('X = cel(&A)\n');
        expect(error?.message).toBe('Unknown function "cel"');
        expect(error?.additionalInfo).toBe('"cel" is not a known math function');
    });

    it('does not flag an evaluatable function', async () => {
        expect(await validate('X = ceil(&A)\n')).toBeUndefined();
    });

    it('does not flag a valid mXparser function we cannot evaluate (no false positive)', async () => {
        // `deg` is a real mXparser function but not in the evaluatable table; it must NOT be flagged.
        expect(await validate('X = deg(&A)\n')).toBeUndefined();
        expect(await validate('X = gamma(&A)\n')).toBeUndefined();
    });

    it('matches function names case-insensitively', async () => {
        expect(await validate('X = CEIL(&A)\n')).toBeUndefined();
    });

    it('accepts the Cosmoteer-custom `db2vol` with a quoted-string argument', async () => {
        // `db2vol("&~/…")` parses (the parser accepts a STRING arg) and is NOT flagged — neither as
        // an unknown function nor as an invalid argument type (its signature is not the numeric one).
        const error = await validate('X = db2vol("&~/OVERCLOCK/AUDIO_VOLUME_DB")\n');
        expect(error).toBeUndefined();
    });

    it('does not parse-error on a function call with a string argument', () => {
        const result = parser(lexer('X = (&^/0/Volume) * db2vol("&~/A/B")\n'), 'file:///fn.rules');
        expect(result.parserErrors).toEqual([]);
    });
});

describe('function arity diagnostics (too-few only)', () => {
    it('flags too few arguments for a binary function', async () => {
        const error = await validate('X = pow(&A)\n');
        expect(error?.message).toBe('Too few arguments for "pow"');
        expect(error?.additionalInfo).toBe('The "pow" function takes exactly 2 argument(s), but got 1');
    });

    it('does NOT flag too many arguments (over-count is unreliable due to parser flattening)', async () => {
        // ceil takes one argument; two are written here, but we deliberately stay quiet rather than
        // risk false positives — the parser flattens nested calls into extra operands.
        expect(await validate('X = ceil((&A), (&B))\n')).toBeUndefined();
    });

    it('does NOT false-positive on a nested function call in argument position', async () => {
        // `floor(sqrt(x) * 2)` is one argument; the parser flattens the nested sqrt, which used to
        // inflate the apparent count to 2 and wrongly flag floor. It must stay quiet.
        expect(await validate('X = floor(sqrt(&A) * 2)\n')).toBeUndefined();
    });

    it('accepts a variadic function with several arguments', async () => {
        expect(await validate('X = max((&A), (&B), (&C))\n')).toBeUndefined();
    });

    it('accepts round with its optional second argument', async () => {
        expect(await validate('X = round((&A), 2)\n')).toBeUndefined();
        expect(await validate('X = round(&A)\n')).toBeUndefined();
    });
});

describe('arity table integrity', () => {
    it('only lists functions that are actually evaluatable', () => {
        for (const name of Object.keys(FUNCTION_ARITY)) {
            expect(KNOWN_FUNCTION_NAMES.has(name)).toBe(true);
        }
    });

    it('assigns an arity to every evaluatable function (no drift)', () => {
        for (const name of KNOWN_FUNCTION_NAMES) {
            expect(FUNCTION_ARITY[name], `missing arity for ${name}`).toBeDefined();
        }
    });
});
