import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import {
    groupDiscriminator,
    registryForContainer,
    registryHintFromContainer,
    resolveGroupClass,
} from '../../document/schema/schema-context';
import { documentRootClass, documentRootRegistry } from '../../document/schema/document-root';
import { discriminatorIsAmbiguous, enumDef, fieldOf, schema } from '../../document/schema/schema';
import { deprecatedDiscriminator } from '../../document/schema/deprecations';
import { SchemaRegistry, ValueType } from '../../document/schema/schema.types';
import { GroupNode } from '../../core/ast/ast';
import { ValidationError } from './validator';
import { closestMatch } from '../../utils/did-you-mean';
import { ALL_MATH_FUNCTION_NAMES } from '../../semantics/math-function-registry';
import { evaluateNumericValue, formatNumber } from '../../semantics/value-evaluator';
import * as l10n from '@vscode/l10n';

// The engine numeric scalar types whose ObjectText deserializer is confirmed pure-numeric: a literal
// number (`90`, `90d`, `-1.5`), a reference, or a math expression — never a named constant. Bare CLR
// `int`/`float` primitives are deliberately excluded: some carry a custom name-accepting deserializer
// (e.g. `Allegiance = Neutral` is typed `int`), so validating those would produce false positives.
// These all surface as a `number` kind carrying one of these `type` labels in the schema.
const NUMERIC_SCALAR_TYPES = new Set([
    'Direction',
    'Angle',
    'ModifiableFloat',
    'ModifiableInt',
    'ModifiableAngle',
    'ModifiableTime',
]);

// A plain identifier word (optionally dotted), the only String shape we treat as a possible typo.
// Excludes `(`, `)`, operators and number-ish tokens, so expression fragments never reach the flag.
const BARE_WORD = /^[A-Za-z_][\w.]*$/;

// Every word the game's BooleanSerializer parses (case-insensitively), verified in HalflingCore.dll.
const BOOLEAN_WORDS = new Set(['true', 'yes', 'y', 'false', 'no', 'n']);

// Bare words that are valid inside a Cosmoteer math expression even unparenthesized, so they must
// never be flagged: mXparser/Cosmoteer function and constant keywords plus the boolean/limit
// literals the evaluator understands.
const NUMERIC_LITERAL_WORDS = new Set(['e', 'pi', 'true', 'false', 'infinity', 'nan']);

/**
 * Whether a value type requires a whole number: a CLR `int` primitive (`int` kind), or a
 * `ModifiableInt` engine scalar (`number` kind). These are the only schema types where a fractional
 * resolved value is unambiguously wrong. The `int`-kind primitives also accept named constants
 * (`Allegiance = Neutral`), but those resolve to `null`, never a fraction, so they are never flagged.
 * Used both for a scalar field and for the element type of a `Range<int>`.
 */
const requiresWholeNumber = (valueType: ValueType): boolean =>
    valueType.kind === 'int' || (valueType.kind === 'number' && valueType.type === 'ModifiableInt');

/**
 * Whole-document schema validation. Runs as a separate pass (the {@link Validator} allows one
 * callback per AstType, and `Assignment` is taken). Deliberately conservative: every check is built
 * to have no false positives on partially-modelled / custom-deserialized classes, unlike unknown-field
 * checks. It flags:
 *   - invalid **enum** / **boolean** values. Enum members must match exactly (the game's
 *     `Enum.Parse` is case-sensitive, so a case-only mismatch gets a dedicated warning with a
 *     casing quick-fix); booleans accept the game's full `true/yes/y`/`false/no/n` word set,
 *   - an invalid `Type=` **discriminator** against the registry inferred for the group,
 *   - a bare **non-numeric word** in a confirmed numeric-scalar field, and
 *   - a value in an **integer-only** field (scalar or a `Range<int>` endpoint) that resolves
 *     (through references and math) to a fraction.
 *
 * Range ordering is intentionally never checked: `Range<T>` endpoints are From→To interpolation
 * bounds, not min/max, and vanilla ships many descending pairs, so a `min>max` check is unsafe.
 */
export const validateSchema = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const errors: ValidationError[] = [];
    // Every container we resolved a concrete class for, collected during the (sync) enum/bool walk so
    // the async integer-resolution pass below can revisit the same fields without re-resolving classes.
    const typedContainers: Array<{ container: { elements: AbstractNode[] }; cls: string }> = [];

    // Flag a `name = <word>` assignment whose schema field is an enum/bool not allowing that bare word.
    // Bare-word values only. `&refs`, expressions, numbers and quoted strings parse as other types.
    const checkEnums = (container: { elements: AbstractNode[] }, cls: string): void => {
        typedContainers.push({ container, cls });
        for (const element of container.elements) {
            if (!isAssignmentNode(element)) continue;
            const value = element.right;
            if (!isValueNode(value) || value.valueType.type !== 'String') continue;
            const field = fieldOf(cls, element.left.name);
            if (!field) continue;
            const written = String(value.valueType.value);

            if (field.valueType.kind === 'enum') {
                const members = enumDef(field.valueType.ref)?.members ?? [];
                if (members.length > 0 && !members.includes(written)) {
                    // The game parses enum values with the case-SENSITIVE `Enum.Parse(type, text)`
                    // (verified in HalflingCore's EnumSerializer), so a member matched only after
                    // case-folding still fails to load in game and deserves its own message.
                    const folded = members.find((m) => m.toLowerCase() === written.toLowerCase());
                    if (folded) {
                        errors.push({
                            message: l10n.t(
                                "'{0}' has the wrong casing. The game's enum parsing is case-sensitive; write '{1}'.",
                                written,
                                folded
                            ),
                            node: value,
                            severity: 'warning',
                            data: { quickFix: { title: l10n.t("Change to '{0}'", folded), newText: folded } },
                        });
                    } else {
                        flag(value, written, field.valueType.name, members, closestMatch(written, members, true));
                    }
                }
            } else if (field.valueType.kind === 'bool') {
                // The game's BooleanSerializer accepts true/yes/y and false/no/n (ignoring case)
                // plus the literal 1/0 (which lex as numbers and never reach this String branch).
                if (!BOOLEAN_WORDS.has(written.toLowerCase())) {
                    const bools = ['true', 'false'];
                    flag(value, written, 'boolean', bools, closestMatch(written, bools, true));
                }
            } else if (field.valueType.kind === 'number' && NUMERIC_SCALAR_TYPES.has(field.valueType.type ?? '')) {
                flagNonNumber(value, written);
            }
        }
    };

    // Flag a bare-word value sitting in a numeric field (e.g. an angle/`Direction` written as a word
    // rather than a number). Only a plain unquoted, unparenthesized identifier that is not a math
    // keyword/constant qualifies. Anything that could be a literal, reference or expression is
    // already a different value type and never reaches here.
    const flagNonNumber = (value: ValueNode, written: string): void => {
        if (value.quoted || value.parenthesized) return;
        const word = written.toLowerCase();
        if (
            !BARE_WORD.test(written) ||
            NUMERIC_LITERAL_WORDS.has(word) ||
            ALL_MATH_FUNCTION_NAMES.has(word)
        ) {
            return;
        }
        errors.push({
            message: l10n.t("'{0}' is not a valid number.", written),
            node: value,
            severity: 'warning',
        });
    };

    const flag = (
        value: AbstractNode,
        written: string,
        typeName: string,
        members: string[],
        suggestion: string | null | undefined
    ): void => {
        errors.push({
            message: l10n.t("'{0}' is not a valid {1}. Expected one of: {2}", written, typeName, members.join(', ')),
            node: value,
            severity: 'warning',
            ...(suggestion
                ? { data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } } }
                : {}),
        });
    };

    // The registry a `Type=`-dispatched group belongs to, but only when we're confident: the slot it
    // sits in is typed as a polymorphic registry (precise), or for custom-deserialized containers
    // with no slot (Components, BulletComponents) a sibling's valid `Type` proves the registry.
    const confidentRegistryFor = (group: GroupNode): SchemaRegistry | undefined => {
        const slot = registryHintFromContainer(group);
        if (slot) return schema.registries[slot];
        const container = group.parent;
        return container && isGroupNode(container) ? registryForContainer(container) : undefined;
    };

    // Flag a `Type = <word>` (in a group or the document root) whose value is not a member of the
    // given registry, the polymorphic analogue of the enum check (closed set, low false-positive
    // risk). Shared by nested groups and whole-file roots.
    const flagInvalidType = (container: { elements: AbstractNode[] }, registry: SchemaRegistry): void => {
        let valueNode: AbstractNode | undefined;
        for (const element of container.elements) {
            if (isAssignmentNode(element) && element.left.name === registry.typeField) {
                valueNode = element.right;
                break;
            }
        }
        if (!valueNode || !isValueNode(valueNode) || valueNode.valueType.type !== 'String') return;
        const written = String(valueNode.valueType.value);
        const members = Object.keys(registry.members);
        if (members.some((m) => m.toLowerCase() === written.toLowerCase())) return;
        // A type that was renamed in a newer game version (a mod written against an older Cosmoteer):
        // say what it became and offer that fix, but only when the new name is valid in THIS registry, so
        // the hint never points at a replacement that wouldn't deserialize here.
        const deprecation = deprecatedDiscriminator(written);
        if (deprecation && members.includes(deprecation.replacement)) {
            errors.push({
                message: l10n.t(
                    "'{0}' was renamed to '{1}' in a newer game version ({2}).",
                    written,
                    deprecation.replacement,
                    deprecation.note
                ),
                node: valueNode,
                severity: 'warning',
                data: {
                    quickFix: {
                        title: l10n.t("Change to '{0}'", deprecation.replacement),
                        newText: deprecation.replacement,
                    },
                },
            });
            return;
        }
        const suggestion = closestMatch(written, members, true);
        errors.push({
            message: l10n.t("'{0}' is not a valid {1} type.", written, registry.name),
            node: valueNode,
            severity: 'warning',
            ...(suggestion
                ? { data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } } }
                : {}),
        });
    };

    // A nested group: validate its `Type=` against the registry confidently inferred from its slot
    // or a valid sibling.
    const checkDiscriminator = (group: GroupNode): void => {
        const registry = confidentRegistryFor(group);
        if (registry) flagInvalidType(group, registry);
    };

    // Whole-file-root documents (e.g. shot files → BulletRules): validate the top-level fields.
    const rootClass = documentRootClass(document);
    if (rootClass) checkEnums(document, rootClass);
    // A whole-file root dispatched by its top-level `Type=` (doodad/effect/music): validate that
    // discriminator against its registry, known by the canonical folder even when it's a typo.
    const rootRegistry = documentRootRegistry(document);
    if (rootRegistry) flagInvalidType(document, rootRegistry);

    const visit = (node: AbstractNode): void => {
        if (cancellationToken.isCancellationRequested) return;
        if (isGroupNode(node)) {
            // A group's class comes from its slot (which disambiguates a `Type=` collision via the
            // container's field type). Only skip when the discriminator is ambiguous and the
            // container gives no hint, where we can't trust the class, so we'd risk a false positive.
            const disc = groupDiscriminator(node);
            const unresolvableAmbiguity = disc && discriminatorIsAmbiguous(disc) && !registryHintFromContainer(node);
            const cls = unresolvableAmbiguity ? undefined : resolveGroupClass(node);
            if (cls) checkEnums(node, cls);
            // A `Type=` that resolves to no class (typo) is caught here against the inferred registry.
            if (disc && !cls) checkDiscriminator(node);
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? [node.right]
                  : [];
        for (const child of children) visit(child);
    };

    // A value sitting in an integer-only field: flag when it resolves to a non-whole number. Unlike
    // the bare-word checks above, this resolves the value, following references through inheritance
    // and evaluating math expressions/functions via the shared evaluator. Anything the evaluator
    // can't reduce to a number (unresolved/runtime refs, named constants, non-numeric strings) yields
    // `null` and is left alone, so the check stays false-positive-free. A `%` operand (e.g. `50%` →
    // 0.5) is skipped, since percentages belong to fractional fields, so a stray one is not a fact.
    const checkInteger = async (value: AbstractNode): Promise<void> => {
        if (isValueNode(value) && /%/.test(String(value.valueType.value))) return;
        const resolved = await evaluateNumericValue(value, cancellationToken).catch(() => null);
        if (resolved === null || Number.isInteger(resolved)) return;
        errors.push({
            message: l10n.t('Expected a whole number, but this value is {0}.', formatNumber(resolved)),
            node: value,
            severity: 'warning',
        });
    };

    // A value in an integer-element `Range<int>` field. The engine accepts a range as either a single
    // scalar (min == max) or a `[from, to]` list, so check each endpoint individually. Range ordering
    // is deliberately not validated: `Range<T>` does not require from <= to. Its endpoints are
    // interpolation bounds (e.g. `VolumeOverIntensity = [1.5, 0.5]` fades down), and vanilla ships
    // many descending pairs, so a min>max check would be a false positive.
    const checkIntegerRange = async (value: AbstractNode): Promise<void> => {
        if (isListNode(value)) {
            for (const endpoint of value.elements) await checkInteger(endpoint);
        } else {
            await checkInteger(value);
        }
    };

    for (const element of document.elements) visit(element);

    // Async pass: integer-constrained fields (scalar or `Range<int>`), revisiting every container
    // whose class we resolved during the synchronous walk above.
    for (const { container, cls } of typedContainers) {
        if (cancellationToken.isCancellationRequested) break;
        for (const element of container.elements) {
            if (!isAssignmentNode(element)) continue;
            const field = fieldOf(cls, element.left.name);
            if (!field) continue;
            if (requiresWholeNumber(field.valueType)) {
                await checkInteger(element.right);
            } else if (field.valueType.kind === 'range' && requiresWholeNumber(field.valueType.element)) {
                await checkIntegerRange(element.right);
            }
        }
    }
    return errors;
};
