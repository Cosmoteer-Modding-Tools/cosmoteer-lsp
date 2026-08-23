import { describe, expect, it } from 'vitest';
import { ENGINE_UNIFORMS, HLSL_INTRINSICS, TEXTURE_METHODS } from '../../src/features/shader/shader-intrinsics';
import { CONSTANTS, MATH_FUNCTIONS, mathFunction } from '../../src/semantics/math-function-registry';
import { computeSignatureHelp } from '../../src/features/signature/signature-help.service';
import { registry } from '../../src/utils/registry';

// The two names that survive the toLowerCase() every one of these tables applies to a written name.
// Every other member of Object.prototype carries a capital, so the folded key already misses.
const INHERITED = ['constructor', '__proto__'];

describe('registries keyed by text the user wrote', () => {
    const tables: [string, Readonly<Record<string, unknown>>][] = [
        ['HLSL_INTRINSICS', HLSL_INTRINSICS],
        ['TEXTURE_METHODS', TEXTURE_METHODS],
        ['ENGINE_UNIFORMS', ENGINE_UNIFORMS],
        ['MATH_FUNCTIONS', MATH_FUNCTIONS],
        ['CONSTANTS', CONSTANTS],
    ];

    for (const [name, table] of tables) {
        it(`${name} answers nothing for an inherited member name`, () => {
            for (const key of INHERITED) expect(table[key], `${name}[${key}]`).toBeUndefined();
        });
    }

    it('still answers the entries it holds', () => {
        expect(HLSL_INTRINSICS['saturate']).toBeDefined();
        expect(MATH_FUNCTIONS['abs']).toBeDefined();
        expect(CONSTANTS['pi']).toBe(Math.PI);
    });

    it('keeps its own keys enumerable', () => {
        expect(Object.keys(CONSTANTS).sort()).toEqual(['e', 'pi']);
        expect(Object.keys(MATH_FUNCTIONS).length).toBeGreaterThan(0);
        expect(Object.entries(registry({ a: 1 }))).toEqual([['a', 1]]);
    });

    it('answers signature help for a function name that is an inherited member', () => {
        // A modder can type this, and the lookup used to hand back Object, whose arity is undefined.
        expect(mathFunction('constructor')).toBeUndefined();
        expect(computeSignatureHelp('X = constructor(', 16)).toBeNull();
    });
});
