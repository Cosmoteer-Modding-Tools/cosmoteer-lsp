import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { acceptsShaderConstants } from '../../document/schema/schema';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { resolveAssetPath } from '../navigation/asset-resolver';
import { allShaderUniformNames, shaderConstants } from '../shader/shader-index';
import { ShaderConstantKind } from '../shader/shader-parser';
import { materialConstants, materialShaderNode } from '../shader/shader-reference';
import { closestMatch } from '../../utils/did-you-mean';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * Validates the inline `_`-prefixed shader constants a material sets against the `.shader` it
 * references: flags a constant the shader declares no uniform for (a typo such as `_hotColr`), and a
 * constant whose value is the wrong shape for its declared type (a scalar uniform given a list, or a
 * colour given a boolean).
 *
 * It is conservative by construction so it stays false-positive-free. A group is only checked when its
 * shader resolves on disk (otherwise the constant names are unknown and nothing is flagged), the name
 * set used is the full set of declared uniforms including the engine-bound ones (writing one is
 * pointless but not an error), and the type check only flags structural mismatches a lenient
 * deserializer could not accept, never an ambiguous string or reference that might resolve to a number.
 */

/**
 * Dead constant keys the game itself ships: vanilla materials set them, but the referenced shaders
 * declare no uniform for them, so the engine silently drops them. Flagging one is technically correct
 * but useless noise on shipping data (and on the many mods that copy vanilla materials), so they are
 * skipped. The vanilla FP-scan test pins this set: a new dead key the game ships shows up there.
 */
const VANILLA_DEAD_KEYS: ReadonlySet<string> = new Set([
    '_color3',
    '_color4',
    '_color5',
    '_colorTexture',
    '_noiseTex2',
    '_rampTexture',
    '_sizePulseFactor',
    '_sizePulseInterval',
    '_sizePulseUOffsetFactor',
]);

/** Yields every material group (one that accepts shader constants) in a document. */
function* materialGroupsOf(document: AbstractNodeDocument): Generator<GroupNode> {
    const visit = function* (node: AbstractNode): Generator<GroupNode> {
        if (isGroupNode(node)) {
            const cls = resolveGroupClass(node);
            if (cls && acceptsShaderConstants(cls)) yield node;
        }
        if (isGroupNode(node) || isListNode(node)) {
            for (const child of node.elements) yield* visit(child);
        } else if (isAssignmentNode(node) && node.right) {
            yield* visit(node.right);
        }
    };
    for (const element of document.elements) yield* visit(element);
}

/**
 * Whether a value node is structurally wrong for a constant's declared kind. Only gross, unambiguous
 * mismatches are reported: a scalar uniform written as a list or group, or any uniform written as a
 * boolean. Numbers, references, math, function calls and (for vectors) lists and colour groups are all
 * accepted, since a value that could resolve to the right type must never be flagged.
 *
 * @param kind the declared kind of the shader constant.
 * @param value the value node the material assigns it.
 * @returns a short description of the expected shape when the value is wrong, else null.
 */
const typeMismatch = (kind: ShaderConstantKind, value: AbstractNode): string | null => {
    const isBoolean = isValueNode(value) && value.valueType.type === 'Boolean';
    const isScalar = kind === 'float' || kind === 'int';
    if (isScalar) {
        if (isBoolean) return l10n.t('a number');
        if (isListNode(value) || isGroupNode(value)) return l10n.t('a number');
    }
    if ((kind === 'vec2' || kind === 'vec3' || kind === 'vec4') && isBoolean) {
        return l10n.t('a list of numbers');
    }
    return null;
};

/**
 * Validates the inline shader constants of every material in a document.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the asset and shader resolution.
 * @returns one error per unknown constant name and per structural type mismatch.
 */
export const validateShaderConstants = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];

    const errors: ValidationError[] = [];
    const dataDir = CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath;

    for (const group of materialGroupsOf(document)) {
        if (cancellationToken.isCancellationRequested) return errors;
        const constants = materialConstants(group);
        if (constants.length === 0) continue;

        const shaderNode = materialShaderNode(group);
        if (!shaderNode) continue;
        const shaderPath = await resolveAssetPath(shaderNode, document.uri, cancellationToken).catch(() => null);
        if (!shaderPath) continue; // shader not found, the names cannot be judged

        const names = await allShaderUniformNames(shaderPath, dataDir).catch(() => null);
        if (!names || names.size === 0) continue; // unreadable or empty, no coverage to judge against
        const settable = await shaderConstants(shaderPath, dataDir).catch(() => []);
        const kinds = new Map(settable.map((constant) => [constant.name, constant.kind]));

        for (const constant of constants) {
            if (VANILLA_DEAD_KEYS.has(constant.name)) continue;
            if (!names.has(constant.name)) {
                const suggestion = closestMatch(constant.name, [...names], true);
                errors.push({
                    message: l10n.t(
                        "Unknown shader constant '{0}'. The shader '{1}' declares no such uniform.",
                        constant.name,
                        String(shaderNode.valueType.value)
                    ),
                    node: constant.key,
                    severity: 'warning',
                    ...(suggestion
                        ? { data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } } }
                        : {}),
                });
                continue;
            }
            const kind = kinds.get(constant.name);
            const expected = kind ? typeMismatch(kind, constant.value) : null;
            if (expected) {
                errors.push({
                    message: l10n.t("Shader constant '{0}' expects {1}.", constant.name, expected),
                    node: constant.value,
                    severity: 'warning',
                });
            }
        }
    }
    return errors;
};
