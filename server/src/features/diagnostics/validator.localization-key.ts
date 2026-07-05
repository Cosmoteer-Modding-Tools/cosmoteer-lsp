import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    ValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { isLocalizationKeyType, localizationKeyFieldNames } from '../../document/schema/schema';
import { fieldOfValueNode } from '../completion/autocompletion.schema';
import { LocalizationKeyIndex } from '../completion/localization-key.index';
import { stringValueNodesOf } from '../navigation/schema-reference.navigation';
import { isStringsFile } from '../../mod/strings-folder';
import { closestMatch } from '../../utils/did-you-mean';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/** Per-container lookup table from an assignment's right-hand node to its field name. Built once
 *  per group instead of rescanning the group's elements for every candidate value node, which made
 *  string-heavy groups quadratic. Keyed weakly so tables die with their AST. */
const namesByRight: WeakMap<object, Map<unknown, string>> = new WeakMap();

/**
 * The field name whose `key = value` right-hand side is `node`, from the enclosing group or
 * document.
 *
 * @param node the string value node to name.
 * @returns the assignment's field name, or undefined when `node` is not an assignment value.
 */
const assignmentNameOf = (node: ValueNode): string | undefined => {
    const parent = node.parent;
    if (!parent || !(isGroupNode(parent) || isDocumentNode(parent))) return undefined;
    let table = namesByRight.get(parent);
    if (!table) {
        table = new Map();
        for (const element of parent.elements) {
            if (isAssignmentNode(element)) table.set(element.right, element.left.name);
        }
        namesByRight.set(parent, table);
    }
    return table.get(node);
};

/**
 * Validates literal localization-key values (a `KeyString` field such as `NameKey = "Parts/Foo"`),
 * flagging a key that no language strings file in the project declares — a typo, or a key the mod
 * forgot to add. Reference-valued keys (`NameKey = &<…>/NameKey`) are skipped here (they are
 * validated as references), as are empty values, mod.rules, and strings files themselves.
 *
 * Conservative, to stay false-positive-free: an unknown value is only flagged when the project's
 * strings index is non-empty (otherwise there is no coverage to judge against), and offers a
 * "did you mean" suggestion plus an insert-into-the-strings-files quick fix.
 *
 * @param document the parsed document to validate.
 * @param folderPaths the project folders the strings index is built from.
 * @param cancellationToken cancellation for the index build.
 * @returns one warning per literal localization key that is declared in no strings file.
 */
export const validateLocalizationKeys = async (
    document: AbstractNodeDocument,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    // A strings file's own leaves are the declarations, not `KeyString` references — never flag them.
    if (await isStringsFile(document.uri, cancellationToken).catch(() => false)) return [];

    // Cheap pre-filter by field name before the per-node schema resolution.
    const fieldNames = localizationKeyFieldNames();
    const candidates: Array<{ node: ValueNode; key: string }> = [];
    for (const value of stringValueNodesOf(document)) {
        const key = String(value.valueType.value).trim();
        if (!key) continue;
        const name = assignmentNameOf(value);
        if (!name || !fieldNames.has(name.toLowerCase())) continue;
        candidates.push({ node: value, key });
    }
    if (candidates.length === 0) return [];

    const keys = await LocalizationKeyIndex.instance.allKeys(folderPaths, cancellationToken);
    // No strings indexed means no coverage to judge against — do not flag.
    if (keys.size === 0) return [];
    // Cosmoteer resolves keys case-insensitively — vanilla itself references `Doodads/Asteroidgold_S`
    // while the strings define `AsteroidGold_S` — so membership is checked case-folded to avoid
    // flagging a mere case difference.
    const keysLower = new Set([...keys].map((existing) => existing.toLowerCase()));

    const errors: ValidationError[] = [];
    for (const { node, key } of candidates) {
        if (cancellationToken.isCancellationRequested) return errors;
        // Confirm via the schema: the field name matched, but resolve the concrete field to be sure it
        // is actually a `KeyString` in this class (and not a same-named field of another type).
        const field = await fieldOfValueNode(node, cancellationToken).catch(() => undefined);
        if (!isLocalizationKeyType(field?.valueType)) continue;
        if (keysLower.has(key.toLowerCase())) continue;

        const suggestion = closestMatch(key, [...keys], true);
        const base = l10n.t('No localization key "{0}" is defined in any strings file.', key);
        errors.push({
            message: l10n.t('Localization key not found'),
            node,
            // The game shows the raw key path when it can't resolve one, so this is a warning, not a
            // hard error — and it may legitimately be defined by another mod's strings at load time.
            severity: 'warning',
            additionalInfo: suggestion ? `${base} ${l10n.t('Did you mean "{0}"?', suggestion)}` : base,
            data: {
                ...(suggestion ? { quickFix: { title: l10n.t('Change to "{0}"', suggestion), newText: suggestion } } : {}),
                insertLocalizationKey: { key },
            },
        });
    }
    return errors;
};
