import { SemanticTokensLegend } from 'vscode-languageserver';

/**
 * The shared semantic-token legend for both document kinds the server highlights (`.rules` and
 * `.shader`). One LSP `semanticTokensProvider` capability carries a single legend, so both token
 * builders encode against these same index arrays.
 *
 * Order is the contract. The client maps a token's integer back to a name by index, so entries may
 * only be appended, never reordered or removed.
 */
export const TOKEN_TYPES = [
    'type', // a top-level entity / inheritance base (.rules), an HLSL type (.shader)
    'property', // a `Key =` field name (.rules)
    'function', // a math function (.rules), a shader function (.shader)
    'variable', // a `&…` reference (.rules), a `_uniform` / identifier (.shader)
    'enumMember', // an unquoted bareword value (.rules)
    'number', // a numeric literal
    'string', // a quoted string / asset path
    'keyword', // a boolean (.rules), an HLSL keyword/qualifier (.shader)
    'operator', // a math operator (.rules)
    'macro', // a preprocessor directive (.shader)
] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];

export const TOKEN_MODIFIERS = [
    'declaration', // a defining occurrence (entity name / uniform declaration)
    'defaultLibrary', // a built-in (math function / engine-provided shader symbol)
] as const;

export type TokenModifier = (typeof TOKEN_MODIFIERS)[number];

export const typeIndex = (type: TokenType): number => TOKEN_TYPES.indexOf(type);
export const modifierBit = (modifier: TokenModifier): number => 1 << TOKEN_MODIFIERS.indexOf(modifier);

/** The legend advertised in the server's `semanticTokensProvider` capability. */
export const semanticTokensLegend: SemanticTokensLegend = {
    tokenTypes: [...TOKEN_TYPES],
    tokenModifiers: [...TOKEN_MODIFIERS],
};
