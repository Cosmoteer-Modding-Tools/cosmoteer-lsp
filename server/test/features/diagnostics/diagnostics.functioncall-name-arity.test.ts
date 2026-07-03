import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ValidationForFunctionCall } from '../../../src/features/diagnostics/validator.functioncall';
import { KNOWN_FUNCTION_NAMES, MATH_FUNCTIONS } from '../../../src/semantics/math-function-registry';
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

    it('flags too few arguments for an unevaluated mXparser function (registry-wide arity)', async () => {
        // `root` is binary and `if` is ternary in mXparser; neither is evaluatable, but the registry
        // still carries their arity so a forgotten argument is caught.
        const rootError = await validate('X = root(&A)\n');
        expect(rootError?.message).toBe('Too few arguments for "root"');
        const ifError = await validate('X = if((&A), 2)\n');
        expect(ifError?.message).toBe('Too few arguments for "if"');
    });
});

describe('registry integrity', () => {
    it('assigns a sane arity to every function', () => {
        for (const [name, spec] of Object.entries(MATH_FUNCTIONS)) {
            expect(spec.arity[0], `bad minimum arity for ${name}`).toBeGreaterThanOrEqual(1);
            expect(spec.arity[1], `arity bounds inverted for ${name}`).toBeGreaterThanOrEqual(spec.arity[0]);
        }
    });

    it('derives the evaluatable set from the entries with an implementation (no drift)', () => {
        for (const name of KNOWN_FUNCTION_NAMES) {
            expect(MATH_FUNCTIONS[name]?.evaluate, `missing implementation for ${name}`).toBeDefined();
        }
    });

    it('keeps declared parameter names consistent with the arity', () => {
        for (const [name, spec] of Object.entries(MATH_FUNCTIONS)) {
            if (!spec.params) continue;
            const max = isFinite(spec.arity[1]) ? spec.arity[1] : spec.params.length;
            expect(spec.params.length, `param names of ${name} disagree with its arity`).toBe(max);
        }
    });

    it('rejects a wrong argument count in every evaluate closure (arity and implementation agree)', () => {
        for (const [name, spec] of Object.entries(MATH_FUNCTIONS)) {
            if (!spec.evaluate) continue;
            expect(spec.evaluate([]), `${name} should reject an empty argument list`).toBeNull();
            if (isFinite(spec.arity[1])) {
                const tooMany = new Array(spec.arity[1] + 1).fill(1);
                expect(spec.evaluate(tooMany), `${name} should reject ${tooMany.length} arguments`).toBeNull();
            }
        }
    });
});
