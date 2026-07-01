import { SignatureHelp, SignatureInformation } from 'vscode-languageserver';
import { HLSL_INTRINSICS } from './shader-intrinsics';
import { parseShaderSignatures } from './shader-parser';
import { activeCallAt } from '../signature/signature-help.service';

/** Wraps a signature and the argument being typed into an LSP `SignatureHelp` with the active slot lit. */
const help = (signature: SignatureInformation, activeParameter: number, paramCount: number): SignatureHelp => ({
    signatures: [signature],
    activeSignature: 0,
    // Clamp to the last slot so an over-typed call keeps the final parameter lit rather than nothing.
    activeParameter: paramCount > 0 ? Math.max(0, Math.min(activeParameter, paramCount - 1)) : 0,
});

/**
 * Signature help for an open `.shader` file. When the cursor sits inside the parentheses of a call it
 * shows that function's parameter list and highlights the argument being typed — for both HLSL
 * intrinsics (`lerp(`, `clamp(`, …) and the functions the shader or its `#include` chain defines
 * (`loadRawNormals(uv, scale)`). The enclosing call and active argument are found by the same raw-text
 * paren scan the `.rules` signature help uses, so it works mid-edit before the code is complete.
 *
 * @param text the full shader source.
 * @param offset the cursor byte offset.
 * @param includeText the concatenated text of the file's `#include` chain, so a function defined in a
 * base shader gets signature help too. Empty when the file has no includes.
 * @returns the signature help, or null when the cursor is not inside a known call.
 */
export const shaderSignatureHelp = (text: string, offset: number, includeText = ''): SignatureHelp | null => {
    const active = activeCallAt(text, offset);
    if (!active) return null;

    const intrinsic = HLSL_INTRINSICS[active.name];
    if (intrinsic) {
        return help(
            {
                label: `${active.name}(${intrinsic.params.join(', ')})`,
                documentation: intrinsic.doc,
                parameters: intrinsic.params.map((p) => ({ label: p })),
            },
            active.activeParameter,
            intrinsic.params.length
        );
    }

    // A function the shader or one of its includes defines — show its real return type and typed params.
    const scope = includeText ? `${text}\n${includeText}` : text;
    const signature = parseShaderSignatures(scope).find((s) => s.name === active.name);
    if (!signature) return null;
    const paramLabels = signature.params.map((p) => `${p.type} ${p.name}`);
    return help(
        {
            label: `${signature.returnType} ${signature.name}(${paramLabels.join(', ')})`,
            documentation: 'A function defined in this shader or an include.',
            parameters: paramLabels.map((p) => ({ label: p })),
        },
        active.activeParameter,
        paramLabels.length
    );
};
