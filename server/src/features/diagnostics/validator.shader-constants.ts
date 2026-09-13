import * as path from 'path';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { warmInheritedClasses } from '../completion/inheritance-resolution';
import { inheritanceBaseLeafName } from '../../utils/reference.utils';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { acceptsShaderConstants } from '../../document/schema/schema';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { cachedDirLookup } from '../../workspace/fs-cache';
import { resolveAssetPath } from '../navigation/asset-resolver';
import { allShaderUniformNames, shaderConstants } from '../shader/shader-index';
import { ShaderConstantKind } from '../shader/shader-parser.types';
import { materialConstants, materialShaderNode } from '../shader/shader-reference';
import { closestMatch } from '../../utils/did-you-mean';
import { didYouMeanFix, ValidationError } from './validator';
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

/**
 * The on-disk sibling variants of a shader family: for `X_diffuse.shader` or `X_normals.shader`
 * the plain `X.shader` plus the other variant, and for a plain `X.shader` its two variants.
 * Candidates are matched against the shader's cached directory listing, case-insensitively so a
 * mod's freely-cased variant (`Laser_Normals.shader`) is found on a case-sensitive filesystem,
 * and the actual on-disk paths of the variants present are returned.
 *
 * @param shaderPath the resolved filesystem path of the material's shader.
 * @returns the sibling variant paths, possibly empty.
 */
export const shaderVariantSiblings = async (shaderPath: string): Promise<string[]> => {
    const fileName = path.basename(shaderPath);
    const match = /^(.*?)(_diffuse|_normals)?\.shader$/i.exec(fileName);
    if (!match) return [];
    const base = match[1];
    const dir = path.dirname(shaderPath);
    const lookup = await cachedDirLookup(dir).catch(() => null);
    if (!lookup) return [];
    const siblings: string[] = [];
    for (const suffix of ['', '_diffuse', '_normals']) {
        const candidate = `${base}${suffix}.shader`.toLowerCase();
        if (candidate === fileName.toLowerCase()) continue;
        const actual = lookup.get(candidate);
        if (actual) siblings.push(path.join(dir, actual));
    }
    return siblings;
};

/**
 * The shader each group in a document points at, keyed by the lower-cased leaf name of the base it
 * derives from. A sprite family splits the two halves apart: vanilla's `MainSprite` writes
 * `_highlightTime` and `_clickTime` while the shader that declares them is on `HighlightSprite :
 * MainSprite`, which the engine builds from the same constant block. So a constant any deriver's
 * shader declares is meaningful on the base too.
 *
 * @param document the parsed document to scan.
 * @returns the derivers' shader value nodes, keyed by the lower-cased base name.
 */
const derivedShadersByBase = (document: AbstractNodeDocument): Map<string, ValueNode[]> => {
    const byBase = new Map<string, ValueNode[]>();
    const visit = (node: AbstractNode): void => {
        if (isGroupNode(node)) {
            const shader = materialShaderNode(node);
            for (const reference of shader ? (node.inheritance ?? []) : []) {
                if (!isValueNode(reference) || reference.valueType.type !== 'Reference') continue;
                const leaf = inheritanceBaseLeafName(String(reference.valueType.value));
                if (!leaf) continue;
                const list = byBase.get(leaf.toLowerCase());
                if (list) list.push(shader!);
                else byBase.set(leaf.toLowerCase(), [shader!]);
            }
        }
        if (isGroupNode(node) || isListNode(node)) {
            for (const child of node.elements) visit(child);
        } else if (isAssignmentNode(node) && node.right) {
            visit(node.right);
        }
    };
    for (const element of document.elements) visit(element);
    return byBase;
};

/**
 * Yields every material group (one that accepts shader constants) in a document. Exported so the
 * whole-vanilla test can assert the scan actually reached materials rather than passing on an empty set.
 *
 * @param document the parsed document to walk.
 * @returns each group whose schema class accepts inline shader constants.
 */
export function* materialGroupsOf(document: AbstractNodeDocument): Generator<GroupNode> {
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
    // `materialGroupsOf` classifies groups synchronously, which sees nothing for a group deriving from
    // a base in another file until the cross-file walk has run. Without this the check silently passed
    // over whole documents wherever the caller had not warmed them first.
    await warmInheritedClasses(document, cancellationToken).catch(() => undefined);
    const derivedShaders = derivedShadersByBase(document);

    for (const group of materialGroupsOf(document)) {
        if (cancellationToken.isCancellationRequested) return errors;
        const constants = materialConstants(group);
        if (constants.length === 0) continue;

        const shaderNode = materialShaderNode(group);
        if (!shaderNode) continue;
        const shaderPath = await resolveAssetPath(shaderNode, document.uri, cancellationToken).catch(() => null);
        if (!shaderPath) continue; // shader not found, the names cannot be judged

        const declared = await allShaderUniformNames(shaderPath, dataDir).catch(() => null);
        if (!declared || declared.size === 0) continue; // unreadable or empty, no coverage to judge against
        // A split-pass material names one variant of a shader family (`X_diffuse.shader` beside
        // `X.shader` / `X_normals.shader`) while its constants target the family: vanilla's
        // construction materials set `_hotColor` on the `_diffuse` variant, declared only by the
        // plain sibling. A constant any sibling variant declares is meaningful, so their uniform
        // names join the accepted set (the named shader alone still drives the type check).
        const names = new Set(declared);
        for (const sibling of await shaderVariantSiblings(shaderPath)) {
            const siblingNames = await allShaderUniformNames(sibling, dataDir).catch(() => null);
            for (const name of siblingNames ?? []) names.add(name);
        }
        const settable = await shaderConstants(shaderPath, dataDir).catch(() => []);
        const kinds = new Map(settable.map((constant) => [constant.name, constant.kind]));
        // The derivers' shaders are only read when a name is about to be reported, so the common
        // material (no derivers, every constant known) still reads exactly one shader.
        let derivedRead = false;
        const readDerivedShaders = async (): Promise<void> => {
            derivedRead = true;
            for (const derivedShader of derivedShaders.get(group.identifier?.name.toLowerCase() ?? '') ?? []) {
                const derivedPath = await resolveAssetPath(derivedShader, document.uri, cancellationToken).catch(
                    () => null
                );
                const derivedNames = derivedPath
                    ? await allShaderUniformNames(derivedPath, dataDir).catch(() => null)
                    : null;
                for (const name of derivedNames ?? []) names.add(name);
            }
        };

        for (const constant of constants) {
            if (VANILLA_DEAD_KEYS.has(constant.name)) continue;
            if (!names.has(constant.name) && !derivedRead) await readDerivedShaders();
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
                    ...didYouMeanFix(suggestion),
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
