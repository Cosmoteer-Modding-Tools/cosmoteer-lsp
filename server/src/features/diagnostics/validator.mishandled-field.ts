import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode, isGroupNode, isValueNode } from '../../core/ast/ast';
import { childNodesOf } from '../../utils/ast.utils';
import { resolveGroupClass } from '../../document/schema/schema-context';
import {
    MishandledEffect,
    MishandledFieldRule,
    MISHANDLED_FIELD_RULES,
} from '../../document/schema/mishandled-fields';
import { ValidationError, ValidationErrorData } from './validator';

/** The list field the inverted shorthand was meant to reach. */
const EXCLUDE_IDS = 'ExcludeIDs';

/**
 * What the game does with the field, worded for the reader.
 *
 * @param effect the row's effect.
 * @param field the field name as written.
 * @returns the diagnostic message.
 */
const messageFor = (effect: MishandledEffect, field: string): string => {
    switch (effect) {
        case 'excludeIdInverts':
            return l10n.t(
                "The game adds '{0}' to the list of parts this matches instead of the list it excludes, so this part becomes the only one accepted. Write it as '{1}' to exclude it.",
                field,
                EXCLUDE_IDS
            );
        case 'toggledBlendFlagIgnored':
            return l10n.t(
                'The toggled blend sprites are generated without reading this flag, so the game still throws on a combination of toggle states no sprite covers.'
            );
        case 'dragExponentOne':
            return l10n.t(
                'An exponent of 1 collapses the damping formula to 1 divided by the speed and takes the coefficient beside it out of the result. Use the viscous solver for that.'
            );
    }
};

/**
 * Whether the value written for a field satisfies the row's condition.
 *
 * @param rule the row being judged.
 * @param value the value node the field carries.
 * @returns true when the row applies to what is written.
 */
const conditionHolds = (rule: MishandledFieldRule, value: AbstractNode): boolean => {
    if (rule.condition.kind === 'written') return true;
    if (!isValueNode(value) || value.valueType.type === 'Reference') return false;
    return Number(String(value.valueType.value).trim()) === Number(rule.condition.value);
};

/**
 * The quick fix a row offers, which only the inverted shorthand has one for. Rewriting it means
 * replacing the whole assignment: the plural field is a list, and the game refuses to read a list
 * from anything but a `[ ]`, so swapping the name alone would trade a silent inversion for a file
 * that does not load. Offered only for a plainly written value, since anything else cannot be put
 * back together from the parsed value alone.
 *
 * @param rule the row being reported.
 * @param value the value node the field carries.
 * @returns the quick-fix payload, or an empty object when the row offers none.
 */
const fixFor = (rule: MishandledFieldRule, value: AbstractNode): Pick<ValidationError, 'data'> => {
    if (rule.effect !== 'excludeIdInverts') return {};
    if (!isValueNode(value) || value.valueType.type === 'Reference') return {};
    const written = String(value.valueType.value).trim();
    if (written === '') return {};
    const data: ValidationErrorData = {
        quickFix: {
            title: l10n.t("Change to '{0}'", EXCLUDE_IDS),
            newText: `${EXCLUDE_IDS} = [${written}]`,
        },
    };
    return { data };
};

/**
 * Flags a field the game reads and then acts on wrongly, which nothing else can see.
 *
 * Such a field passes the schema, loads without a word, and leaves the game doing something other
 * than what the file says. The rows come from the lines that mishandle the value, see the registry
 * in `document/schema/mishandled-fields.ts`.
 *
 * Judged only where the group's class resolves, and matched against that exact class. Each of these
 * fields has a sibling class that reads it correctly, so a row applied through inheritance would
 * report a file that is right.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk when the document changed under us.
 * @returns one finding per written field the class it sits on mishandles.
 */
export const validateMishandledFields = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    const visit = (node: AbstractNode): void => {
        if (cancellationToken.isCancellationRequested) return;
        if (isGroupNode(node)) {
            const cls = resolveGroupClass(node);
            if (cls) {
                for (const element of node.elements) {
                    if (!isAssignmentNode(element)) continue;
                    const value = element.right;
                    if (!value) continue;
                    const name = element.left.name.toLowerCase();
                    for (const rule of MISHANDLED_FIELD_RULES) {
                        if (rule.owner !== cls || rule.field.toLowerCase() !== name) continue;
                        if (!conditionHolds(rule, value)) continue;
                        const start = element.left.position.start;
                        const end = value.position.end;
                        errors.push({
                            message: messageFor(rule.effect, element.left.name),
                            node: element.left,
                            range: { start, end },
                            severity: rule.severity,
                            ...(rule.severity === 'hint' ? { unnecessary: true } : {}),
                            ...fixFor(rule, value),
                        });
                    }
                }
            }
        }
        for (const child of childNodesOf(node)) visit(child);
    };
    visit(document);
    return errors;
};
