import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isGroupNode,
    isIdentifierNode,
    isListNode,
    isMathExpressionNode,
    isValueNode,
    ListNode,
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
import {
    discriminatorIsAmbiguous,
    enumDef,
    fieldOf,
    fieldsOf,
    schema,
    valueTypeLabel,
} from '../../document/schema/schema';
import { deprecatedDiscriminator } from '../../document/schema/deprecations';
import { SchemaField, SchemaRegistry, ValueType } from '../../document/schema/schema.types';
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

// The schema kinds whose deserializer never evaluates math: the game reads the raw text of the
// value (or feeds it to Enum.Parse / the boolean or reference parser), so a math expression written
// there is a silent bug. Container kinds and numerics are excluded, as are the `int`/`float`
// primitives with their custom name-accepting deserializers.
const TEXTUAL_KINDS = new Set(['string', 'enum', 'bool', 'reference']);

// The container kinds a `valueForm` delegation cannot read a scalar through.
const CONTAINER_KINDS = new Set(['group', 'polymorphicGroup', 'map', 'list', 'range', 'interpolated', 'tuple']);

// Whether a group-kind class reads a plain scalar value: its own deserialization hook
// (`scalarForm`), a name-lookup wrapper (`scalarStringForm`, strings only), or its
// `[Serialize(Alias = "")]` value-form delegation when the delegated kind is itself scalar,
// followed through group delegations (a proxy delegates to the group-only ProxyRules and stays
// flagged). All three flags are extracted from the engine's own deserializers by schemagen, so a
// game update refreshes them through the normal schema regeneration. Polymorphic registries are
// exempt in {@link checkValueForm} itself (their `valueField` mechanism gives every registry a
// legal scalar shorthand, `ValueCombiner = Add`).
const classReadsScalar = (classRef: string, isString: boolean, depth = 0): boolean => {
    const def = schema.types[classRef];
    if (!def || depth > 4) return false;
    if (def.scalarForm) return true;
    if (def.scalarStringForm && isString) return true;
    const form = def.valueForm;
    if (!form) return false;
    if (form.kind === 'group') return classReadsScalar(form.ref, isString, depth + 1);
    return !CONTAINER_KINDS.has(form.kind);
};

// Whether a group-kind class legally reads a list value through its value-form delegation
// (`MultiHitEffectRules` binds a `HitEffectRules[]` member to the node itself), which makes its
// list spelling something the game reads rather than a positional group form to second-guess.
const classReadsList = (classRef: string, depth = 0): boolean => {
    const form = schema.types[classRef]?.valueForm;
    if (!form || depth > 4) return false;
    if (form.kind === 'group') return classReadsList(form.ref, depth + 1);
    return form.kind === 'list' || form.kind === 'range' || form.kind === 'interpolated';
};

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
 *   - a bare **non-numeric word** in a confirmed numeric-scalar field,
 *   - a value in an **integer-only** field (scalar or a `Range<int>` endpoint) that resolves
 *     (through references and math) to a fraction,
 *   - **math in a textual field** (string/enum/bool/reference), where the game reads the
 *     expression as literal text instead of evaluating it, and
 *   - a **named member inside a group-typed field's list form** that the class does not own
 *     (`Offset [Scale2In = offset]` on a renderer), which the game silently never reads.
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
            // A bare valueless field (`ScaleIn` alone on a line) deserializes as null, which the
            // game only tolerates for nullable member types. On a non-nullable one it throws a
            // DeserializeException at load. Only flagged when the schema knows the field is
            // non-nullable, so partially-modelled classes stay silent.
            if (isIdentifierNode(element)) {
                const field = fieldOf(cls, element.name);
                if (field?.nullable === false) {
                    errors.push({
                        message: l10n.t(
                            "'{0}' has no value. The game reads a valueless field as null and fails to load it into a non-nullable {1}.",
                            element.name,
                            valueTypeLabel(field.valueType)
                        ),
                        node: element,
                        severity: 'warning',
                    });
                }
                continue;
            }
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
                valueNode = element.right ?? undefined;
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
            const slotRegistry = registryHintFromContainer(node);
            const unresolvableAmbiguity = disc && discriminatorIsAmbiguous(disc) && !slotRegistry;
            const cls = unresolvableAmbiguity ? undefined : resolveGroupClass(node);
            if (cls) checkEnums(node, cls);
            // A `Type=` that resolves to no class (typo) is caught here against the inferred
            // registry. A polymorphic slot needs one more case: it resolves the group to the
            // registry base itself when the discriminator matches no member (that fallback keeps
            // the base's fields working), so a slot-typed group whose class is exactly that
            // fallback validates its discriminator too. A concrete resolution (including the
            // sector spawners whose `Type = Doodads` dispatches beyond the slot registry's own
            // member map) is proof the game reads it and stays silent. A deprecated name is the
            // exception: it resolves through its rename as an editing courtesy, but the game does
            // not read it, so it must still surface the rename hint.
            if (disc && (!cls || cls === slotRegistry || deprecatedDiscriminator(disc))) checkDiscriminator(node);
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
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

    // A group-typed field written in its positional list form (`GridSize = [1, 2]`): the game
    // deserializer reads element N through the class's digit field `"N"` (the same fallback that
    // makes `[7.2, 7.2]` a legal Vector2), so an integer-constrained component (IntVector2,
    // IntRect, …) is checked exactly like its group-form counterpart. Classes without digit
    // fields simply have no positional field to check against.
    const checkPositionalElements = async (list: ListNode, classRef: string): Promise<void> => {
        // An inheriting list (`X : base [ … ]`) appends its local elements after the inherited
        // ones, so the local index is not the game index and the check must stay silent. A class
        // with a list-reading value form has no positional digit semantics either.
        if (list.inheritance?.length || classReadsList(classRef)) return;
        for (const [index, element] of list.elements.entries()) {
            const positional = fieldOf(classRef, String(index));
            if (positional && requiresWholeNumber(positional.valueType)) await checkInteger(element);
        }
    };

    // Whether an AST list element maps one-to-one onto a game list element. The game only ends a
    // list element at `,`, `;`, a line break or `]`, while the parser splits a math run like
    // `[.25 +4/64, 0]` into more nodes than the game reads, so any math/call/parenthesized element
    // makes every index in the list unreliable. Plain value nodes are safe: the lexer merges a
    // separator-less run (`[1 2 3]`) into one string node, so multiple value nodes prove real
    // separators. Vanilla ships many math-in-vector lists (`Location = [-11/64, -.15]`), which is
    // exactly the shape this predicate exempts.
    const isAtomicListElement = (element: AbstractNode): boolean =>
        isGroupNode(element) ||
        isListNode(element) ||
        isAssignmentNode(element) ||
        (isValueNode(element) &&
            !element.parenthesized &&
            (element.valueType.type === 'Number' || element.valueType.type === 'String'));

    // A named member inside a group-typed field's list form (`Offset [Scale2In = offset]`): the
    // game reads list-form members positionally through the class's digit fields or by the class's
    // own member names, so a name the class does not own is silently ignored. The classic trap is
    // a field of the enclosing group written inside the brackets, where the author meant it one
    // level up, and that case gets its own move-it-out message. Everything else gets a did-you-mean
    // against the class's members when one is close. Unnamed elements past the class's digit fields
    // (`Offset [0, 1, 2, 3]` on a Vector2, which reads only elements 0 and 1) are dead the same
    // way, flagged per element so every unread value shows, but only when every element is atomic
    // (see {@link isAtomicListElement}) so the AST indices are the game indices. Both checks stay
    // silent on an inheriting list (local indices are not the game indices) and the positional one
    // also needs the class to declare digit fields at all, so a custom-deserialized list form is
    // never second-guessed.
    const checkListFormMembers = (
        list: ListNode,
        classRef: string,
        containerCls?: string,
        declaredName?: string
    ): void => {
        if (list.inheritance?.length) return;
        // A class whose value-form delegation is itself a list (`HitEffects [ … ]` binds an
        // effect array) reads its list spelling directly, so there is no positional group form
        // to hold the elements against.
        if (classReadsList(classRef)) return;
        const digitFieldCount = list.elements.every(isAtomicListElement)
            ? fieldsOf(classRef).filter((member) => /^\d+$/.test(member.name)).length
            : 0;
        for (const [index, element] of list.elements.entries()) {
            const nameNode = isAssignmentNode(element)
                ? element.left
                : isGroupNode(element) || isListNode(element)
                  ? element.identifier
                  : undefined;
            const classLabel = schema.types[classRef]?.name ?? classRef;
            if (!nameNode) {
                if (digitFieldCount > 0 && !fieldOf(classRef, String(index))) {
                    errors.push({
                        message: l10n.t(
                            '{0} reads only the first {1} list elements, so the game never reads this one.',
                            classLabel,
                            String(digitFieldCount)
                        ),
                        node: element,
                        severity: 'warning',
                    });
                }
                continue;
            }
            if (/^\d+$/.test(nameNode.name) || fieldOf(classRef, nameNode.name)) continue;
            if (containerCls && declaredName && fieldOf(containerCls, nameNode.name)) {
                errors.push({
                    message: l10n.t(
                        "'{0}' is not a member of {1}, so the game never reads it here. It is a field of the enclosing group and belongs outside the '{2}' brackets.",
                        nameNode.name,
                        classLabel,
                        declaredName
                    ),
                    node: nameNode,
                    severity: 'warning',
                });
                continue;
            }
            const members = fieldsOf(classRef)
                .map((member) => member.name)
                .filter((name) => !/^\d+$/.test(name));
            const suggestion = closestMatch(nameNode.name, members, true);
            errors.push({
                message: l10n.t(
                    "'{0}' is not a member of {1}, so the game never reads it here.",
                    nameNode.name,
                    classLabel
                ),
                node: nameNode,
                severity: 'warning',
                ...(suggestion
                    ? { data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } } }
                    : {}),
            });
        }
    };

    // A `list<group>` field whose entries are positional lists themselves (`EditorParentParts =
    // [ [hull_part, 1] ]`, a route generator's `Routes`): each entry checks like a directly-written
    // positional group value.
    const checkPositionalEntries = async (value: AbstractNode, elementClassRef: string): Promise<void> => {
        if (!isListNode(value)) return;
        for (const entry of value.elements) {
            if (isListNode(entry)) {
                checkListFormMembers(entry, elementClassRef);
                await checkPositionalElements(entry, elementClassRef);
            }
        }
    };

    for (const element of document.elements) visit(element);

    // A math expression or function call written into a field whose deserializer never evaluates
    // math: the game reads it as literal text, so it silently ships broken. Only flagged when the
    // shared evaluator can reduce the value to a number, which is what proves it IS math. A
    // parenthesized text value (`Name = Big Gun (Mk2)`) or an expression over unresolved references
    // evaluates to `null` and is left alone, keeping the check false-positive-free.
    const checkMathOnTextField = async (value: AbstractNode, fieldName: string, valueType: ValueType) => {
        const resolved = await evaluateNumericValue(value, cancellationToken).catch(() => null);
        if (resolved === null) return;
        errors.push({
            message: l10n.t(
                "'{0}' is a {1} field; the game does not evaluate math here and reads the value as literal text.",
                fieldName,
                valueTypeLabel(valueType)
            ),
            node: value,
            severity: 'warning',
        });
    };

    // A value written in a structural shape the field's deserializer never reads. The game loads
    // such a file without error and silently misreads or drops the value, so the mismatch gets a
    // warning: a list on a scalar/map/polymorphic field, a group on a textual or plain numeric
    // field, and elements past what a range (two endpoints) or tuple (fixed arity) reads. The
    // table errs on silence to honor the zero-false-positive contract: scalar values are never
    // flagged (many group types also read an uncaptured scalar form, `Time` being the canonical
    // case), asset fields accept groups (the `Texture` dual form), list-kind fields accept groups
    // (custom collection deserializers), extras only count when every element is atomic, and
    // opaque/constructed/generic kinds are skipped entirely.
    const checkValueForm = (field: SchemaField, value: AbstractNode, writtenName: string): void => {
        const vt = field.valueType;
        const flagForm = (form: string): void => {
            errors.push({
                message: l10n.t(
                    "'{0}' is a {1} field. The game cannot read a {2} value here.",
                    writtenName,
                    valueTypeLabel(vt),
                    form
                ),
                node: value,
                severity: 'warning',
            });
        };
        if (isListNode(value) && !value.inheritance?.length) {
            const arity = vt.kind === 'range' ? 2 : vt.kind === 'tuple' ? vt.elements.length : undefined;
            if (arity !== undefined && value.elements.every(isAtomicListElement)) {
                for (const extra of value.elements.slice(arity)) {
                    errors.push({
                        message: l10n.t(
                            "'{0}' reads only {1} list elements, so the game never reads this one.",
                            writtenName,
                            String(arity)
                        ),
                        node: extra,
                        severity: 'warning',
                    });
                }
            } else if (
                vt.kind === 'polymorphicGroup' ||
                vt.kind === 'bool' ||
                vt.kind === 'string' ||
                vt.kind === 'reference' ||
                vt.kind === 'int' ||
                vt.kind === 'float' ||
                vt.kind === 'number' ||
                vt.kind === 'asset' ||
                vt.kind === 'code'
            ) {
                // Enum fields are exempt: a `[Flags]` enum reads a list of members
                // (`ExternalWalls = [Left, Right]` all over vanilla) and the schema does not
                // capture which enums are flags. Map fields are exempt too: the game's map
                // deserializer also accepts a list of entries (`RenderLayers`, `…ByCell`).
                flagForm(l10n.t('list'));
            }
        } else if (isGroupNode(value) && !value.inheritance?.length) {
            const groupFormless =
                (vt.kind === 'int' || vt.kind === 'float' || vt.kind === 'number') && !vt.groupForm;
            if (TEXTUAL_KINDS.has(vt.kind) || groupFormless) flagForm(l10n.t('group'));
        } else if (isValueNode(value)) {
            // A literal scalar in a group/map slot (`Offset = 5`), which only the custom-serialized
            // classes in {@link SCALAR_FORM_GROUP_CLASSES} can read. References stay silent (any
            // group field legally takes `&ref`), as do asset-typed values, whose classes read paths.
            const literal =
                value.valueType.type === 'String' ||
                value.valueType.type === 'Number' ||
                value.valueType.type === 'Boolean';
            const isString = value.valueType.type === 'String';
            const scalarLegal =
                vt.kind === 'group' &&
                (classReadsScalar(vt.ref, isString) || (field.scalarStringForm === true && isString));
            if (literal && !scalarLegal && (vt.kind === 'map' || vt.kind === 'group')) {
                flagForm(l10n.t('plain'));
            }
        }
    };

    // Async pass: integer-constrained fields (scalar or `Range<int>`) and math written into a
    // textual field, revisiting every container whose class we resolved during the synchronous
    // walk above.
    for (const { container, cls } of typedContainers) {
        if (cancellationToken.isCancellationRequested) break;
        for (const element of container.elements) {
            // An identified list member (`GridSize [1, 2]`) is the assignment-less spelling of the
            // positional list form, so it takes the same per-element check.
            if (isListNode(element) && element.identifier) {
                const field = fieldOf(cls, element.identifier.name);
                if (field?.valueType.kind === 'group') {
                    checkListFormMembers(element, field.valueType.ref, cls, element.identifier.name);
                    await checkPositionalElements(element, field.valueType.ref);
                } else if (field?.valueType.kind === 'list' && field.valueType.element.kind === 'group') {
                    await checkPositionalEntries(element, field.valueType.element.ref);
                } else if (field) {
                    checkValueForm(field, element, element.identifier.name);
                }
                continue;
            }
            // An identified group member (`Mode { … }` where the field is scalar-kind) takes the
            // same structural check as its assignment spelling.
            if (isGroupNode(element) && element.identifier) {
                const field = fieldOf(cls, element.identifier.name);
                if (field) checkValueForm(field, element, element.identifier.name);
                continue;
            }
            if (!isAssignmentNode(element) || !element.right) continue;
            const field = fieldOf(cls, element.left.name);
            if (!field) continue;
            checkValueForm(field, element.right, element.left.name);
            if (requiresWholeNumber(field.valueType)) {
                await checkInteger(element.right);
            } else if (field.valueType.kind === 'range' && requiresWholeNumber(field.valueType.element)) {
                await checkIntegerRange(element.right);
            } else if (field.valueType.kind === 'group' && isListNode(element.right)) {
                checkListFormMembers(element.right, field.valueType.ref, cls, element.left.name);
                await checkPositionalElements(element.right, field.valueType.ref);
            } else if (field.valueType.kind === 'list' && field.valueType.element.kind === 'group') {
                await checkPositionalEntries(element.right, field.valueType.element.ref);
            } else if (
                TEXTUAL_KINDS.has(field.valueType.kind) &&
                (isMathExpressionNode(element.right) || isFunctionCallNode(element.right))
            ) {
                await checkMathOnTextField(element.right, field.name, field.valueType);
            }
        }
    }
    return errors;
};
