import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isValueNode,
    descendants,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { inertCondition, InertCondition } from '../../document/schema/inert-fields';
import { fieldOf } from '../../document/schema/schema';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { memberValueNamed } from '../../utils/ast.utils';
import { referencedSegments } from './validator.ignored-field';
import { ValidationError } from './validator';

/** The boolean a value node spells, or undefined when it spells something else. */
const booleanOf = (node: AbstractNode | undefined): boolean | undefined => {
    if (!node || !isValueNode(node)) return undefined;
    if (node.valueType.type === 'Boolean') return Boolean(node.valueType.value);
    const written = String(node.valueType.value).toLowerCase();
    return written === 'true' ? true : written === 'false' ? false : undefined;
};

/** The number a value node spells, or undefined when it is not a plain number. */
const numberOf = (node: AbstractNode | undefined): number | undefined => {
    if (!node || !isValueNode(node)) return undefined;
    const value = Number(node.valueType.value);
    return Number.isFinite(value) ? value : undefined;
};

/**
 * Whether the group really puts the field in the state the registry calls inert. Every answer is
 * read from what the group itself writes, and undefined is never taken as a verdict: a sibling
 * written as a reference or as an expression is left unjudged rather than guessed at.
 *
 * @param group the group the field is written in.
 * @param condition the relation the registry holds for the field.
 * @returns true when the game provably stops reading the field.
 */
const isInert = (group: GroupNode, condition: InertCondition): boolean => {
    const sibling = memberValueNamed(group, condition.sibling);
    switch (condition.kind) {
        case 'siblingPresent':
            return sibling !== undefined;
        case 'siblingAbsent':
            return sibling === undefined;
        case 'siblingFalse':
            return booleanOf(sibling) === false;
        case 'siblingTrue':
            return booleanOf(sibling) === true;
        case 'siblingNotPositive': {
            const value = numberOf(sibling);
            return value !== undefined && value <= 0;
        }
    }
};

/**
 * The sentence saying why the field is dead where it stands.
 *
 * @param field the field the game does not read.
 * @param condition the relation behind the finding.
 * @returns the finding's message.
 */
const messageFor = (field: string, condition: InertCondition): string => {
    switch (condition.kind) {
        case 'siblingPresent':
            return l10n.t(
                "'{0}' has no effect while '{1}' is written here, which the game reads instead.",
                field,
                condition.sibling
            );
        case 'siblingAbsent':
            return l10n.t("'{0}' has no effect unless '{1}' is written in the same group.", field, condition.sibling);
        case 'siblingFalse':
            return l10n.t("'{0}' has no effect while '{1}' is false.", field, condition.sibling);
        case 'siblingTrue':
            return l10n.t("'{0}' has no effect while '{1}' is true.", field, condition.sibling);
        case 'siblingNotPositive':
            return l10n.t("'{0}' has no effect while '{1}' is not above zero.", field, condition.sibling);
    }
};

/**
 * Fades a field a sibling switches off, so it reads as the dead weight it is instead of as a
 * setting that does something. The relations come from the reader branches in the shipped
 * assembly, see the registry in `document/schema/inert-fields.ts`.
 *
 * A relation that fires on a sibling being absent is only judged inside a group with no
 * inheritance list, because a base can supply the very sibling that would switch the field back
 * on. A relation that fires on what the group itself writes needs no such guard: inheritance adds
 * members, it never takes the written one away. A field any reference in the file reads is left
 * alone, since removing it would break the reference whatever the game does with the value.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk.
 * @returns one faded hint per field the game provably does not read where it is written.
 */
export const validateInertFields = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const errors: ValidationError[] = [];
    for (const node of descendants(document)) {
        if (cancellationToken.isCancellationRequested) break;
        if (!isGroupNode(node)) continue;
        const cls = resolveGroupClass(node);
        if (!cls) continue;
        for (const element of node.elements) {
            if (!isAssignmentNode(element)) continue;
            const value = element.right;
            if (!value) continue;
            const name = element.left.name;
            const condition = inertCondition(cls, name);
            if (!condition) continue;
            if (condition.kind === 'siblingAbsent' && node.inheritance?.length) continue;
            if (!fieldOf(cls, name)) continue;
            if (referencedSegments(document).has(name.toLowerCase())) continue;
            if (!isInert(node, condition)) continue;
            const start = element.left.position.start;
            const end = value.position.end;
            errors.push({
                message: messageFor(name, condition),
                node: element.left,
                range: { start, end },
                severity: 'hint',
                unnecessary: true,
                data: { remove: { title: l10n.t("Remove '{0}'", name), start, end } },
            });
        }
    }
    return errors;
};
