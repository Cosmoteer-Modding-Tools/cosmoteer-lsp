import * as l10n from '@vscode/l10n';
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
import { resolveGroupClass } from '../../document/schema/schema-context';
import { fieldsOf } from '../../document/schema/schema';
import { findMemberThroughInheritance } from '../../semantics/inheritance-resolver';
import { resolveReference } from '../../semantics/effective-member';
import { MemberInjectionIndex } from '../../mod/member-injection.index';
import { PART_RULES_CLASS } from '../part-editor/part-fields';
import { ValidationError } from './validator';

/** The two members naming what a part leaves behind, with the spellings the game also reads them by. */
const UNDERLYING_FIELDS = ['UnderlyingPart', 'UnderlyingPartPerTile'] as const;

/**
 * Every spelling the game reads one of the underlying members by, since a part is free to use the
 * older name and the reader takes either.
 *
 * @returns each spelling to the field it stands for, folded for lookup.
 */
const underlyingSpellings = (): Map<string, string> => {
    const spellings = new Map<string, string>();
    for (const field of fieldsOf(PART_RULES_CLASS)) {
        if (!UNDERLYING_FIELDS.includes(field.name as (typeof UNDERLYING_FIELDS)[number])) continue;
        spellings.set(field.name.toLowerCase(), field.name);
        for (const alias of field.aliases ?? []) spellings.set(alias.toLowerCase(), field.name);
    }
    return spellings;
};

/**
 * The member written under `name`, matched the case-insensitive way the game matches a member name.
 *
 * @param group the group to read.
 * @param name the member name, in any casing.
 * @returns the member's value, or null when the group does not write it.
 */
const memberOf = (group: GroupNode, name: string): AbstractNode | null => {
    const wanted = name.toLowerCase();
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.left.name.toLowerCase() === wanted && element.right) {
            return element.right;
        }
        if ((isGroupNode(element) || isListNode(element)) && element.identifier?.name.toLowerCase() === wanted) {
            return element;
        }
    }
    return null;
};

/**
 * The part id a value spells, unquoted, or null for anything this pass cannot read as one name.
 *
 * @param node the written value.
 * @returns the id, or null.
 */
const partIdOf = (node: AbstractNode | null | undefined): string | null => {
    if (!node || !isValueNode(node)) return null;
    if (node.valueType.type === 'Reference') return null;
    const written = String(node.valueType.value).trim();
    // A member written empty is how a part clears an inherited underlying, which is the idiom the
    // game's own structure part uses to end every chain.
    return written === '' ? null : written;
};

/**
 * The part groups this document instantiates, matching the gate the other part passes use.
 *
 * @param document the parsed document.
 * @returns the part groups to judge, in source order.
 */
const instantiatedParts = (document: AbstractNodeDocument): GroupNode[] => {
    const parts: GroupNode[] = [];
    const visit = (node: AbstractNode): void => {
        if (isGroupNode(node) && memberOf(node, 'ID') && resolveGroupClass(node) === PART_RULES_CLASS) parts.push(node);
        if (isGroupNode(node) || isListNode(node)) for (const child of node.elements) visit(child);
    };
    for (const element of document.elements) visit(element);
    return parts;
};

/**
 * Flags a part that leaves itself behind when it is destroyed.
 *
 * The engine works out what a part costs beyond its underlying replacement by asking that
 * replacement the same question, and writes its own answer down only once the call returns. There
 * is no visited set anywhere on that path, and the same graph is walked again to work out what a
 * part drops, which the game does on a ship update and when the player merely queues a deconstruct.
 * A part naming itself is therefore unbounded recursion, and a stack overflow cannot be caught in
 * the runtime the game is built on.
 *
 * Only a part naming its own id is judged. A ring running through several parts is the same crash
 * and is deliberately left out: the part table is built per ship rather than once for the project,
 * so joining two parts by name alone can invent an edge between two ships that never share a table.
 * A wrong edge there would report a ring that does not exist, which is worse than missing one.
 *
 * The member is read the way the game reads it: what a manifest puts in place of it first, then what
 * the part writes itself, then the nearest declaration up its inheritance chain.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the chain walks.
 * @returns one finding per part that names itself as its own underlying part.
 */
export const validateUnderlyingParts = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    const spellings = underlyingSpellings();
    for (const part of instantiatedParts(document)) {
        if (cancellationToken.isCancellationRequested) return errors;
        const id = partIdOf(memberOf(part, 'ID'));
        if (!id) continue;
        for (const [spelling, field] of spellings) {
            const local = memberOf(part, spelling);
            const written =
                MemberInjectionIndex.instance.injectedReplacement(part, spelling) ??
                local ??
                (await findMemberThroughInheritance(part, spelling, resolveReference, cancellationToken).catch(
                    () => null
                ));
            const underlying = partIdOf(written);
            if (!underlying || underlying.toLowerCase() !== id.toLowerCase()) continue;
            // An inherited declaration lives in another file, which is not this author's to change,
            // so the finding goes on the part's own id instead.
            const anchor = written === local ? written : memberOf(part, 'ID');
            if (!anchor) continue;
            errors.push({
                message: l10n.t(
                    "'{0}' names itself as its own {1}, so working out what it costs or drops asks the same question forever and the game stops.",
                    id,
                    field
                ),
                node: anchor,
                severity: 'error',
            });
        }
    }
    return errors;
};
