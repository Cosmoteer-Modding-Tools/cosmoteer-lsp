import { CancellationToken } from 'vscode-languageserver';
import { navigate } from '../../semantics/navigate-reference';
import { resolveAssetPath, suggestAssetFilename } from '../navigation/asset-resolver';
import { suggestReferenceName } from '../navigation/reference-suggestion';
import { aliasChainCycles } from '../navigation/explain-reference/reference-trace';
import { standaloneReferenceValue } from '../navigation/reference-nodes';
import {
    hasVirtualInheritanceSegment,
    inheritanceExtendsMissingMember,
    isInheritanceInSameFile,
    isRuntimeRootReference,
} from '../navigation/reference-shape';
import { AbstractNode, IdentifierNode, isAssignmentNode, isListNode, isGroupNode, ValueNode } from '../../core/ast/ast';
import { globalSettings } from '../../settings';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { isValidReference } from '../../utils/reference.utils';
import { didYouMeanFix, expressionOperands, Validation, ValidationError } from './validator';
import { isActionEntryGroup, isActionNameValueNode, isActionTargetValueNode, VERB_SCHEMA } from '../../mod/action';
import { findModRoot } from '../../mod/mod-root';
import { resolveFromModContextOnly } from '../../mod/mod-context';
import { isStringsFile } from '../../mod/strings-folder';
import { isIgnoredSchemaField } from './validator.ignored-field';
import { canonicalWorkshopEscape, intendedWorkshopEscape } from './workshop-escape';
import * as l10n from '@vscode/l10n';

export const ValidationForValue: Validation<ValueNode> = {
    type: 'Value',
    callback: async (node: ValueNode, cancellationToken) => {
        // An operand of an expression is judged on its reference alone. Everything else here reads
        // the value as a member of a list or a group, which an operand is not, and the shape of the
        // expression itself is the math validator's to judge.
        if (expressionOperands.has(node)) {
            return node.valueType.type === 'Reference' && !rootedInTheInheritanceList(node.valueType.value)
                ? await checkReference(node, cancellationToken)
                : undefined;
        }
        if (node.valueType.type === 'Reference') {
            return await checkReference(node, cancellationToken);
        }
        if (node.valueType.type === 'Sprite' || node.valueType.type === 'Sound' || node.valueType.type === 'Shader') {
            return await checkAssets(node, cancellationToken);
        }
        if (node.valueType.type === 'String' && !node.quoted) {
            const joinedWithBody = checkListNameJoinedWithBody(node, String(node.valueType.value));
            if (joinedWithBody) return joinedWithBody;
        }
        const missingSeparators = await checkListElementSeparators(node, cancellationToken);
        if (missingSeparators) return missingSeparators;
        return checkParantheses(node);
    },
};

export const ValidationForIdentifier: Validation<IdentifierNode> = {
    type: 'Identifier',
    callback: async (node: IdentifierNode, cancellationToken) => {
        const reference = await checkStandaloneReference(node, cancellationToken);
        if (reference) return reference;
        if (typeof node.name === 'string' && !node.name.startsWith('&')) {
            return checkListNameJoinedWithBody(node, node.name);
        }
        return undefined;
    },
};

/** The fields a mod action writes its new content in, one lower-cased set across every verb. */
const SOURCE_FIELDS = new Set(
    Object.values(VERB_SCHEMA).flatMap((verb) => verb.sources.map((field) => field.toLowerCase()))
);

/**
 * Whether a value is the content a mod action installs: the right-hand side of a source field
 * (`ToAdd`, `ManyToAdd`, `Overrides`, `With`, `BaseToAdd`) on an action entry, or one element of
 * such a field written as a list. The enclosing group has to be a real action entry, which is a
 * property of where the node sits rather than of the file it sits in, so an action list a manifest
 * includes from somewhere else answers the same way the manifest does.
 *
 * @param node the value to place.
 * @returns true when the value is an action's source.
 */
const isActionSourceValueNode = (node: AbstractNode): boolean => {
    const parent = node.parent;
    if (!parent) return false;
    if (isListNode(parent)) {
        const owner = parent.parent;
        return (
            !!parent.identifier &&
            SOURCE_FIELDS.has(parent.identifier.name.toLowerCase()) &&
            !!owner &&
            isGroupNode(owner) &&
            isActionEntryGroup(owner)
        );
    }
    return (
        isGroupNode(parent) &&
        isActionEntryGroup(parent) &&
        parent.elements.some(
            (element) =>
                isAssignmentNode(element) &&
                element.right === node &&
                SOURCE_FIELDS.has(element.left.name.toLowerCase())
        )
    );
};

// A path rooted in the node's own inheritance list (`(&^/0/MaxHealth) * 2`). Vanilla writes the
// idiom in 89 places and in every one of them the base it counts from is itself a relative path, a
// chain the resolver does not follow, so it answers "not found" for paths the game resolves. The
// idiom is written nowhere but in an operand, which is why it never showed before, and reporting it
// would put a warning on eleven files the game ships.
const INHERITANCE_LIST_ROOT = /(^|\/)\^($|\/)/;

/**
 * Whether a reference counts from the node's own inheritance list.
 *
 * @param written the reference as the author wrote it.
 * @returns true for a `^` rooted path.
 */
const rootedInTheInheritanceList = (written: string): boolean => INHERITANCE_LIST_ROOT.test(written.replace(/^&/, ''));

/**
 * Flags a list element name written on the same line as its `{`/`[` body (`Foo { X = 1 }`
 * inside a list). The game never names list children, and a listed value does not even stop at
 * `{`: it reads the WHOLE line as one text element, so neither the name nor the body exists in
 * game. Fires only when the very next sibling is an anonymous container opening on the same line.
 * Offers removing the name, which turns the line into a legal anonymous element.
 *
 * @param node the plain name element (a String value or an identifier, depending on how the parser classified it).
 * @param name the name's text, for the message and quick fix.
 * @returns a warning with a remove-the-name quick fix, or undefined when the shape is fine.
 */
const checkListNameJoinedWithBody = (node: ValueNode | IdentifierNode, name: string): ValidationError | undefined => {
    // A `,`/`;` after the name ends the element, so name and body are two legal elements
    // (`Toggles = [ IsOperational, { Toggle=… } ]`, everywhere in vanilla).
    if (node.delimiter) return undefined;
    const parent = node.parent;
    if (!parent || !isListNode(parent)) return undefined;
    const index = parent.elements.indexOf(node);
    if (index < 0 || index + 1 >= parent.elements.length) return undefined;
    const next = parent.elements[index + 1];
    if (!(isGroupNode(next) || isListNode(next)) || next.identifier) return undefined;
    if (next.position.line !== node.position.line) return undefined;
    return {
        message: l10n.t('The game reads this whole line as one text element'),
        node: node,
        severity: 'warning',
        additionalInfo: l10n.t(
            "In a list, a value runs to the end of the line and '{0}' does not end it, so '{1}' and the body become a single text element. List elements cannot have names; remove '{1}' to make this an anonymous element.",
            isGroupNode(next) ? '{' : '[',
            name
        ),
        data: { quickFix: { title: l10n.t("Remove '{0}'", name), newText: '' } },
    };
};

/**
 * Validates a bare `&…` reference standing alone as a list element (`&/PARTICLES/Foo` inside
 * `MediaEffects [ … ]`). The parser produces an IdentifierNode for such an element rather than
 * a ValueNode whenever the preceding sibling is not a value (e.g. right after a `}`), so the
 * regular value check never sees it. Runs the reference value it stands for through the shared
 * reference check, then re-anchors any finding on the real node. Group and document positions are
 * not checked here: the game rejects a bare reference there outright, which the parser reports as a
 * parse error.
 *
 * @param node the identifier to inspect.
 * @param cancellationToken cancels the cross file navigation.
 * @returns the reference finding, or undefined when the identifier is not a bare list reference or it resolves.
 */
const checkStandaloneReference = async (node: IdentifierNode, cancellationToken: CancellationToken) => {
    const wrapped = standaloneReferenceValue(node);
    if (!wrapped) return undefined;
    const error = await checkReference(wrapped, cancellationToken);
    return error ? { ...error, node } : undefined;
};

/**
 * Flags a list element that swallowed its numeric neighbors because the separators between them are
 * missing (`[1 2 3]`). ObjectText only ends a list element at `;`, `,`, a line break or `]`, so the
 * game reads the whole run as ONE string element. Only fires when every whitespace-separated part is
 * a number (optionally with a `%`/`d`/`r` expression suffix): a single string of numbers is never a
 * plausible intended element, while unquoted multi-word TEXT elements exist legitimately. Strings
 * files are exempt since their list values are localization text.
 *
 * @param node the value to inspect.
 * @param cancellationToken cancels the strings-folder lookup.
 * @returns a warning with an insert-separators quick-fix, or undefined when the value is fine.
 */
export const checkListElementSeparators = async (node: ValueNode, cancellationToken: CancellationToken) => {
    if (node.valueType.type !== 'String' || node.quoted) return undefined;
    const parent = node.parent;
    if (!parent || !isListNode(parent) || !parent.elements.includes(node)) return undefined;
    const parts = String(node.valueType.value).trim().split(/\s+/);
    if (parts.length < 2 || !parts.every((part) => /^[-+]?(\d+(\.\d*)?|\.\d+)[%dr]?$/.test(part))) return undefined;
    if (await isStringsFile(getStartOfAstNode(node).uri, cancellationToken)) return undefined;
    const separated = parts.join(', ');
    return {
        message: l10n.t('Missing separators between list elements'),
        node: node,
        severity: 'warning' as const,
        additionalInfo: l10n.t(
            'The game reads this as ONE element, "{0}". Separate the elements with "," or ";", or put each on its own line',
            String(node.valueType.value)
        ),
        data: { quickFix: { title: l10n.t("Change to '{0}'", separated), newText: separated } },
    };
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
        // Language-strings files (`en.rules`, …) hold localization text: a value like
        // `"PNG image files (*.png)"` or a description mentioning `.ship.png` merely contains an
        // asset-like extension, it is not an asset path. The game never resolves these. Skip the
        // asset check so strings files don't show false "Asset not found" warnings.
        if (await isStringsFile(getStartOfAstNode(node).uri, cancellationToken)) return undefined;
        // A mod action's `Name` is the key its entry is added under. A ship keyed
        // `Name = "Small Pirate Lootbox.ship.png"` names no file the game loads.
        if (isActionNameValueNode(node)) return undefined;
        // A field the game provably ignores (not in the resolved schema class, never referenced in
        // the file) never has its path resolved either. Vanilla's `Filename = SmoothFalloffRamp.png`
        // inside `Type = ValueCurve` updaters is dev-editor metadata, not a loaded asset.
        if (isIgnoredSchemaField(node)) return undefined;
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
        // The game combines the path with this file's own directory and looks nowhere else, so
        // a base inherited from another folder changes nothing about where the asset has to be.
        if (await resolveAssetPath(node, uri, cancellationToken).catch(() => true)) {
            return undefined;
        }
        // Not found. Offer a "did you mean" suggestion (closest existing file of this kind in
        // the same directories) as both extra info and a quick fix.
        const suggestion = await suggestAssetFilename(node, uri, cancellationToken).catch(() => null);
        const base = l10n.t('The asset "{0}" could not be found relative to this file', String(node.valueType.value));
        return {
            message: l10n.t('Asset not found'),
            node: node,
            // The game tolerates a missing asset at load time (placeholder/built-in: vanilla itself
            // references engine-provided files like `SmoothFalloffRamp.png` that aren't on disk), so
            // surface this as a warning + quick-fix rather than a hard error.
            severity: 'warning',
            additionalInfo: suggestion ? `${base} ${l10n.t('Did you mean "{0}"?', suggestion)}` : base,
            ...didYouMeanFix(suggestion),
        };
    }
};

/**
 * The finding for a reference that resolves nowhere: a workshop escape written from the wrong depth
 * whose game-root form does resolve, a chain that comes back to a link it has already been through,
 * or a name that is simply not known, with the nearest name offered as a fix.
 *
 * @param node the reference value.
 * @param written the reference path as the author wrote it.
 * @param startNode the node the path is resolved from.
 * @param uri the file the reference is written in.
 * @param cancellationToken cancels the resolution the suggestions need.
 * @returns the finding.
 */
const unresolvedReferenceFinding = async (
    node: ValueNode,
    written: string,
    startNode: AbstractNode,
    uri: string,
    cancellationToken: CancellationToken
): Promise<ValidationError> => {
    // A `<../../../workshop/...>` written from the wrong depth resolves nowhere, but
    // its intent is clear. When the game-root form of the same target resolves, offer
    // that rewrite instead of a name suggestion. Action targets are exempt even outside
    // mod.rules (manifests include action lists from other files): the game resolves
    // them against the Data root, where the bare `../` form is already correct.
    const rewrite = isActionTargetValueNode(node) ? null : intendedWorkshopEscape(written, uri);
    if (rewrite && (await navigate(rewrite, startNode, uri, cancellationToken).catch(() => null))) {
        return {
            message: l10n.t('Reference name is not known'),
            node: node,
            severity: 'warning',
            additionalInfo: l10n.t(
                'The relative path does not resolve from this file. "{0}" resolves from the game folder and works from any file.',
                rewrite
            ),
            data: { quickFix: { title: l10n.t("Change to '{0}'", rewrite), newText: rewrite } },
        };
    }
    // A chain that comes back to a link it has already been through resolves to nothing
    // in exactly the way a misspelled name does, so the two are indistinguishable from
    // the resolver's answer alone. They are not the same mistake: no spelling change
    // fixes a loop, and the value it stands for can never be computed at all. Asked
    // only once the reference has already failed, so the walk costs nothing on a file
    // whose references resolve.
    if (await aliasChainCycles(node, cancellationToken).catch(() => false)) {
        return {
            message: l10n.t('This reference leads back to itself, so its value can never be computed.'),
            node: node,
            code: 'reference-cycle',
            severity: 'error',
        };
    }
    const suggestion = await suggestReferenceName(node, startNode, uri, cancellationToken).catch(() => null);
    const base = l10n.t('You either reference a non-existing identifier or an identifier that is not in scope');
    return {
        message: l10n.t('Reference name is not known'),
        node: node,
        // The game tolerates an unresolved reference at load time (it simply contributes
        // nothing. Vanilla even ships dangling refs like `&<Overlays/overlays.rules>`),
        // so surface this as a warning + quick-fix rather than a hard error.
        // The content a mod action installs is the exception. `BaseSerializer.Read` hands every
        // member it reads to `ObjectTextSerializer.DereferenceSource`, which calls
        // `OTReferenceNode.FindFinalTarget` and throws when the target is not there. The throw
        // lands in the `ModInfo` constructor and `ModInfo.TryLoadMod` catches it, so the game
        // starts without the mod rather than loading past the reference.
        severity: isActionSourceValueNode(node) ? 'error' : 'warning',
        additionalInfo: suggestion ? `${base} ${l10n.t('Did you mean "{0}"?', suggestion.suggestion)}` : base,
        data: suggestion
            ? {
                  quickFix: {
                      title: l10n.t("Change to '{0}'", suggestion.suggestion),
                      newText: suggestion.correctedValue,
                  },
              }
            : undefined,
    };
};

/**
 * Judges one reference value: its written shape, whether the game resolves it, and whether a path
 * that does resolve is a file-relative escape into the workshop folder that will break when the
 * file moves.
 *
 * @param node the value to judge.
 * @param cancellationToken cancels every resolution.
 * @returns the finding, or undefined when the reference is fine.
 */
const checkReference = async (
    node: ValueNode,
    cancellationToken: CancellationToken
): Promise<ValidationError | undefined> => {
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
            // Action targets resolve against the game root (handled by the mod-action
            // validator), so the generic check skips them. This holds wherever an action
            // lives: a mod.rules manifest or an included fragment file (launcher.rules) whose
            // `Actions` list a manifest concatenates. Source refs are validated here as usual.
            !isActionTargetValueNode(node) &&
            !ignorePath(node.valueType.value) &&
            // `~` rooted references into a context the static file does not define are
            // resolved at runtime (template/library groups), so skip them.
            !isRuntimeRootReference(node) &&
            // A `:` segment (virtual inheritance) targets the most-derived inheritor, whose
            // members the declaring file cannot see (`Foo = &:/v_Foo` where only children
            // define `v_Foo`), so skip those like `~` runtime refs.
            !hasVirtualInheritanceSegment(node.valueType.value)
        ) {
            const startNode = isInheritanceInSameFile(node)
                ? ((node.parent as AbstractNode).parent as AbstractNode)
                : node;
            const resolved = await navigate(node.valueType.value, startNode, uri, cancellationToken).catch(
                () => undefined
            );
            // Not found in vanilla data. Fall back to the mod's own additions (the effective
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
                // `X : ^/0/X [extra]` may extend a base that doesn't define `X`. Cosmoteer
                // tolerates inheriting from a missing base member. A `…/^/N/Member` reference into a
                // base a mod's `AddBase` appends resolves through the shared resolver (the AddBase
                // index augments the caret base's inheritance list), so a valid `^/1` member is
                // already found above and only a genuine miss (a mis-indexed `^/0`) reaches here.
                !(await inheritanceExtendsMissingMember(node, startNode, uri, cancellationToken))
            ) {
                return await unresolvedReferenceFinding(node, node.valueType.value, startNode, uri, cancellationToken);
            }
            // The reference resolves, but a file-relative escape into another workshop mod breaks
            // whenever this file moves to a different depth. Recommend the game-root form, which
            // resolves from any file, once it is confirmed to reach the same kind of target.
            // Action targets are exempt even outside mod.rules (manifests include action lists
            // from other files): the game resolves them against the Data root, where the bare
            // `../` form is already correct.
            const canonical = isActionTargetValueNode(node) ? null : canonicalWorkshopEscape(node.valueType.value, uri);
            if (canonical && (await navigate(canonical, startNode, uri, cancellationToken).catch(() => null))) {
                return {
                    message: l10n.t('Fragile relative path into the workshop folder'),
                    node: node,
                    severity: 'information',
                    additionalInfo: l10n.t(
                        'This path resolves relative to this file and breaks when the file moves. "{0}" resolves from the game folder and works from any file.',
                        canonical
                    ),
                    data: { quickFix: { title: l10n.t("Change to '{0}'", canonical), newText: canonical } },
                };
            }
        }
    }
    return undefined;
};

const ignorePath = (value: string) => {
    for (const path of globalSettings.ignorePaths) {
        if (value.toLowerCase().includes(path.toLowerCase())) {
            return true;
        }
    }
    return false;
};
