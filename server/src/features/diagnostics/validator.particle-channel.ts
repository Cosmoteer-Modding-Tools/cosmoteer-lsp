import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ValueNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { fieldOf, fieldsOf, typeDef } from '../../document/schema/schema';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { getParsedFileDocument } from '../../workspace/parsed-file-cache';
import { FileTree, FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { getStartOfAstNode, parseFilePath } from '../../utils/ast.utils';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { ChannelOccurrence, particleChannelsOf } from '../navigation/particle-channel';
import { ReverseIncludeIndex } from '../navigation/reverse-include.index';
import { normalizeUri } from '../navigation/reference-location';
import { inheritanceEntriesOf } from '../../semantics/reference-resolver';
import { isStringsFile } from '../../mod/strings-folder';
import { ValidationError } from './validator';

/**
 * A particle data channel a file writes that nothing ever reads.
 *
 * A particle effect passes values between its updaters through named channels: `SetRandom
 * { DataOut = rot_vel }` writes one and `Operator { BIn = rot_vel }` reads it. Nothing checks the
 * names, so a write whose reader is spelled differently is silently dead. The particle still draws,
 * it just draws without whatever that channel was computing.
 *
 * Only the write direction is judged. Reading a channel nothing writes is a legitimate idiom the
 * game itself uses: `ParticleSystemState.GetParticleData` hands out a zeroed buffer on first touch,
 * so a renderer reading `location` with no writer draws every particle at the emitter origin, which
 * is what several vanilla effects want.
 *
 * The whole difficulty is that a particle effect is usually split in two. An emitter writes its
 * channels in `PreInitializers` and pulls the body in with `Def = &<…_def.rules>`, and the readers
 * live over there. Judging either half alone reports the other half's work as dead, so the channels
 * of both are folded together before anything is reported, in both directions. Where that fold
 * cannot be completed, the file is left alone rather than judged on half its readers:
 *
 * - a `Def` reference or an inherited base that does not resolve, since the readers are in a file
 *   this editor cannot read;
 * - a group this editor cannot type, since its fields cannot be typed and its channel reads are
 *   therefore invisible, which covers an unresolved `Type =`, a group pinned to a registry interface
 *   and one taking its class from a base in another file;
 * - a group that leaves a non-nullable `ParticleDataID` field unwritten, since the engine binds such
 *   a field to a default channel name that the schema does not record, and that name is a reader
 *   this editor cannot see.
 *
 * A switched-off updater is not a writer either. `BaseParticleDataUpdater` runs its update only
 * `if (Enabled)`, so a write under an `Enabled` the game reads as false computes nothing and there is
 * no dropped value to report, which is what the game's own files are full of: parked experiments left
 * switched off. An `Enabled` this editor cannot read counts as off for the same reason it withholds
 * everywhere else.
 */

/** The member whose reference pulls in the shared body of an effect. */
const DEF_MEMBER = 'def';

/** How many files one effect's seam may cross before it is treated as unreadable. */
const SEAM_BUDGET = 16;

/** Everything the game's boolean reader takes for false, which is more than the written word. */
const OFF_LITERALS: ReadonlySet<string> = new Set(['false', 'no', 'n', '0']);

/** The channel names a document writes and reads, and whether it can be judged at all. */
interface ChannelSets {
    readonly writes: Map<string, ChannelOccurrence>;
    readonly reads: Set<string>;
    /** False when something in the document hides a reader, so nothing about it may be reported. */
    readonly readable: boolean;
}

/**
 * Whether a group leaves a non-nullable `ParticleDataID` field unwritten. The engine initialises
 * every such field with a hard-coded channel name, so the field reads or writes a channel this file
 * never spells and a reader is missing from the model.
 *
 * @param group the group to judge.
 * @param cls the group's resolved class.
 * @returns true when a defaulted channel field is in play.
 */
const bindsDefaultChannel = (group: GroupNode, cls: string): boolean => {
    const written = new Set<string>();
    for (const element of group.elements) {
        if (isAssignmentNode(element)) written.add(element.left.name.toLowerCase());
        else if (isGroupNode(element) || isListNode(element)) {
            if (element.identifier) written.add(element.identifier.name.toLowerCase());
        }
    }
    for (const field of fieldsOf(cls)) {
        if (field.valueType?.kind !== 'opaque' || field.valueType.type !== 'ParticleDataID') continue;
        // The schema marks the defaulted fields `nullable: false` and omits the key on the ones the
        // engine leaves unbound, so only an explicit false means a hidden channel.
        if (field.nullable !== false) continue;
        // A field written with no value at all nulls it, and the occurrence walk skips it, so the
        // group is not distrusted for that: only a field the file leaves out entirely binds a default.
        // The game binds one property from either spelling, so an alias write is a write.
        const spellings = [field.name, ...(field.aliases ?? [])].map((name) => name.toLowerCase());
        if (!spellings.some((name) => written.has(name))) return true;
    }
    return false;
};

/**
 * The channels one document writes and reads, and whether it is judgeable at all.
 *
 * @param document the parsed document.
 * @returns its channel sets.
 */
const channelSetsOf = (document: AbstractNodeDocument, judged = true): ChannelSets => {
    const writes = new Map<string, ChannelOccurrence>();
    const reads = new Set<string>();
    for (const channel of particleChannelsOf(document)) {
        const disabled = isSwitchedOff(channel.node);
        // A switched-off updater never runs, so it computes nothing and there is no dropped value to
        // report. Its reads still count as readers, which is the conservative direction: a channel
        // whose only reader is switched off stays unreported rather than reported on a guess about
        // what the author meant to leave behind.
        if (!disabled && (channel.direction === 'out' || channel.direction === 'inout')) {
            if (!writes.has(channel.name)) writes.set(channel.name, channel);
        }
        if (channel.direction === 'in' || channel.direction === 'inout') reads.add(channel.name);
    }

    // Deciding whether a file can be judged resolves the class of every group in it, which is worth
    // paying for a particle file and not for the thousand others a project holds.
    if (!judged && writes.size === 0) return { writes, reads, readable: true };
    let readable = true;
    const walk = (node: AbstractNode): void => {
        if (!readable) return;
        if (isGroupNode(node)) {
            const cls = resolveGroupClass(node);
            // A group this editor cannot type may declare channel fields of its own, and then its
            // reads are invisible. That covers a group whose `Type =` does not resolve, one pinned
            // to a registry interface rather than a class, and one that takes its class from a base
            // in another file, which the class resolution deliberately does not follow. A plain data
            // block is not distrusted for it, so the shape has to look like a channel binding.
            if (!cls || !typeDef(cls)) {
                if (node.elements.some((element) => isTypeDiscriminator(element) || isChannelShaped(element))) {
                    readable = false;
                }
            } else if (bindsDefaultChannel(node, cls) || namesChannelByReference(node, cls)) {
                readable = false;
            }
        }
        const elements = (node as { elements?: AbstractNode[] }).elements;
        if (elements) for (const element of elements) walk(element);
    };
    walk(document);
    return { writes, reads, readable };
};

/**
 * Whether a node sits inside an updater the author switched off. `BaseParticleDataUpdater` runs its
 * update only `if (Enabled)`, so a disabled group is dead weight the game walks past, and the values
 * it would have computed are never computed at all.
 *
 * @param node the occurrence's value node.
 * @returns true when an enclosing group writes `Enabled = false`.
 */
const isSwitchedOff = (node: AbstractNode): boolean => {
    for (let current: AbstractNode | undefined = node.parent; current; current = current.parent) {
        if (!isGroupNode(current)) continue;
        for (const element of current.elements) {
            if (!isAssignmentNode(element) || element.left.name.toLowerCase() !== 'enabled') continue;
            const value = element.right;
            if (!value || !isValueNode(value)) continue;
            // A reference is not readable from here, and the whole pass withholds rather than judge
            // on a guess, so an updater switched by one is left alone in both directions.
            if (value.valueType.type === 'Reference') return true;
            if (OFF_LITERALS.has(String(value.valueType.value).toLowerCase())) return true;
        }
    }
    return false;
};

/**
 * Whether a group names a channel through a reference rather than by writing it. The occurrence walk
 * only reads a written name, so such a binding is a reader or a writer it cannot see.
 *
 * @param group the group to judge.
 * @param cls the group's resolved class.
 * @returns true when a channel field carries a reference.
 */
const namesChannelByReference = (group: GroupNode, cls: string): boolean =>
    group.elements.some((element) => {
        if (!isAssignmentNode(element) || !element.right || !isValueNode(element.right)) return false;
        if (element.right.valueType.type !== 'Reference') return false;
        const valueType = fieldOf(cls, element.left.name)?.valueType;
        return valueType?.kind === 'opaque' && valueType.type === 'ParticleDataID';
    });

/**
 * Whether an element reads or writes something that looks like a channel: a member whose name ends
 * in `In` or `Out` carrying a plain name. In a group this editor could not type, that is the shape
 * whose direction and channel would otherwise go unseen.
 *
 * @param element the element to judge.
 * @returns true when the member looks like a channel binding.
 */
const isChannelShaped = (element: AbstractNode): boolean =>
    isAssignmentNode(element) &&
    /(?:In|Out)$/.test(element.left.name) &&
    !!element.right &&
    isValueNode(element.right) &&
    element.right.valueType.type === 'String';

/**
 * Whether an element is a `Type = …` discriminator, which is what makes an unresolved group a group
 * that was meant to be typed rather than a plain data block.
 *
 * @param element the element to judge.
 * @returns true for a `Type` assignment.
 */
const isTypeDiscriminator = (element: AbstractNode): boolean =>
    isAssignmentNode(element) && element.left.name.toLowerCase() === 'type';

/**
 * The documents whose channels share this file's scope: the body its `Def` pulls in, and every file
 * that pulls this one in the same way.
 *
 * @param document the document being judged.
 * @param token cancels the cross-file resolution.
 * @returns the related documents, or null when a `Def` reference could not be followed.
 */
const relatedDocuments = async (
    document: AbstractNodeDocument,
    token: CancellationToken
): Promise<AbstractNodeDocument[] | null> => {
    const navigation = new FullNavigationStrategy();
    const related: AbstractNodeDocument[] = [];
    const seen = new Set<string>([normalizeUri(document.uri)]);

    /**
     * Every reference that leads to another half of this effect: a `Def` member anywhere in the
     * tree, and every inherited base, which for channels means the same thing.
     */
    const seamsOf = (root: AbstractNode): ValueNode[] => {
        const seams: ValueNode[] = [];
        const collect = (node: AbstractNode): void => {
            if (isGroupNode(node) || isListNode(node)) {
                for (const entry of inheritanceEntriesOf(node)) {
                    if (isValueNode(entry) && entry.valueType.type === 'Reference') seams.push(entry);
                }
            }
            if (isAssignmentNode(node)) {
                const value = node.right;
                if (
                    node.left.name.toLowerCase() === DEF_MEMBER &&
                    value &&
                    isValueNode(value) &&
                    value.valueType.type === 'Reference'
                ) {
                    seams.push(value);
                }
                if (value) collect(value);
                return;
            }
            const elements = (node as { elements?: AbstractNode[] }).elements;
            if (elements) for (const element of elements) collect(element);
        };
        collect(root);
        return seams;
    };

    // Followed to the end: a mod commonly inherits a base of its own whose `Def` is what names the
    // shared body, so the readers of what this file writes sit two files away. Every hop this way
    // stays inside one particle system, which is what makes folding their channels together sound.
    const pending: AbstractNodeDocument[] = [document];
    let budget = SEAM_BUDGET;
    while (pending.length > 0) {
        if (token.isCancellationRequested) return null;
        // This is the only pass that follows other files' references, so it is the one that pays for
        // a resolution that will not terminate. An exhausted budget is an unreadable chain.
        if (budget-- <= 0) return null;
        const current = pending.pop()!;
        for (const seam of seamsOf(current)) {
            const resolved = await navigation
                .navigate(String(seam.valueType.value), seam, getStartOfAstNode(seam).uri, token)
                .catch(() => null);
            if (!resolved) return null;
            const target = isFile(resolved as FileTree)
                ? await getParsedFileDocument(resolved as FileWithPath).catch(() => null)
                : getStartOfAstNode(resolved as AbstractNode);
            if (!target) return null;
            const key = normalizeUri(target.uri);
            if (seen.has(key)) continue;
            seen.add(key);
            related.push(target);
            pending.push(target);
        }
    }

    // The other direction, and only one hop of it: this file may be the body an emitter pulls in,
    // and that emitter is where the channels it reads are written. It is not followed further,
    // because a file that includes this one usually lists a dozen unrelated effects beside it, and
    // their channel names live in their own particle systems rather than in this one.
    for (const include of ReverseIncludeIndex.instance.includesOf(document.uri)) {
        const path = ReverseIncludeIndex.instance.realPathFor(include.source) ?? include.source;
        const source = await parseFilePath(path).catch(() => null);
        if (!source) continue;
        const key = normalizeUri(source.uri);
        if (seen.has(key)) continue;
        seen.add(key);
        related.push(source);
    }
    return related;
};

/**
 * Hints at every channel this file writes that nothing in its effect ever reads.
 *
 * @param document the parsed document.
 * @param token cancels the cross-file fold.
 * @returns one hint per dead channel write, empty when the file cannot be judged.
 */
export const validateUnusedParticleChannels = async (
    document: AbstractNodeDocument,
    token: CancellationToken
): Promise<ValidationError[]> => {
    // A language file is display text with no schema behind it, and it is the file this walk costs
    // the most on, so it is turned away before any of it runs.
    if (await isStringsFile(document.uri, token).catch(() => false)) return [];
    const own = channelSetsOf(document, false);
    if (own.writes.size === 0) return [];
    if (!own.readable) return [];

    const related = await relatedDocuments(document, token);
    if (related === null) return [];
    const reads = new Set(own.reads);
    for (const other of related) {
        const sets = channelSetsOf(other);
        if (!sets.readable) return [];
        for (const name of sets.reads) reads.add(name);
    }

    const errors: ValidationError[] = [];
    for (const [name, channel] of own.writes) {
        if (reads.has(name)) continue;
        errors.push({
            node: channel.node,
            message: l10n.t('Nothing reads the particle channel "{0}", so this value is computed and dropped.', name),
            severity: 'hint',
            unnecessary: true,
        });
    }
    return errors;
};
