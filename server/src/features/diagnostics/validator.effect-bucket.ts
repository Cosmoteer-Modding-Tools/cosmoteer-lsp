import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ListNode,
    ValueNode,
    descendants,
} from '../../core/ast/ast';
import { aliasRootIndex } from '../../document/schema/alias-root';
import { REGISTRY_LIST_FIELDS, sameId } from '../../document/schema/entity-schema';
import { ActionRootingIndex } from '../../mod/action-rooting.index';
import { ValidationError } from './validator';

/** The class whose five self-referential lists are the whole effect-bucket registry. */
export const BUCKET_REGISTRY_CLASS = 'Cosmoteer.Simulation.MediaEffects.MediaEffectBucketsRules';

/**
 * Lower-cased list field name to the number of buckets the engine reads out of it. Each list owns
 * a numbered band of the render order (the lower buckets count up to -1, the interior surface ones
 * from 1, the middle ones from 100, and so on), and the constructor throws "Too many … buckets!"
 * on the entry that would leave its band. Read from `MediaEffectBucketsRules` in the shipped
 * assembly, where the interior-surface band really is the narrow one.
 */
const BUCKET_CAPS: ReadonlyMap<string, number> = new Map([
    ['lowerbuckets', 1000],
    ['interiorsurfacebuckets', 97],
    ['middlebuckets', 1000],
    ['surfacebuckets', 1000],
    ['upperbuckets', 1000],
]);

/**
 * The bucket a bullet sprite renders in when it names none of its own. Both `BulletSpriteRules`
 * and `BulletAnimatedSpriteRules` initialize their `RenderBucket` to it in C#, and the lookup
 * throws "Unknown effect bucket" rather than falling back, so a registry without it takes down
 * every bullet that leaves the field unwritten.
 */
const DEFAULT_BULLET_BUCKET = 'default_bullet';

/** One bucket list a document writes, in either the named or the assigned spelling. */
export interface BucketList {
    /** The field name as written, which is what the engine's own message names. */
    readonly field: string;
    readonly node: ListNode;
    readonly entries: ValueNode[];
    /** True for a list a mod action appends, which is a part of the merged list rather than all of it. */
    readonly appended?: true;
}

/**
 * A list written in either spelling, the bare named `Foo [ … ]` and the assigned `Foo = [ … ]`.
 *
 * @param candidate the walked node.
 * @returns the written name and the list it carries, or undefined when the node is not a list.
 */
const writtenListOf = (candidate: AbstractNode): { name: string; node: ListNode } | undefined => {
    if (isListNode(candidate) && candidate.identifier) return { name: candidate.identifier.name, node: candidate };
    if (isAssignmentNode(candidate) && isListNode(candidate.right))
        return { name: candidate.left.name, node: candidate.right };
    return undefined;
};

/**
 * The entries of a list the engine reads as bucket names, which is every written value in it.
 *
 * @param node the written list.
 * @returns the value entries, without the empty ones.
 */
const bucketEntriesOf = (node: ListNode): ValueNode[] =>
    node.elements.filter(
        (element): element is ValueNode => isValueNode(element) && String(element.valueType.value).trim() !== ''
    );

/**
 * The bucket lists a node holds, walking into its children so a fragment that wraps its lists in a
 * group is covered like a file that writes them at the top level.
 *
 * @param node the node to walk.
 * @returns a generator of the bucket lists found under it.
 */
export function* bucketListsIn(node: AbstractNode): Generator<BucketList> {
    for (const candidate of descendants(node)) {
        const written = writtenListOf(candidate);
        if (!written || REGISTRY_LIST_FIELDS.get(written.name.toLowerCase()) !== BUCKET_REGISTRY_CLASS) continue;
        yield { field: written.name, node: written.node, entries: bucketEntriesOf(written.node) };
    }
}

/**
 * The registry list a mod action's `AddTo` path lands in, read from the path's last segment. A
 * deeper path, an index into the list among them, names no list to append bucket names to.
 *
 * @param entry the action entry holding the `AddTo` member.
 * @returns the list field name as the registry spells it, or undefined for any other target.
 */
const appendTargetField = (entry: AbstractNode | undefined): string | undefined => {
    if (!entry || !isGroupNode(entry)) return undefined;
    for (const member of entry.elements) {
        if (!isAssignmentNode(member) || member.left.name.toLowerCase() !== 'addto') continue;
        if (!isValueNode(member.right)) return undefined;
        const segment = String(member.right.valueType.value).trim().split('/').pop() ?? '';
        if (REGISTRY_LIST_FIELDS.get(segment.toLowerCase()) !== BUCKET_REGISTRY_CLASS) return undefined;
        return segment;
    }
    return undefined;
};

/**
 * The bucket names a manifest action appends to the registry, read from a `ManyToAdd` whose `AddTo`
 * path names one of the registry's own lists. The engine appends the payload to the list the path
 * names, so a name the payload repeats is repeated in the merged registry, which is what the
 * in-file lists are read for as well. Only that repetition is read here. An appended list is a part
 * of the merged one, so its length says nothing about the band's cap.
 *
 * @param node the node to walk.
 * @returns a generator of the appended lists, each named after the list it lands in.
 */
function* appendedBucketListsIn(node: AbstractNode): Generator<BucketList> {
    for (const candidate of descendants(node)) {
        const written = writtenListOf(candidate);
        if (!written || written.name.toLowerCase() !== 'manytoadd') continue;
        const field = appendTargetField(candidate.parent);
        if (field) yield { field, node: written.node, entries: bucketEntriesOf(written.node), appended: true };
    }
}

/**
 * Whether the document is the whole bucket registry rather than a fragment merged into it. The
 * game root reads the registry out of one file (`EffectBuckets = &<…>`), and a mod replacing that
 * file takes the same slot, so both root to the registry class. A fragment an action adds entries
 * from roots to a member instead, and the buckets it does not name are supplied by the file it is
 * added to. Answers false while the rooting indexes are still building, so the check stays silent
 * rather than judging a file on half a registry.
 *
 * @param uri the document's uri.
 * @returns true when the file is read as the registry itself.
 */
const isWholeRegistry = (uri: string): boolean => {
    const rooted = aliasRootIndex.rootType(uri) ?? ActionRootingIndex.instance.rootType(uri);
    return rooted?.kind === 'group' && rooted.ref === BUCKET_REGISTRY_CLASS;
};

/**
 * Flags the three ways a media-effect bucket list stops the game from loading or drawing: a bucket
 * name a second entry repeats, a list longer than the band the engine gives it, and a registry with
 * no `default_bullet` in it.
 *
 * The first two are read from the document alone, which is sound because nothing shrinks a list
 * once it is written: an entry repeated inside one file is repeated in the merged registry too.
 * A manifest's `ManyToAdd` payload is read for the repetition on the same ground, and never for the
 * cap, since it holds a part of the merged list rather than all of it. The third needs the file to
 * be the registry rather than a fragment added to it, since a fragment carries only the buckets it
 * contributes.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk.
 * @returns one finding per repeated bucket, per entry past a list's cap, and one for a registry
 *          missing the default bullet bucket.
 */
export const validateEffectBuckets = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const lists: BucketList[] = [];
    for (const element of document.elements) {
        if (cancellationToken.isCancellationRequested) return [];
        lists.push(...bucketListsIn(element), ...appendedBucketListsIn(element));
    }
    if (lists.length === 0) return [];

    const errors: ValidationError[] = [];
    const declared = new Map<string, { field: string; id: string }>();
    for (const list of lists) {
        const cap = list.appended ? undefined : BUCKET_CAPS.get(list.field.toLowerCase());
        if (cap !== undefined && list.entries.length > cap) {
            errors.push({
                message: l10n.t(
                    'The game reads at most {0} buckets from {1} and throws on the one after them.',
                    cap,
                    list.field
                ),
                node: list.entries[cap],
                severity: 'error',
            });
        }
        for (const entry of list.entries) {
            const id = String(entry.valueType.value);
            const key = id.toLowerCase();
            const first = declared.get(key);
            if (first) {
                errors.push({
                    message: l10n.t(
                        "The effect bucket '{0}' is already declared in {1}. The game refuses to load a registry that names one bucket twice.",
                        first.id,
                        first.field
                    ),
                    node: entry,
                    severity: 'error',
                });
                continue;
            }
            declared.set(key, { field: list.field, id });
        }
    }

    if (
        isWholeRegistry(document.uri) &&
        ![...declared.values()].some((entry) => sameId(entry.id, DEFAULT_BULLET_BUCKET))
    ) {
        const anchor: AbstractNode = lists[0].node.identifier ?? lists[0].node;
        errors.push({
            message: l10n.t(
                "This registry declares no '{0}' bucket. A bullet sprite that names no render bucket of its own falls back to it, and the game throws the first time such a bullet is drawn.",
                DEFAULT_BULLET_BUCKET
            ),
            node: anchor,
            severity: 'warning',
        });
    }
    return errors;
};
