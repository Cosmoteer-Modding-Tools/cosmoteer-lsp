import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    AssignmentNode,
    GroupNode,
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
    groupClassCandidates,
    groupDiscriminator,
    groupSlotIsAnchored,
    possibleWrapperClasses,
    registryForGroup,
    registryHintFromContainer,
    resolveGroupClass,
} from '../../document/schema/schema-context';
import { classAncestry, discriminatorIsAmbiguous, fieldOf, fieldsOf, schema } from '../../document/schema/schema';
import { deprecatedField } from '../../document/schema/deprecations';
import { ValidationError, ValidationErrorData } from './validator';
import { getStartOfAstNode } from '../../utils/ast.utils';
import * as l10n from '@vscode/l10n';

// Per-document memo of the reference-segment set. Documents are replaced wholesale on re-parse, so
// a WeakMap keyed by the document node needs no explicit invalidation.
const segmentsCache = new WeakMap<AbstractNodeDocument, Set<string>>();

// The SCREAMING_CASE spelling every user-defined constant uses (`HEAT_TARGET_STORAGE`,
// `INTERVALS_TO_FILL`). Constants are read through references, often from other files (a derived
// part reads its base's constants via `&~/Part/^/0/NAME`), which a single-file usage scan cannot
// see, so constant-shaped names are never judged.
const CONSTANT_NAME = /^[A-Z0-9_]*_[A-Z0-9_]*$/;

// Minimum fraction of a group's named members the resolved class must own for a dead-field verdict to
// be trusted. Below this the group has resolved to the wrong class, so its foreign members are an
// artifact of the mis-resolution, not fields the game reads and ignores.
const MIN_CLASS_FIT = 0.5;

/**
 * Whether the resolved class owns a majority of the group's named members, so a member it does not
 * declare is a genuine dead field rather than the whole group having resolved to the wrong class.
 * Mirrors the field-coverage heuristic the schema layer uses to root a group. A group with too few
 * named members (< 3) carries too little signal to judge and is trusted (a lone stray field is far
 * likelier dead weight than a full mis-resolution). The structural `Type=` discriminator is excluded,
 * since it names a registry rather than a member.
 *
 * @param group the group whose class fit is measured.
 * @param cls the class the group resolved to.
 * @returns true when the class owns at least {@link MIN_CLASS_FIT} of the judged members.
 */
const classFitsGroup = (group: GroupNode, cls: string): boolean => {
    const names: string[] = [];
    for (const node of group.elements) {
        const memberName = isAssignmentNode(node)
            ? node.left.name
            : isGroupNode(node) || isListNode(node)
              ? node.identifier?.name
              : undefined;
        if (memberName && memberName.toLowerCase() !== 'type') names.push(memberName);
    }
    if (names.length < 3) return true;
    const owned = names.filter((memberName) => fieldOf(cls, memberName)).length;
    return owned / names.length >= MIN_CLASS_FIT;
};

/** The words the game's BooleanSerializer reads as false (case-insensitively). */
const FALSE_WORDS = new Set(['false', 'no', 'n']);

/**
 * Whether an assignment's value is boolean false (`false`/`no`/`n`, or the numeric literal `0`).
 * Used to tell a `Flammable = false` (a fireproofing the Meltdown update turned into the
 * `non_flammable` part category) from a `Flammable = true` (a stale restatement of the old default).
 *
 * @param value the assignment's right-hand node.
 * @returns true when the value spells boolean false.
 */
const isFalseValue = (value: AbstractNode | null | undefined): boolean => {
    if (!value || !isValueNode(value)) return false;
    if (value.valueType.type === 'Boolean') return value.valueType.value === false;
    if (value.valueType.type === 'String') return FALSE_WORDS.has(String(value.valueType.value).toLowerCase());
    if (value.valueType.type === 'Number') return Number(value.valueType.value) === 0;
    return false;
};

/**
 * Whether the group assigns the named member beside `except` (as an assignment, group, or list), so
 * a mechanical rename onto that name would create a duplicate member.
 *
 * @param group the group whose members are checked.
 * @param name the member name to look for (compared case-insensitively).
 * @param except the element making the query, excluded from the search.
 * @returns true when another element already carries the name.
 */
const siblingNamed = (group: GroupNode, name: string, except: AbstractNode): boolean => {
    const wanted = name.toLowerCase();
    return group.elements.some(
        (sibling) =>
            sibling !== except &&
            ((isAssignmentNode(sibling) && sibling.left.name.toLowerCase() === wanted) ||
                ((isGroupNode(sibling) || isListNode(sibling)) && sibling.identifier?.name.toLowerCase() === wanted))
    );
};

/**
 * The group's own `TypeCategories` list literal, in either spelling (`TypeCategories = […]` or the
 * bare list form `TypeCategories […]`), when it has a closing bracket to append into. Only the
 * doc-local list qualifies: writing a fresh `TypeCategories` assignment would override an inherited
 * list, so a part without a local one is reported for manual review instead of auto-fixed.
 *
 * @param group the part group to search.
 * @returns the local list node, or undefined when the group has none (or an unclosed one).
 */
const localTypeCategoriesList = (group: GroupNode): ListNode | undefined => {
    for (const element of group.elements) {
        const list = isListNode(element)
            ? element
            : isAssignmentNode(element) && element.right && isListNode(element.right)
              ? element.right
              : undefined;
        const name = isListNode(element) ? element.identifier?.name : isAssignmentNode(element) ? element.left.name : undefined;
        if (list && name?.toLowerCase() === 'typecategories' && list.position.end > list.position.start) return list;
    }
    return undefined;
};

/**
 * Add every `/`-separated word of a reference path to `out`, lower-cased, with the `<file>` part
 * removed.
 *
 * @param text the reference path text.
 * @param out the set collecting the lower-cased segments.
 */
const addSegments = (text: string, out: Set<string>): void => {
    const withoutFile = text.replace(/<[^>]*>/g, ' ');
    for (const raw of withoutFile.split('/')) {
        const segment = raw.replace(/[&~^.:\s]/g, '');
        if (segment) out.add(segment.toLowerCase());
    }
};

/**
 * Every path segment used by any reference in the document, lower-cased: reference values (including
 * function arguments and math operands), inheritance lists, and bare `&…` members (which parse as
 * IdentifierNodes). A field name in this set may be read through a reference, so it is never treated
 * as ignored.
 *
 * @param document the parsed document to index.
 * @returns the set of lower-cased referenced path segments.
 */
export const referencedSegments = (document: AbstractNodeDocument): Set<string> => {
    const cached = segmentsCache.get(document);
    if (cached) return cached;
    const out = new Set<string>();
    const visit = (node: AbstractNode | null | undefined): void => {
        if (!node) return;
        if (isValueNode(node)) {
            if (node.valueType.type === 'Reference') {
                addSegments(String(node.valueType.value), out);
            } else if (node.valueType.type === 'String') {
                // A quoted expression string is re-evaluated by the game (`HEAT_PER_INTERVAL =
                // ceil("(&A) / (&B)")`), so references embedded in any string value count as reads.
                for (const embedded of String(node.valueType.value).match(/&[^\s()"]+/g) ?? []) {
                    addSegments(embedded, out);
                }
            }
            return;
        }
        if (isIdentifierNode(node)) {
            if (node.name.startsWith('&')) addSegments(node.name, out);
            return;
        }
        if (isGroupNode(node) || isListNode(node) || isDocumentNode(node)) {
            if (!isDocumentNode(node)) for (const inherited of node.inheritance ?? []) visit(inherited);
            for (const child of node.elements) visit(child);
        } else if (isAssignmentNode(node)) {
            visit(node.right);
        } else if (isFunctionCallNode(node)) {
            for (const argument of node.arguments) visit(argument);
        } else if (isMathExpressionNode(node)) {
            for (const element of node.elements) visit(element);
        }
    };
    visit(document);
    segmentsCache.set(document, out);
    return out;
};

/**
 * Whether the named member of `group` is provably ignored by the game: the group resolves to a
 * `purelyReflective` class (schemagen proved its whole `extends` chain reads only its `[Serialize]`
 * members, so the member list is the complete set of keys the engine reads), the class does not
 * declare the name, and no reference in the document reads it. Deliberately conservative, every
 * uncertainty answers false:
 *  - the class must resolve, be `purelyReflective`, and not be the polymorphic-registry fallback (an
 *    unresolved `Type=` means the real derived class, and its fields, are unknown). The reflective
 *    guarantee is what makes "key absent from the member list" mean "unread": a class with any custom
 *    deserialization hook (`scalarForm`/`scalarStringForm`/`valueForm`, a bespoke wrapper serializer,
 *    a generic `*FromPath` read) reads content the reflected member list does not capture, so it is
 *    not `purelyReflective` and is left alone,
 *  - the class must have at least one known field (an empty member list means the class is opaque,
 *    not that everything is dead),
 *  - the name must not be the registry's `Type` discriminator, a positional digit field, a shader
 *    `_constant`, or a SCREAMING_CASE user constant (readable from other files), and
 *  - the name must not appear as a path segment of any reference in the document, including
 *    references embedded in quoted expression strings, which covers the constant idiom
 *    (`BASE_SPRITE = foo.png` read via `&BASE_SPRITE`) and cross-group reads.
 *
 * @param group the group containing the member.
 * @param name the member's written field name.
 * @param document the containing document, for the reference-usage scan.
 * @returns the resolved class FullName when the field is provably ignored, undefined otherwise.
 */
export const ignoredFieldClass = (group: GroupNode, name: string, document: AbstractNodeDocument): string | undefined => {
    if (/^\d+$/.test(name)) return undefined;
    // A `_`-prefixed name is a shader constant the engine passes to the shader by name (`_hotColor`
    // on a Sprite/Material group), never a schema member. The shader-constant validator owns those.
    if (name.startsWith('_')) return undefined;
    if (CONSTANT_NAME.test(name)) return undefined;
    const typeField = registryForGroup(group)?.typeField ?? 'Type';
    if (name.toLowerCase() === typeField.toLowerCase() || name.toLowerCase() === 'type') return undefined;
    const disc = groupDiscriminator(group);
    const slotRegistry = registryHintFromContainer(group);
    if (disc && discriminatorIsAmbiguous(disc) && !slotRegistry) return undefined;
    const cls = resolveGroupClass(group);
    if (!cls || cls === slotRegistry) return undefined;
    // Resolution-confidence guard: when the resolved class owns almost none of the group's members, the
    // whole group resolved to the wrong class, so a member it does not declare is foreign for the wrong
    // reason. A beam-emitter fragment self-resolves through its own `Type = Beam` to the media-effect
    // `BeamEffectRules`, which owns none of its `Range`/`IdealRange`/`Duration` weapon fields, and a
    // floor part pulled in through a `DamageLevels` reference roots as `DamageLevelSprites`, which owns
    // none of its part fields. A genuine dead field is one stray among members the class does own, so
    // only a group the class clearly fits is judged. A slot-pinned dispatch is exempt from the guard:
    // when the container's declared field type names the registry and the group's own `Type=` picked
    // the class from that registry's members, the resolution replays the game's deserializer exactly,
    // so a poor fit does not signal a mis-resolution but a group that genuinely carries mostly dead
    // fields, which is precisely the group the hint helps most. The mis-resolutions the guard defends
    // against never have both anchors agreeing.
    const slotPinned =
        !!disc && !!slotRegistry && Object.values(schema.registries[slotRegistry]?.members ?? {}).includes(cls);
    if (!slotPinned && !classFitsGroup(group, cls)) return undefined;
    const def = schema.types[cls];
    // The class must be purely reflective (its member list is the complete read set) and concrete. An
    // abstract class or interface is never the runtime type, so the group's real deserializer is some
    // derived class whose own fields and custom read hooks we cannot see through the base view. A sound
    // group typed as the `ISoundEffect` interface is really a `SoundEffect` whose ReadContentFrom reads
    // `Sound`/`Db`, and a component typed as the abstract `PartComponentRules` base adds fields downstream.
    if (!def?.purelyReflective || def.abstract) return undefined;
    if (fieldsOf(cls).length === 0) return undefined;
    // A wrapper-delegation slot reads the wrapper's fields and the dispatched member's from the
    // same group, so a field owned by any candidate class (the primary is the first) is a real read
    // key, no matter which side won the single-valued class pick.
    if (groupClassCandidates(group).some((candidate) => fieldOf(candidate, name))) return undefined;
    // A self-resolved group (no slot anchors its class: an unrooted fragment wired in through mod
    // actions) may really fill a wrapper slot whose value form delegates to the resolved class's
    // registry, and the wrapper's own fields are read from the same flat group (a stat widget's
    // ToggleButtonID). The slot that would reveal the wrapper is invisible here, so a field any
    // possible wrapper class owns is not provably ignored. A slot-anchored group is exempt: there
    // the candidate derivation above already names the exact companion, and the suppression must
    // not eat genuine findings on groups whose slot proves no wrapper is in play.
    if (!groupSlotIsAnchored(group) && possibleWrapperClasses(cls).some((wrapper) => fieldOf(wrapper, name))) {
        return undefined;
    }
    if (referencedSegments(document).has(name.toLowerCase())) return undefined;
    return cls;
};

/**
 * Whether an asset-typed value sits in a field the game provably ignores (see
 * {@link ignoredFieldClass}), so an asset-existence warning on it would be meaningless. The
 * canonical case is the vanilla `Filename = SmoothFalloffRamp.png` inside `Type = ValueCurve`
 * particle updaters: dev-editor metadata next to the baked `Points` array, on a class whose
 * explicit serialization never reads a `Filename`.
 *
 * @param node the asset-typed value node the asset check is about to validate.
 * @returns true when the value's field is provably ignored by the game.
 */
export const isIgnoredSchemaField = (node: ValueNode): boolean => {
    const group = node.parent;
    if (!group || !isGroupNode(group)) return false;
    const assignment = group.elements.find(
        (element): element is AssignmentNode => isAssignmentNode(element) && element.right === node
    );
    if (!assignment) return false;
    return ignoredFieldClass(group, assignment.left.name, getStartOfAstNode(node)) !== undefined;
};

/**
 * The lower-cased names of every schema field flagged `dead` (declared by the game but never read
 * by its code, per schemagen's whole-assembly read scan), so the per-assignment check below can
 * bail on cheap name membership before resolving any group class or ancestry. Built once at module
 * init. The schema is immutable after load.
 */
const deadFieldNames = new Set<string>();
for (const type of Object.values(schema.types)) {
    for (const field of type.fields) {
        if (field.dead) deadFieldNames.add(field.name.toLowerCase());
    }
}

/**
 * The declaring class when the named member of `group` is a known dead declaration: the field
 * exists on the schema, but schemagen's whole-assembly read scan found no code that reads it (the
 * `dead` flag on the schema field). The field is checked against the group class's whole ancestry,
 * since it can be declared on a base, and the declaring ancestor is returned so the hint names the
 * class that owns the declaration. The name-set bail keeps the class resolution off the hot path
 * (this runs for every assignment in the document), and the reference-segment suppression matches
 * {@link ignoredFieldClass}: references resolve at parse time in ObjectText, so a mod that writes a
 * dead field and reads it via `(&~/…)` in the same file uses it for real.
 *
 * @param group the group containing the member.
 * @param name the member's written field name.
 * @param document the containing document, for the reference-usage scan.
 * @returns the class FullName that declares the dead field, or undefined.
 */
const deadDeclaredFieldClass = (group: GroupNode, name: string, document: AbstractNodeDocument): string | undefined => {
    if (!deadFieldNames.has(name.toLowerCase())) return undefined;
    if (referencedSegments(document).has(name.toLowerCase())) return undefined;
    const cls = resolveGroupClass(group);
    if (!cls || !fieldOf(cls, name)?.dead) return undefined;
    const lowered = name.toLowerCase();
    return classAncestry(cls).find((ancestor) =>
        schema.types[ancestor]?.fields.some((field) => field.dead && field.name.toLowerCase() === lowered)
    );
};

/**
 * Whole-document pass flagging fields the game ignores: a named assignment inside a schema-resolved
 * group whose class does not declare the name and that no reference in the file reads. Emitted as a
 * hint (the field is dead weight, not an error) with a remove quick fix. Only assignments are
 * flagged: an identified subgroup with an unknown name can still be an id-referenced declaration
 * (component/toggle ids are read by name from plain string fields), which a reference scan cannot see.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk.
 * @returns the hints for provably ignored fields.
 */
export const validateIgnoredFields = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const errors: ValidationError[] = [];
    const visit = (node: AbstractNode): void => {
        if (cancellationToken.isCancellationRequested) return;
        if (isGroupNode(node)) {
            for (const element of node.elements) {
                if (!isAssignmentNode(element)) continue;
                const name = element.left.name;
                const cls = ignoredFieldClass(node, name, document) ?? deadDeclaredFieldClass(node, name, document);
                if (!cls) continue;
                const classLabel = schema.types[cls]?.name ?? cls;
                const declaredButDead = !!fieldOf(cls, name);
                // A field the game deleted in an update (a mod written against an older Cosmoteer):
                // say what replaced it instead of the bare never-reads hint, so the modder learns the
                // migration and not just the removal. The registry records the declaring class, so a
                // derived resolution walks its ancestry to find the entry.
                let deprecation: ReturnType<typeof deprecatedField>;
                for (const ancestor of classAncestry(cls)) deprecation ??= deprecatedField(ancestor, name);
                const start = element.left.position.start;
                const end = element.right?.position?.end ?? element.left.position.end;
                const data: ValidationErrorData = {
                    remove: {
                        title: l10n.t("Remove '{0}'", name),
                        start,
                        end,
                    },
                };
                if (deprecation) {
                    data.migration = { version: deprecation.version };
                    if (deprecation.replacement && !siblingNamed(node, deprecation.replacement, element)) {
                        // A same-shaped successor took over the deleted field's job: renaming keeps
                        // the author's configured value alive, which a bare removal would drop.
                        data.migration.apply = 'rewrite';
                        data.rewrite = {
                            title: l10n.t("Change to '{0}'", deprecation.replacement),
                            edits: [
                                {
                                    start: element.left.position.start,
                                    end: element.left.position.end,
                                    newText: deprecation.replacement,
                                },
                            ],
                        };
                    } else if (name.toLowerCase() === 'flammable') {
                        if (isFalseValue(element.right)) {
                            // `Flammable = false` was a fireproofing, and since Meltdown that
                            // intent is spelled as the `non_flammable` part category. Only a
                            // doc-local `TypeCategories` list can be appended to safely (a fresh
                            // assignment would override an inherited list), so without one the
                            // finding stays manual.
                            const categories = localTypeCategoriesList(node);
                            if (categories) {
                                data.migration.apply = 'rewrite';
                                data.rewrite = {
                                    title: l10n.t("Replace with a 'non_flammable' TypeCategories entry"),
                                    edits: [
                                        { start, end, newText: '' },
                                        {
                                            start: categories.position.end - 1,
                                            end: categories.position.end - 1,
                                            newText: categories.elements.length > 0 ? ', non_flammable' : 'non_flammable',
                                        },
                                    ],
                                };
                            }
                        } else {
                            // `Flammable = true` restates the old default: removal is the migration.
                            data.migration.apply = 'remove';
                        }
                    } else if (deprecation.removeOnMigrate || deprecation.replacement) {
                        // Removal is sanctioned: the field is officially unused, or its still-present
                        // successor already carries the configuration beside it.
                        data.migration.apply = 'remove';
                    }
                }
                errors.push({
                    message: deprecation
                        ? deprecation.version
                            ? l10n.t("'{0}' was removed in game version {1} ({2}).", name, deprecation.version, deprecation.note)
                            : l10n.t("'{0}' was removed in a newer game version ({1}).", name, deprecation.note)
                        : declaredButDead
                        ? l10n.t("'{0}' is declared by {1} but the game's code never reads it.", name, classLabel)
                        : l10n.t(
                              "'{0}' is not a member of {1} and is never referenced in this file, so the game ignores it.",
                              name,
                              classLabel
                          ),
                    node: element.left,
                    // Fade the value along with the key: the game reads neither, and the span then
                    // matches what the remove fix deletes.
                    range: { start, end },
                    severity: 'hint',
                    unnecessary: true,
                    data,
                });
            }
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
                  : [];
        for (const child of children) if (child) visit(child);
    };
    for (const element of document.elements) visit(element);
    return errors;
};
