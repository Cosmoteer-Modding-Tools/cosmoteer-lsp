import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { fieldOf, schema } from '../../document/schema/schema';
import { SchemaField } from '../../document/schema/schema.types';
import { ValidationError } from './validator';
import { referencedSegments } from './validator.ignored-field';
import * as l10n from '@vscode/l10n';

/**
 * Whether a written value is literally the field's schema default, so the assignment leaves the game
 * exactly where omitting it would. Only the three literal kinds are judged: a Reference resolves
 * elsewhere, and an asset-shaped value (Sprite/Sound/Shader) is a path whose default spelling the
 * schema does not model, so neither can be compared to a `default` this way.
 *
 * Numbers compare numerically, so `1.0` matches a default of `1`. Strings compare case-insensitively,
 * matching how the game resolves the enum-like words that make up most string defaults (`RectType =
 * Physical`). Quoting is already stripped by the parser, so `"Physical"` and `Physical` both match.
 *
 * @param value the written value node.
 * @param field the schema field the value is assigned to.
 * @returns true when the value is indistinguishable from the default.
 */
const matchesDefault = (value: ValueNode, field: SchemaField): boolean => {
    const written = value.valueType;
    const fallback = field.default;
    if (written.type === 'Number' && typeof fallback === 'number') return written.value === fallback;
    if (written.type === 'Boolean' && typeof fallback === 'boolean') return written.value === fallback;
    if (written.type === 'String' && typeof fallback === 'string') {
        return written.value.toLowerCase() === fallback.toLowerCase();
    }
    return false;
};

/**
 * Whether this field's schema `default` provably means "the value the game uses when the field is
 * absent". The two sources schemagen records are not equally strong (see `SchemaField.defaultSource`):
 *  - `attribute`: the game's own `[Serialize(DefaultValue = …)]`. BaseSerializer's reflective read
 *    writes it into the target for any missing optional member, so it holds however the class is
 *    built. Trusted on its own.
 *  - `initializer`: read out of the smallest-arity constructor's constant stores. That equals the
 *    absent-value only when the game constructs the class that way and fills it reflectively, which
 *    is what `purelyReflective` guarantees, so it is gated on the class.
 *
 * Both arms are decompile-verified. Every class the vanilla and workshop scans flag through the
 * `initializer` arm has a compiler-generated parameterless constructor whose field initializers are
 * the absent-value, while the classes that arm rejects include real traps (`MusicFileTrackRules`
 * deserializes through a `GenericSerialReader`). The `attribute` arm unlocks exactly three
 * non-`purelyReflective` classes (`TargetBlendMode`, `StatusFactors`, `GeneratorStage`), and each
 * one's custom reader was read and does reach `ReflectiveRead`, so the attribute really is applied.
 * `TargetBlendMode` is the reason this distinction exists: a preset-valued struct (not
 * `purelyReflective`, since it has its own `ReadContentFrom`) whose group form starts from
 * `default(TargetBlendMode)` and then delegates straight to `ReflectiveRead`.
 *
 * @param cls the class the group resolved to.
 * @param field the schema field the value is assigned to.
 * @returns true when an absent optional field provably falls back to the schema's default.
 */
const defaultIsAbsentValue = (cls: string, field: SchemaField): boolean => {
    const def = schema.types[cls];
    if (!def || def.abstract) return false;
    if (field.defaultSource === 'attribute') return true;
    return field.defaultSource === 'initializer' && !!def.purelyReflective;
};

/**
 * Whether a field written on `group` provably restates the game's own default, so deleting it is a
 * no-op. Every uncertainty answers false:
 *  - the group must not inherit: a base can set a non-default value that an explicitly-written
 *    default deliberately overrides, and deleting that field would restore the base's value,
 *  - the field's default must be an absent-value (see {@link defaultIsAbsentValue}),
 *  - the deserializer must tolerate the field's absence (`absentThrows`). The `optional` flag is not
 *    enough: it is a broader heuristic for the required-field check, and a field can pass it while
 *    the engine still throws on a missing value. Fading one of those would invite a deletion that
 *    breaks the game load. `PartMultiColorRules.RGBMode` (`[Serialize]` with no `Optional = true`, but
 *    ctor-initialized so `optional` is true) is the case that proves the two differ,
 *  - the field must not be `dead`, which {@link validateIgnoredFields} already fades (two hints on
 *    one span would stack), and
 *  - the name must not be read by any reference in the file, which is the same suppression
 *    {@link ignoredFieldClass} applies: a default-valued field read via `&Name` is still load-bearing.
 *
 * @param group the group containing the member.
 * @param cls the class the group resolved to.
 * @param name the member's written field name.
 * @param value the written value node.
 * @param document the containing document, for the reference-usage scan.
 * @returns the schema field when the assignment is a redundant default, undefined otherwise.
 */
const redundantDefaultField = (
    group: GroupNode,
    cls: string,
    name: string,
    value: ValueNode,
    document: AbstractNodeDocument
): SchemaField | undefined => {
    const field = fieldOf(cls, name);
    if (!field || field.default === undefined || field.dead || !field.optional) return undefined;
    if (field.absentThrows) return undefined;
    if (!defaultIsAbsentValue(cls, field)) return undefined;
    if (referencedSegments(document).has(name.toLowerCase())) return undefined;
    if (!matchesDefault(value, field)) return undefined;
    return field;
};

/**
 * Whole-document pass fading fields that restate the game's default. Emitted as an unnecessary-tagged
 * hint with a remove quick fix: the field is dead weight (a template copied with its defaults left
 * in), not an error, and vanilla itself writes plenty of them.
 *
 * Only groups with no inheritance list are judged, so an explicit default that overrides a base's
 * value is never flagged. The group's class is resolved once per group rather than per member, since
 * the resolution is the expensive part. `resolveGroupClass` memoizes per group, but the bail keeps
 * whole inheriting subtrees off the path entirely. Whether each default can be trusted is then a
 * per-field question, not a per-class one, see {@link defaultIsAbsentValue}.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk.
 * @returns the hints for provably redundant default assignments.
 */
export const validateDefaultValuedFields = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const errors: ValidationError[] = [];
    const visit = (node: AbstractNode): void => {
        if (cancellationToken.isCancellationRequested) return;
        if (isGroupNode(node) && !node.inheritance?.length) {
            const cls = resolveGroupClass(node);
            if (cls) {
                for (const element of node.elements) {
                    if (!isAssignmentNode(element)) continue;
                    const value = element.right;
                    if (!value || !isValueNode(value)) continue;
                    const name = element.left.name;
                    const field = redundantDefaultField(node, cls, name, value, document);
                    if (!field) continue;
                    const classLabel = schema.types[cls]?.name ?? cls;
                    const start = element.left.position.start;
                    const end = value.position.end;
                    errors.push({
                        message: l10n.t(
                            "'{0}' is already {1} by default on {2}, so writing it changes nothing.",
                            name,
                            String(field.default),
                            classLabel
                        ),
                        node: element.left,
                        range: { start, end },
                        severity: 'hint',
                        unnecessary: true,
                        data: { remove: { title: l10n.t("Remove '{0}'", name), start, end } },
                    });
                }
            }
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node) && node.right
                  ? [node.right]
                  : [];
        for (const child of children) visit(child);
    };
    visit(document);
    return errors;
};
