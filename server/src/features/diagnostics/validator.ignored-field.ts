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
import { ValidationError } from './validator';
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
                // migration and not just the removal.
                const deprecation = declaredButDead ? deprecatedField(cls, name) : undefined;
                const start = element.left.position.start;
                const end = element.right?.position?.end ?? element.left.position.end;
                errors.push({
                    message: deprecation
                        ? l10n.t("'{0}' was removed in a newer game version ({1}).", name, deprecation.note)
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
                    data: {
                        remove: {
                            title: l10n.t("Remove '{0}'", name),
                            start,
                            end,
                        },
                    },
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
