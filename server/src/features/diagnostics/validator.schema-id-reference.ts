import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument } from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { typeDef } from '../../document/schema/schema';
import { SchemaIdIndex } from '../completion/schema-id.index';
import { schemaReferenceFieldOf, mapKeyReferencesOf } from '../navigation/schema-id-reference.navigation';
import { stringValueNodesOf } from '../navigation/schema-reference.navigation';
import { closestMatch } from '../../utils/did-you-mean';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/** A cross-file id reference found in a document, with the class it targets and the written id. */
interface IdReference {
    readonly node: AbstractNode;
    readonly targetClass: string;
    readonly value: string;
}

/**
 * Collects every cross-file `ID<X>` reference in a document, from value positions (`ResourceType = battery`,
 * `ReceivableBuffs = [Engine]`) and from map keys (`MaxBuffValues = { Engine = … }`).
 *
 * @param document the parsed document to scan.
 * @returns a generator of every {@link IdReference} the document contains.
 */
function* idReferencesOf(document: AbstractNodeDocument): Generator<IdReference> {
    for (const value of stringValueNodesOf(document)) {
        const ref = schemaReferenceFieldOf(value);
        if (ref) yield { node: value, targetClass: ref.targetClass, value: ref.value };
    }
    for (const key of mapKeyReferencesOf(document)) {
        yield { node: key.node, targetClass: key.targetClass, value: key.value };
    }
}

/**
 * The reference target classes the project index harvests completely from any file, including a
 * mod's own files, so a missing id is a real typo for both vanilla and mods. These are the GUI id
 * collections, which are found by their field name (`PartToggles [ … ]`) wherever they are written.
 *
 * Deliberately excluded:
 *  - per-part or runtime kinds (`PartStatRules` stats live inside each part, `MissionMetatype` is
 *    runtime), which a central index cannot see,
 *  - alias-harvested map collections (`BuffType` from `buffs.rules`, part features), which are found
 *    only through the game's `cosmoteer.rules` aliases, so a MOD's own buffs are not seen and would
 *    false-positive,
 *  - whole-file-root kinds (`ResourceRules`, `StatusType`) where a mod can declare an instance in a
 *    place the path rules do not root.
 *
 * The vanilla AND mod scans keep this list honest. Every entry must produce zero warnings across the
 * base game and the reference mod.
 */
const VALIDATABLE_CLASSES: ReadonlySet<string> = new Set([
    'Cosmoteer.Game.PartToggleGuiRules',
    'Cosmoteer.Game.PartColorGuiRules',
    'Cosmoteer.Game.PartTargeterGuiRules',
    'Cosmoteer.Game.PartTriggerGuiRules',
]);

/**
 * Validates cross-file `ID<X>` references, flagging a value that names no declaration of class `X`
 * anywhere in the project (a typo such as `ResourceType = btatery` or `ReceivableBuffs = [Engne]`).
 *
 * Conservative, to stay false-positive-free. Only the centrally declared classes in
 * {@link VALIDATABLE_CLASSES} are checked, and an empty value is ignored. The id index is built
 * across the whole project, so an id declared in any open folder or the game tree counts.
 *
 * @param document the parsed document to validate.
 * @param folderPaths the project folders the id index is built from.
 * @param cancellationToken cancellation for the index build.
 * @returns the list of validation errors, one per reference whose id is not declared anywhere.
 */
export const validateCrossFileIdReferences = async (
    document: AbstractNodeDocument,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];

    const references = [...idReferencesOf(document)].filter(
        (ref) => VALIDATABLE_CLASSES.has(ref.targetClass) && ref.value.trim() !== ''
    );
    if (references.length === 0) return [];

    const errors: ValidationError[] = [];
    const idsByClass = new Map<string, Set<string>>();
    for (const reference of references) {
        if (cancellationToken.isCancellationRequested) return errors;
        let ids = idsByClass.get(reference.targetClass);
        if (!ids) {
            ids = await SchemaIdIndex.instance.idsForClass(reference.targetClass, folderPaths, cancellationToken);
            idsByClass.set(reference.targetClass, ids);
        }
        // No declarations for this class means we have no coverage to judge it, so do not flag.
        if (ids.size === 0 || ids.has(reference.value)) continue;

        const targetName = typeDef(reference.targetClass)?.name ?? reference.targetClass.split('.').pop()!;
        const suggestion = closestMatch(reference.value, [...ids], true);
        errors.push({
            message: l10n.t("No {0} named '{1}' in the project.", targetName, reference.value),
            node: reference.node,
            severity: 'warning',
            ...(suggestion
                ? { data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } } }
                : {}),
        });
    }
    return errors;
};
