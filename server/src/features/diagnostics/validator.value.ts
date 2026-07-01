import { CancellationToken } from 'vscode-languageserver';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { resolveAssetPath, suggestAssetFilename } from '../navigation/asset-resolver';
import { suggestReferenceName } from '../navigation/reference-suggestion';
import {
    AbstractNode,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { FileTree, isFile } from '../../workspace/cosmoteer-workspace.service';
import { globalSettings } from '../../settings';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { isValidReference } from '../../utils/reference.utils';
import { isModRules } from '../../document/document-kind';
import { Validation } from './validator';
import { extractSubstrings } from '../navigation/navigation-strategy';
import { TARGET_FIELDS } from '../../mod/action';
import { findModRoot } from '../../mod/mod-root';
import { resolveFromModContextOnly } from '../../mod/mod-context';
import { isStringsFile } from '../../mod/strings-folder';
import * as l10n from '@vscode/l10n';

const rulesNavigationStrategy = new FullNavigationStrategy();

export const ValidationForValue: Validation<ValueNode> = {
    type: 'Value',
    callback: async (node: ValueNode, cancellationToken) => {
        if (node.valueType.type === 'Reference') {
            return await checkReference(node, cancellationToken);
        }
        if (node.valueType.type === 'Sprite' || node.valueType.type === 'Sound' || node.valueType.type === 'Shader') {
            return await checkAssets(node, cancellationToken);
        }
        return checkParantheses(node);
    },
};

const checkParantheses = (node: ValueNode) => {
    if (node.valueType.type !== 'Number' && node.valueType.type !== 'Reference' && node.parenthesized) {
        return {
            message: l10n.t('Value should not be parenthesized'),
            node: node,
            additionalInfo: l10n.t('References in function calls need to be parenthesized or math expressions'),
        };
    }
    return undefined;
};

const checkAssets = async (node: ValueNode, cancellationToken: CancellationToken) => {
    if (node.valueType.type === 'Shader' || node.valueType.type === 'Sound' || node.valueType.type === 'Sprite') {
        // Language-strings files (`en.rules`, …) hold localization TEXT: a value like
        // `"PNG image files (*.png)"` or a description mentioning `.ship.png` merely CONTAINS an
        // asset-like extension, it is not an asset path. The game never resolves these — skip the
        // asset check so strings files don't show false "Asset not found" warnings.
        if (await isStringsFile(getStartOfAstNode(node).uri, cancellationToken)) return undefined;
        // ObjectText (and the game) load unquoted asset paths fine, vanilla is full of them
        // (`File = debris.png`). Only a path containing whitespace is genuinely ambiguous unquoted
        // (ObjectText joins whitespace-separated tokens with a single space), so flag just those,
        // and as a warning rather than a hard error.
        if (!node.quoted && /\s/.test(String(node.valueType.value))) {
            const value = String(node.valueType.value);
            return {
                message: l10n.t('Asset paths should be quoted'),
                node: node,
                additionalInfo: l10n.t('Assets should be quoted with ""'),
                severity: 'warning',
                data: { quickFix: { title: l10n.t('Wrap in quotes'), newText: `"${value}"` } },
            };
        }
        const uri = getStartOfAstNode(node).uri;
        // Resolution tries the file's own directory first, then any inherited asset base
        // directory — e.g. `CrewEnterEffects : /BASE_SOUNDS/AudioInterior` makes the
        // RandomSounds paths relative to the inherited base sound file's directory
        // (mirrored into the mod tree).
        if (await resolveAssetPath(node, uri, cancellationToken).catch(() => true)) {
            return undefined;
        }
        // Not found — offer a "did you mean" suggestion (closest existing file of this kind in
        // the same directories) as both extra info and a quick fix.
        const suggestion = await suggestAssetFilename(node, uri, cancellationToken).catch(() => null);
        const base = l10n.t(
            'The asset "{0}" could not be found, relative to this file or any inherited asset base',
            String(node.valueType.value)
        );
        return {
            message: l10n.t('Asset not found'),
            node: node,
            // The game tolerates a missing asset at load time (placeholder/built-in — vanilla itself
            // references engine-provided files like `SmoothFalloffRamp.png` that aren't on disk), so
            // surface this as a warning + quick-fix rather than a hard error.
            severity: 'warning',
            additionalInfo: suggestion ? `${base} ${l10n.t('Did you mean "{0}"?', suggestion)}` : base,
            data: suggestion
                ? { quickFix: { title: l10n.t('Change to "{0}"', suggestion), newText: suggestion } }
                : undefined,
        };
    }
};

const checkReference = async (node: ValueNode, cancellationToken: CancellationToken) => {
    if (node.valueType.type === 'Reference' && node.valueType.value.length > 1) {
        const uri = getStartOfAstNode(node).uri;
        if (!isValidReference(node.valueType.value)) {
            return {
                message: l10n.t('Reference is not valid'),
                node: node,
                additionalInfo: l10n.t(
                    'References can be in the following formats: <>, .., ~, /, ^, &<>, &.., &~, &/, &A-Z'
                ),
            };
        } else if (
            // mod.rules action targets resolve against the game root (handled by the
            // mod-action validator), so the generic check skips only those. mod.rules
            // source refs are validated here like any other reference.
            !(isModRules(uri) && isModActionTargetNode(node)) &&
            !ignorePath(node.valueType.value) &&
            // `~` rooted references into a context the static file does not define are
            // resolved at runtime (template/library groups), so skip them.
            !isRuntimeRootReference(node)
        ) {
            const startNode = isInheritanceInSameFile(node)
                ? ((node.parent as AbstractNode).parent as AbstractNode)
                : node;
            const resolved = await rulesNavigationStrategy
                .navigate(node.valueType.value, startNode, uri, cancellationToken)
                .catch(() => undefined);
            // Not found in vanilla data — fall back to the mod's own additions (the effective
            // game tree), so mod-added globals like `&/SW_SOUNDS/…` resolve anywhere inside the
            // mod. Uses the mod-context-only resolver since vanilla already failed above.
            const modResolved =
                resolved === null && findModRoot(uri)
                    ? await resolveFromModContextOnly(node.valueType.value, startNode, cancellationToken).catch(
                          () => undefined
                      )
                    : resolved;
            if (
                resolved === null &&
                (modResolved === null || modResolved === undefined) &&
                // `X : ^/0/X [extra]` may extend a base that doesn't define `X` — Cosmoteer
                // tolerates inheriting from a missing base member.
                !(await inheritanceExtendsMissingMember(node, startNode, uri, cancellationToken))
            ) {
                const suggestion = await suggestReferenceName(
                    node,
                    startNode,
                    uri,
                    rulesNavigationStrategy,
                    cancellationToken
                ).catch(() => null);
                const base = l10n.t(
                    'You either reference a non-existing identifier or an identifier that is not in scope'
                );
                return {
                    message: l10n.t('Reference name is not known'),
                    node: node,
                    // The game tolerates an unresolved reference at load time (it simply contributes
                    // nothing. Vanilla even ships dangling refs like `&<Overlays/overlays.rules>`),
                    // so surface this as a warning + quick-fix rather than a hard error.
                    severity: 'warning',
                    additionalInfo: suggestion
                        ? `${base} ${l10n.t('Did you mean "{0}"?', suggestion.suggestion)}`
                        : base,
                    data: suggestion
                        ? {
                              quickFix: {
                                  title: l10n.t('Change to "{0}"', suggestion.suggestion),
                                  newText: suggestion.correctedValue,
                              },
                          }
                        : undefined,
                };
            }
        }
    }
    return undefined;
};

/**
 * True if `node` is a mod-action target value (`AddTo`/`OverrideIn`/`Replace`/`Remove`/
 * `AddBaseTo = "<...>"`, or an element of a `RemoveMany [ ... ]` list). A ValueNode's
 * parent is its containing group/list, so we match by the owning field name.
 */
const isModActionTargetNode = (node: ValueNode): boolean => {
    const parent = node.parent;
    if (!parent) return false;
    if (isListNode(parent)) return !!parent.identifier && TARGET_FIELDS.has(parent.identifier.name);
    if (isGroupNode(parent)) {
        return parent.elements.some(
            (element) => isAssignmentNode(element) && element.right === node && TARGET_FIELDS.has(element.left.name)
        );
    }
    return false;
};

/**
 * True for an inheritance reference (`X : ^/0/X [...]`) whose base prefix resolves to a
 * real group/list but whose final member does not exist. Cosmoteer allows inheriting
 * from a base that doesn't define that member (it just contributes nothing), so this is
 * not an error. Only genuine inheritance refs whose base is missing are flagged.
 */
const inheritanceExtendsMissingMember = async (
    node: ValueNode,
    startNode: AbstractNode,
    uri: string,
    cancellationToken: CancellationToken
): Promise<boolean> => {
    const parent = node.parent;
    if (!parent || !(isListNode(parent) || isGroupNode(parent)) || !parent.inheritance?.includes(node)) return false;
    const value = String(node.valueType.value);
    const segments = extractSubstrings(value);

    // `X : ^/<N>/X [extra]` the extend-my-own-member idiom, is valid as long as the
    // container's Nth inheritance slot exists, even if the base it points at doesn't define
    // `X`, and even if the slot is itself another extend (a "virtual" base). We require the
    // final segment to equal the inheriting member's own name so a typo (`^/0/Xtypo`) or an
    // unrelated missing member is still flagged. `^` is the container (node.parent.parent).
    if (segments.length >= 3 && segments[0] === '^' && /^\d+$/.test(segments[1])) {
        const container = node.parent?.parent;
        return (
            segments[segments.length - 1] === parent.identifier?.name &&
            !!container &&
            (isGroupNode(container) || isListNode(container)) &&
            !!container.inheritance?.[Number(segments[1])]
        );
    }

    // Other inheritance forms: skip if the base prefix (everything before the last segment)
    // resolves to a real container — the member is just absent on an existing base.
    const lastSlash = value.lastIndexOf('/');
    if (lastSlash <= 0) return false;
    let base = await rulesNavigationStrategy
        .navigate(value.slice(0, lastSlash), startNode, uri, cancellationToken)
        .catch(() => null);
    if (base && isValueNode(base as AbstractNode) && (base as ValueNode).valueType.type === 'Reference') {
        base = await rulesNavigationStrategy
            .navigate(
                String((base as ValueNode).valueType.value),
                base as AbstractNode,
                getStartOfAstNode(base as AbstractNode).uri,
                cancellationToken
            )
            .catch(() => null);
    }
    if (!base || typeof base !== 'object') return false;
    // The base prefix may be a group/list, but also a whole FILE the base member lives in (the
    // cross-file extend-own-member idiom `X : <base.rules>/X`, e.g. terran.rules `Fire :
    // <../base_ship.rules>/Fire`): `<file>` resolves to that file's Document (or, for the data-root
    // form, the File itself). Any of these means the base exists and the missing member is tolerated.
    return (
        isGroupNode(base as AbstractNode) ||
        isListNode(base as AbstractNode) ||
        isDocumentNode(base as AbstractNode) ||
        isFile(base as unknown as FileTree)
    );
};

/**
 * Whether a reference is `~`-rooted (`~/…` or `&~/…`). `~` denotes the runtime root of wherever the
 * rule is instantiated, which is not knowable from the static file: a template/library group (e.g. a
 * shared sound inherited into a weapon part, `&~/EMITTER/BeamCount`) reaches members of its consuming
 * part, and parts reach runtime-assembled subtrees (`&~/Part/Components/BulletEmitterBase/Bullet/…`)
 * that simply do not exist statically. We therefore do not statically validate any `~`-rooted
 * reference. Flagging them produced hundreds of false positives on real mods, and the game resolves
 * them at instantiation regardless. (Trade-off: a typo inside a `~` path is no longer caught, but it
 * could never be told apart from a legitimate runtime member.)
 */
const isRuntimeRootReference = (node: ValueNode): boolean => {
    const value = node.valueType.value;
    if (typeof value !== 'string') return false;
    const withoutAmpersand = value.startsWith('&') ? value.substring(1) : value;
    return withoutAmpersand.startsWith('~');
};

const isInheritanceInSameFile = (value: ValueNode) => {
    return (
        value.valueType.type === 'Reference' &&
        value.valueType.value.startsWith('..') &&
        value.parent &&
        (isListNode(value.parent) || isGroupNode(value.parent)) &&
        value.parent.inheritance &&
        value.parent.inheritance.some((inheritance) => inheritance === value)
    );
};

const ignorePath = (value: string) => {
    for (const path of globalSettings.ignorePaths) {
        if (value.toLowerCase().includes(path.toLowerCase())) {
            return true;
        }
    }
    return false;
};
