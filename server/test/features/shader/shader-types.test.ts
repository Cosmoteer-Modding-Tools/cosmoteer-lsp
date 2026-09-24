import { describe, expect, it } from 'vitest';
import { SymbolKind } from 'vscode-languageserver';
import { parseShaderTypes } from '../../../src/features/shader/shader-parser';
import { shaderCompletions } from '../../../src/features/shader/shader-completion';
import {
    shaderDocumentHover,
    shaderDocumentSymbols,
    shaderSymbolDefinition,
} from '../../../src/features/shader/shader-document-features';

// A base shader in the shape the game's own bases have: optional channels behind `#ifdef` guards, one
// unconditional member declared after such a block, and a pair of mutually exclusive `#else` branches.
const BASE = [
    'struct VERT_OUTPUT_PARTICLE',
    '{',
    '    float4 location : SV_POSITION;',
    '',
    '#ifdef ENABLE_TANGENT',
    '    float4 tangent : TANGENT0;',
    '#endif',
    '',
    '    float4 color : COLOR0;',
    '',
    '#ifndef DISABLE_ANIMATION',
    '    float2 animUv : TEXCOORD1;',
    '#else',
    '    float2 uv : TEXCOORD0;',
    '#endif',
    '};',
    '',
    'typedef float4 PIX_OUTPUT;',
    'static const float PI = 3.14159265f;',
].join('\n');

const ENTRY = ['#define ENABLE_TANGENT', '#include "base.shader"', 'PIX_OUTPUT pix(in VERT_OUTPUT_PARTICLE input)', '{', '    return input.;', '}'].join(
    '\n'
);

/** Completion items after the `.` of the `input.` access in `ENTRY`, resolved against `BASE`. */
const memberItems = () => shaderCompletions(ENTRY, ENTRY.indexOf('input.') + 'input.'.length, BASE);

describe('struct member scanning', () => {
    it('keeps every member declared after a preprocessor line', () => {
        const struct = parseShaderTypes(BASE).structs[0];
        expect(struct.members.map((m) => m.name)).toEqual(['location', 'tangent', 'color', 'animUv', 'uv']);
    });

    it('records the guard each member sits behind, with an else branch inverted', () => {
        const byName = new Map(parseShaderTypes(BASE).structs[0].members.map((m) => [m.name, m.guards]));
        expect(byName.get('location')).toEqual([]);
        expect(byName.get('color')).toEqual([]);
        expect(byName.get('tangent')).toEqual([{ macro: 'ENABLE_TANGENT', negated: false }]);
        expect(byName.get('animUv')).toEqual([{ macro: 'DISABLE_ANIMATION', negated: true }]);
        expect(byName.get('uv')).toEqual([{ macro: 'DISABLE_ANIMATION', negated: false }]);
    });

    it('reads typedef aliases and static constants at file scope', () => {
        const types = parseShaderTypes(BASE);
        expect(types.typeAliases).toEqual([
            { name: 'PIX_OUTPUT', aliasedType: 'float4', position: { line: 17, column: 15 } },
        ]);
        expect(types.staticConstants[0]).toMatchObject({ name: 'PI', hlslType: 'float', value: '3.14159265f' });
    });

    it('does not take a local declaration inside a function for a file-scope constant', () => {
        const src = 'float4 pix() {\n    static const float local = 1.0;\n    return local;\n}';
        expect(parseShaderTypes(src).staticConstants).toEqual([]);
    });
});

describe('struct member completion', () => {
    it('offers the members that follow a preprocessor line, not only the ones above it', () => {
        expect(memberItems().map((c) => c.label)).toEqual(['location', 'tangent', 'color', 'animUv', 'uv']);
    });

    it('ranks a member this shader has switched on above one it has not', () => {
        const items = memberItems();
        const sortOf = (name: string): string => items.find((c) => c.label === name)!.sortText!;
        // ENABLE_TANGENT is defined above the include, DISABLE_ANIMATION is not.
        expect(sortOf('tangent') < sortOf('uv')).toBe(true);
        expect(sortOf('location') < sortOf('uv')).toBe(true);
    });

    it('names the macro a guarded member needs, and says nothing for an unguarded one', () => {
        const items = memberItems();
        const docOf = (name: string): string => String(items.find((c) => c.label === name)!.documentation);
        expect(docOf('uv')).toContain('`DISABLE_ANIMATION` is defined');
        expect(docOf('uv')).toContain('write the matching `#define`');
        expect(docOf('tangent')).toContain('`ENABLE_TANGENT` is defined');
        expect(docOf('tangent')).not.toContain('write the matching `#define`');
        expect(docOf('color')).toBe('Struct member of `VERT_OUTPUT_PARTICLE`, of type `float4`.');
    });
});

describe('declared types and constants as symbols', () => {
    it('offers the struct, the alias and the constant in the global completion set', () => {
        const labels = shaderCompletions(ENTRY, ENTRY.indexOf('    return') + 4, BASE).map((c) => c.label);
        expect(labels).toContain('VERT_OUTPUT_PARTICLE');
        expect(labels).toContain('PIX_OUTPUT');
        expect(labels).toContain('PI');
    });

    it('hovers a struct with its members and marks the ones this shader does not compile', () => {
        const hover = shaderDocumentHover(ENTRY, ENTRY.indexOf('VERT_OUTPUT_PARTICLE input') + 2, BASE);
        const value = (hover!.contents as { value: string }).value;
        expect(value).toContain('float4 tangent;');
        expect(value).toContain('float2 uv; // guarded by DISABLE_ANIMATION, not defined here');
        expect(value).toContain('float4 color;');
    });

    it('hovers a typedef alias and a static constant', () => {
        const alias = shaderDocumentHover(ENTRY, ENTRY.indexOf('PIX_OUTPUT pix') + 2, BASE);
        expect((alias!.contents as { value: string }).value).toContain('typedef float4 PIX_OUTPUT;');
        const constant = shaderDocumentHover('float f() { return PI; }', 20, BASE);
        expect((constant!.contents as { value: string }).value).toContain('static const float PI = 3.14159265f');
    });

    it('still answers nothing on an ordinary local', () => {
        expect(shaderDocumentHover(ENTRY, ENTRY.indexOf('input)') + 1, BASE)).toBeNull();
    });

    it('lists the struct, the alias and the constant in the outline', () => {
        const byName = new Map(shaderDocumentSymbols(BASE).map((s) => [s.name, s]));
        expect(byName.get('VERT_OUTPUT_PARTICLE')?.kind).toBe(SymbolKind.Struct);
        expect(byName.get('PIX_OUTPUT')?.detail).toBe('float4');
        expect(byName.get('PI')?.kind).toBe(SymbolKind.Constant);
    });

    it('resolves a type name under the cursor to its declaration in the include chain', async () => {
        const files: Record<string, string> = { 'base.shader': BASE };
        const override = (p: string): string | undefined => files[p.split('\\').join('/').split('/').pop() ?? ''];
        const struct = await shaderSymbolDefinition(
            ENTRY,
            ENTRY.indexOf('VERT_OUTPUT_PARTICLE input') + 2,
            'file:///c:/proj/main.shader',
            'C:/data',
            override
        );
        expect(struct?.uri).toContain('base.shader');
        expect(struct?.range.start.line).toBe(0);
        const alias = await shaderSymbolDefinition(
            ENTRY,
            ENTRY.indexOf('PIX_OUTPUT pix') + 2,
            'file:///c:/proj/main.shader',
            'C:/data',
            override
        );
        expect(alias?.range.start.line).toBe(17);
    });

    it('returns null for a name the chain does not declare', async () => {
        expect(
            await shaderSymbolDefinition(ENTRY, ENTRY.indexOf('input.') + 1, 'file:///c:/proj/main.shader', 'C:/data')
        ).toBeNull();
    });
});
