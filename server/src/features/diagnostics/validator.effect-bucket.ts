import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isListNode,
    isValueNode,
    ListNode,
    ValueNode,
} from '../../core/ast/ast';
import { childNodesOf } from '../../utils/ast.utils';
import { aliasRootIndex } from '../../document/schema/alias-root';
import { REGISTRY_LIST_FIELDS, sameId } from '../../document/schema/entity-schema';
import { ActionRootingIndex } from '../../mod/action-rooting.index';
import { ValidationError } from './validator';

/** The class whose five self-referential lists are the whole effect-bucket registry. */
const BUCKET_REGISTRY_CLASS = 'Cosmoteer.Simulation.MediaEffects.MediaEffectBucketsRules';

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
interface BucketList {
    /** The field name as written, which is what the engine's own message names. */
    readonly field: string;
    readonly node: ListNode;
    readonly entries: ValueNode[];
}

/**
 * The bucket lists a node holds, walking into its children so a fragment that wraps its lists in a
 * group is covered like a file that writes them at the top level.
 *
 * @param node the node to walk.
 * @returns a generator of the bucket lists found under it.
 */
function* bucketListsIn(node: AbstractNode): Generator<BucketList> {
    const list = isListNode(node) && node.identifier ? { name: node.identifier.name, node } : undefined;
    const assigned =
        isAssignmentNode(node) && isListNode(node.right) ? { name: node.left.name, node: node.right } : undefined;
    const written = list ?? assigned;
    if (written && REGISTRY_LIST_FIELDS.get(written.name.toLowerCase()) === BUCKET_REGISTRY_CLASS) {
        const entries = written.node.elements.filter(
            (element): element is ValueNode => isValueNode(element) && String(element.valueType.value).trim() !== ''
        );
        yield { field: written.name, node: written.node, entries };
    }
    for (const child of childNodesOf(node)) yield* bucketListsIn(child);
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
 * The third needs the file to be the registry rather than a fragment added to it, since a fragment
 * carries only the buckets it contributes.
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
        lists.push(...bucketListsIn(element));
    }
    if (lists.length === 0) return [];

    const errors: ValidationError[] = [];
    const declared = new Map<string, { field: string; id: string }>();
    for (const list of lists) {
        const cap = BUCKET_CAPS.get(list.field.toLowerCase());
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

    if (isWholeRegistry(document.uri) && ![...declared.values()].some((entry) => sameId(entry.id, DEFAULT_BULLET_BUCKET))) {
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
