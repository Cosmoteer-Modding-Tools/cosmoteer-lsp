import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isListNode } from '../../core/ast/ast';
import { classAncestry } from '../../document/schema/schema';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { flattenListMember } from '../../semantics/effective-group';
import { PART_RULES_CLASS } from '../part-editor/part-fields';
import { memberNameOf } from '../../semantics/reference-resolver';
import { booleanOf, childNamed, enumNameOf } from '../part-editor/vector-forms';
import { ValidationError } from './validator';

/**
 * Whole-document pass (on by default): a buff modifier, a buff clamp or a buff toggle naming a buff its own
 * part never receives, so the value it drives can never move.
 *
 * The rule is the game's, read out of `Cosmoteer.dll`. `Part.OnAttaching` registers the part with
 * `ship.Parts.GetBuffManager(buff).AddBuffReceiver(this)` once per entry of `Rules.ReceivableBuffs`
 * and for nothing else, and `IBuffReceiver.OnBuffAdded` is the only writer of the `_buffs` dictionary
 * every consumer reads. A buff outside that set therefore has no value on this part at any point in
 * its life: `Part.Buffs` never gets a key for it.
 *
 * What makes the check decidable is the list-merge rule, read out of `HalflingCore.dll`:
 * `OTListNode.GetInheritedLists` returns nothing when the list carries no inheritance list of its
 * own, so `ReceivableBuffs [ … ]` replaces the base's set outright, while
 * `ReceivableBuffs : ^/0/ReceivableBuffs [ … ]` prepends it. The second form is how a part usually
 * picks a buff up, from a shared base such as `ships/base_part_overclock.rules` rather than from its
 * own file, which is why a check without full chain resolution is a false-positive machine and why
 * this one refuses to answer at all when any hop of the chain could not be read.
 *
 * Everything below narrows to what can be proven:
 *
 *   - Only a part group writing its own `ID` is judged. A template completed by deriving files
 *     declares the modifier while the derivers declare the buff set, and judging it in isolation
 *     would blame a file for what its derivers supply.
 *   - Only consumer fields are judged. The six `BasePartBuffProviderRules` subclasses and their
 *     `ChainsFromBuffType` name a buff the part *supplies* to others, which has nothing to do with
 *     what it receives, and `NebulaBuffRules` is not a part at all.
 *   - `BuffMultiProxyRules.IncomingBuffTypes` is deliberately not judged. It reads like a consumer,
 *     but the runtime class behind it could not be decompiled, so the requirement is unproven.
 *   - A part a mod's action injects members into is skipped when the injection touches the buff set.
 */

const BUFF_MODIFIER_CLASS = 'Cosmoteer.Ships.BuffModifier';
const MODIFIABLE_VALUE_CLASS = 'Cosmoteer.Ships.ModifiableValue';
const BUFF_TOGGLE_CLASS = 'Cosmoteer.Ships.Parts.Buffs.PartBuffToggleRules';
const RECEIVABLE_BUFFS = 'ReceivableBuffs';

/** The part-root maps keyed by buff, whose keys are consumers of the same set. */
const CLAMP_FIELDS = ['MinBuffValues', 'MaxBuffValues'] as const;

/**
 * A buff id as the game writes one: the identifier grammar, nothing else. A written entry keeps the
 * sigils of whatever it is (`&HEAT_BUFFS` stays `&HEAT_BUFFS`), so this is what separates a buff
 * named outright from a reference standing in for one, which this pass cannot expand and must never
 * mistake for a name.
 */
const PLAIN_BUFF_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * A written value read as a plain buff id.
 *
 * @param node the written value.
 * @returns the id, or null when the value is anything this pass cannot resolve to one name.
 */
const plainBuffName = (node: AbstractNode | null | undefined): string | null => {
    const name = enumNameOf(node);
    return name && PLAIN_BUFF_NAME.test(name) ? name : null;
};

/** A buff a part consumes, with the node naming it. */
interface BuffUse {
    readonly buff: string;
    /** The node the finding is anchored on, always the site naming the buff. */
    readonly node: AbstractNode;
    /** What the site is, for the message. */
    readonly kind: 'modifier' | 'clamp' | 'toggle';
    /**
     * The span a removal fix may delete, when there is one whose removal provably changes nothing
     * else. Absent for the inline shortcut, whose sibling `BuffMode`/`BuffMinValue` members would be
     * left behind, and for a toggle, which other components reference by id.
     */
    readonly removable?: AbstractNode;
    /** For a toggle, the state it is stuck in, which is what the author actually sees. */
    readonly latchedOn?: boolean;
}

/**
 * The part groups this document instantiates: a group resolving to `PartRules` that writes its own
 * `ID`, matching the gate the part-geometry pass uses for the same reason.
 *
 * @param document the parsed document.
 * @returns the part groups to judge, in source order.
 */
const instantiatedParts = (document: AbstractNodeDocument): GroupNode[] => {
    const parts: GroupNode[] = [];
    const visit = (node: AbstractNode): void => {
        if (isGroupNode(node) && childNamed(node, 'ID') && resolveGroupClass(node) === PART_RULES_CLASS) parts.push(node);
        if (isGroupNode(node) || isListNode(node)) for (const child of node.elements) visit(child);
    };
    for (const element of document.elements) visit(element);
    return parts;
};

/**
 * The buff a group names in its `BuffType` member, when the group is one of the consumer classes.
 *
 * Keying on the class that declares the field rather than on the field name covers the derived
 * modifier kinds (`BuffRemap`, `ScaledBuff`) without naming them, and keeps every provider class out
 * by construction: they declare their own `BuffType` on a different base.
 *
 * @param group the group to classify.
 * @returns the use, or null when the group consumes no buff.
 */
const consumerUse = (group: GroupNode): BuffUse | null => {
    const cls = resolveGroupClass(group);
    if (!cls) return null;
    const ancestry = classAncestry(cls);
    const node = childNamed(group, 'BuffType');
    const buff = plainBuffName(node);
    if (!node || !buff) return null;

    // A modifier is one element of a `Modifiers` list, so the whole group is a span whose removal
    // leaves nothing dangling.
    if (ancestry.includes(BUFF_MODIFIER_CLASS)) return { buff, node, kind: 'modifier', removable: group };
    if (ancestry.includes(BUFF_TOGGLE_CLASS)) {
        // `PartBuffToggle.OnBuffsUpdated` compares the buff's value against the written range and
        // sets `IsToggleOn = inRange != Invert`. With no value ever arriving, `inRange` is false for
        // the toggle's whole life, so it latches to `Invert` and never moves again.
        return { buff, node, kind: 'toggle', latchedOn: booleanOf(childNamed(group, 'Invert')) === true };
    }
    // The inline shortcut on a modifiable value: `BuffType` alone is the driver, but `BuffMode` and
    // the `BuffMinValue`/`BuffMaxValue` pair sit beside it and would be left inert by a removal.
    if (cls === MODIFIABLE_VALUE_CLASS) return { buff, node, kind: 'modifier' };
    return null;
};

/**
 * Every buff the part's own file consumes, anywhere below the part group.
 *
 * @param part the part group.
 * @returns one use per naming site, in source order.
 */
const buffUsesIn = (part: GroupNode): BuffUse[] => {
    const uses: BuffUse[] = [];
    const visit = (node: AbstractNode): void => {
        if (isGroupNode(node)) {
            const use = consumerUse(node);
            if (use) uses.push(use);
        }
        if (isGroupNode(node) || isListNode(node)) for (const child of node.elements) visit(child);
    };
    for (const element of part.elements) visit(element);

    // The part's own buff-keyed clamps sit on the part root. They are written as a group whose
    // member names are the buffs (`MaxBuffValues = { Engine=100% }`), not as the key/value entry
    // list the per-cell maps use, so they are read by member name here.
    for (const field of CLAMP_FIELDS) {
        const map = childNamed(part, field);
        if (!map || !isGroupNode(map)) continue;
        for (const element of map.elements) {
            const buff = memberNameOf(element);
            if (buff && PLAIN_BUFF_NAME.test(buff)) uses.push({ buff, node: element, kind: 'clamp' });
        }
    }
    return uses;
};

/**
 * The buffs a part can actually receive, folded through its whole inheritance chain.
 *
 * @param part the part group.
 * @param token cancels the cross-file walk.
 * @returns the lowercased buff names, or null when the chain could not be read in full.
 */
const receivableBuffs = async (part: GroupNode, token: CancellationToken): Promise<Set<string> | null> => {
    const flattened = await flattenListMember(part, RECEIVABLE_BUFFS, token).catch(() => undefined);
    // undefined is a thrown walk, and an incomplete one is a chain with a hop this server could not
    // resolve. Both mean the same thing here: the set is unknown, so nothing is judged against it.
    if (flattened === undefined) return null;
    if (flattened === null) return new Set();
    if (!flattened.complete) return null;
    const buffs = new Set<string>();
    for (const entry of flattened.entries) {
        const name = plainBuffName(entry.value);
        // An entry this reader cannot name (a reference, a computed value) could be the very buff in
        // question, so an unreadable entry disqualifies the whole set rather than being skipped.
        if (!name) return null;
        buffs.add(name.toLowerCase());
    }
    return buffs;
};

/**
 * Finds buff consumers in a part whose buff the part can never receive.
 *
 * @param document the parsed document.
 * @param token cancels the cross-file chain walks.
 * @returns one finding per naming site, faded as dead weight with a fix that takes it out.
 */
export const validateUnreceivableBuffs = async (
    document: AbstractNodeDocument,
    token: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    for (const part of instantiatedParts(document)) {
        if (token.isCancellationRequested) return errors;
        const uses = buffUsesIn(part);
        if (uses.length === 0) continue;
        const receivable = await receivableBuffs(part, token);
        if (receivable === null) continue;
        for (const use of uses) {
            if (receivable.has(use.buff.toLowerCase())) continue;
            errors.push({
                message:
                    use.kind === 'clamp'
                        ? l10n.t(
                              "This part never receives '{0}', so the bound written for it is never applied. A part receives only the buffs its ReceivableBuffs lists.",
                              use.buff
                          )
                        : use.kind === 'toggle'
                          ? use.latchedOn
                              ? l10n.t(
                                    "This part never receives '{0}', so this toggle stays on for good. A part receives only the buffs its ReceivableBuffs lists, and a toggle whose buff never arrives latches to its Invert setting.",
                                    use.buff
                                )
                              : l10n.t(
                                    "This part never receives '{0}', so this toggle never turns on. A part receives only the buffs its ReceivableBuffs lists.",
                                    use.buff
                                )
                          : l10n.t(
                                "This part never receives '{0}', so this modifier never changes the value. A part receives only the buffs its ReceivableBuffs lists.",
                                use.buff
                            ),
                node: use.node,
                severity: 'hint',
                // A toggle is not dead weight: it holds a state other components read, so it is
                // reported without being faded out or offered for removal.
                unnecessary: use.kind !== 'toggle',
                additionalInfo: l10n.t(
                    "Add '{0}' to the part's ReceivableBuffs to make it arrive, or drop the site that reads it. Supplying the buff from this same part does not help: the game hands a buff only to parts registered as receivers of it.",
                    use.buff
                ),
                data: use.removable
                    ? {
                          remove: {
                              title: l10n.t("Remove this use of '{0}'", use.buff),
                              start: use.removable.position.start,
                              end: use.removable.position.end,
                          },
                      }
                    : undefined,
            });
        }
    }
    return errors;
};
