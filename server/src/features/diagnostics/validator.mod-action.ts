import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { Action, ACTION_VERBS, ActionSource, SourceShape, TargetShape, VERB_SCHEMA } from '../../mod/action';
import { normalizeTargetPath } from '../../mod/action-target-resolver';
import { resolveWithModContext } from '../../mod/mod-context';
import { isUnderFolder, resolveStringsFolders } from '../../mod/strings-folder';
import { FileTree, FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/** A resolved action target is either a whole `.rules` file or a node inside one. */
type ResolvedTarget = AbstractNode | FileWithPath;

/** Whether a resolved target is a whole `.rules` file (rather than a node inside one). */
const targetsWholeFile = (resolved: ResolvedTarget): boolean => isFile(resolved as unknown as FileTree);

/** The on-disk path of the file a resolved target lives in (the file itself, or the node's document). */
const targetFilePath = (resolved: ResolvedTarget): string =>
    targetsWholeFile(resolved) ? (resolved as FileWithPath).path : getStartOfAstNode(resolved as AbstractNode).uri;

/** A `&` reference value. Its real shape is whatever it resolves to, so it satisfies any container constraint. */
const isReferenceValue = (node: AbstractNode): boolean => isValueNode(node) && node.valueType.type === 'Reference';

/**
 * Whether a source value node satisfies the AST shape the verb requires (see {@link SourceShape}).
 * A `&` reference is always accepted: it may resolve to the required group/list, and we don't
 * resolve it here. Only plain inline values (strings, numbers, …) are rejected where a container
 * is required.
 */
const sourceMatchesShape = (source: ActionSource, shape: SourceShape): boolean => {
    if (isReferenceValue(source)) return true;
    switch (shape) {
        case 'list':
            return isListNode(source);
        case 'group':
            return isGroupNode(source);
        case 'composite':
            return isGroupNode(source) || isListNode(source);
    }
};

/** Human-readable description of an allowed source shape, for the diagnostic detail. */
const shapeDescription = (shape: SourceShape): string => {
    switch (shape) {
        case 'list':
            return l10n.t('a list "[ ]"');
        case 'group':
            return l10n.t('a group "{ }"');
        case 'composite':
            return l10n.t('a reference "&", a group "{ }" or a list "[ ]" (not a plain value)');
    }
};

/**
 * Whether a resolved target node satisfies the AST shape the verb requires (see {@link TargetShape}).
 * A `&` reference is accepted (its real shape is whatever it resolves to, not resolved here);
 * a plain value node is rejected where a list/group is required.
 */
const targetMatchesShape = (node: AbstractNode, shape: TargetShape): boolean => {
    if (isReferenceValue(node)) return true;
    switch (shape) {
        case 'list':
            return isListNode(node);
        case 'container':
            return isGroupNode(node) || isListNode(node);
    }
};

/** Human-readable description of an allowed target shape, for the diagnostic detail. */
const targetShapeDescription = (shape: TargetShape): string => {
    switch (shape) {
        case 'list':
            return l10n.t('a list "[ ]"');
        case 'container':
            return l10n.t('a group "{ }" or a list "[ ]"');
    }
};

/**
 * Validate a mod.rules manifest's actions: the verb must be known, required fields
 * must be present, and each target must resolve in the effective game tree (vanilla
 * plus the mod's own additions), unless `IgnoreIfNotExisting`/`CreateIfNotExisting`
 * is set.
 *
 * Sources are not checked here. The generic value validator handles them (they are
 * normal references resolved relative to the mod). Runs as a separate pass from the
 * AstType-keyed `Validator` (which allows only one callback per node type).
 */
export const validateModActions = async (
    actions: Action[],
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];

    // Files under a `StringsFolder` (language strings) cannot be targeted by actions. Resolved
    // once for the whole pass from the game root + the editing mod's manifests.
    const documentUri = actions.length > 0 ? getStartOfAstNode(actions[0].group).uri : undefined;
    const stringsFolders = await resolveStringsFolders(documentUri, cancellationToken);

    for (const action of actions) {
        if (action.type === 'Unknown') {
            errors.push({
                message: l10n.t('Unknown mod action verb'),
                node: action.verbNode ?? action.group,
                additionalInfo: l10n.t('Valid verbs are: {0}', ACTION_VERBS.join(', ')),
            });
            continue;
        }

        const schema = VERB_SCHEMA[action.type];
        for (const required of schema.required) {
            if (!action.presentFields.has(required.toLowerCase())) {
                errors.push({
                    message: l10n.t('Mod action is missing a required field'),
                    node: action.verbNode ?? action.group,
                    additionalInfo: l10n.t('The "{0}" action requires the field "{1}"', action.type, required),
                });
            }
        }

        // The source value must take the AST shape the verb allows (e.g. Overrides needs a `{}`,
        // AddMany needs a `[]`). A missing source is already reported by the required-field check.
        if (schema.sourceShape) {
            for (const source of action.sources) {
                if (!sourceMatchesShape(source, schema.sourceShape)) {
                    errors.push({
                        message: l10n.t('Mod action source has the wrong shape'),
                        node: source,
                        additionalInfo: l10n.t(
                            'The "{0}" action requires its "{1}" to be {2}',
                            action.type,
                            schema.sources[0],
                            shapeDescription(schema.sourceShape)
                        ),
                    });
                }
            }
        }

        // If the action tolerates a missing target (skip or create it), don't check existence.
        if (action.flags.IgnoreIfNotExisting === true || action.flags.CreateIfNotExisting === true) continue;

        for (const target of action.targets) {
            if (cancellationToken.isCancellationRequested) return errors;
            const resolved = await resolveWithModContext(
                normalizeTargetPath(String(target.valueType.value)),
                target,
                cancellationToken
            ).catch(() => null);
            if (resolved === null) {
                errors.push({
                    message: l10n.t('Action target not found'),
                    node: target,
                    additionalInfo: l10n.t(
                        'The target of this action could not be found in the game data (or in what this mod adds)'
                    ),
                });
                continue;
            }

            // Language string files (under a `StringsFolder`) can't be touched by actions at all,
            // takes precedence over the shape/Name checks below.
            if (stringsFolders.some((folder) => isUnderFolder(targetFilePath(resolved), folder))) {
                errors.push({
                    message: l10n.t('Mod action cannot target a language string file'),
                    node: target,
                    additionalInfo: l10n.t(
                        'Files under the "StringsFolder" (such as "en.rules") are not modifiable by actions; provide your own per-language string file instead'
                    ),
                });
                continue;
            }

            const wholeFile = targetsWholeFile(resolved);

            if (action.type === 'Add') {
                // `Name` is mandatory when adding into a container (a whole `.rules` file, not
                // descending into it, or a `{}` group). Otherwise the added entry has no key.
                if ((wholeFile || isGroupNode(resolved as AbstractNode)) && !action.nameNode) {
                    errors.push({
                        message: l10n.t('Add action is missing the Name field'),
                        node: action.verbNode ?? action.group,
                        additionalInfo: l10n.t(
                            'Adding to a whole ".rules" file or a group "{ }" requires a "Name" for the new entry'
                        ),
                    });
                }
            } else if (wholeFile && !schema.allowsWholeFileTarget) {
                // Most verbs operate on a node inside a file; a whole `.rules` file cannot itself
                // be replaced or removed. Overrides is the exception (its top level is a group).
                errors.push({
                    message: l10n.t('Mod action cannot target a whole .rules file'),
                    node: target,
                    additionalInfo: l10n.t(
                        'The "{0}" action must target a node inside a ".rules" file, not the file itself',
                        action.type
                    ),
                });
            } else if (
                !wholeFile &&
                schema.targetShape &&
                !targetMatchesShape(resolved as AbstractNode, schema.targetShape)
            ) {
                // The resolved node must be the right container (e.g. AddMany needs a `[]`,
                // AddBase a `[]`/`{}`). You can't add list items to a scalar.
                errors.push({
                    message: l10n.t('Mod action target has the wrong shape'),
                    node: target,
                    additionalInfo: l10n.t(
                        'The "{0}" action must target {1}',
                        action.type,
                        targetShapeDescription(schema.targetShape)
                    ),
                });
            }
        }
    }

    return errors;
};
