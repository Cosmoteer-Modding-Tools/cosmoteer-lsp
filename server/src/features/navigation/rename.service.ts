import { CancellationToken, Position, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    IdentifierNode,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    ValueNode,
} from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { warmInheritedClasses } from '../completion/inheritance-resolution';
import { dedupeEdits } from '../../utils/text-edit.utils';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { isReferenceValue } from './definition.service';
import { FullNavigationStrategy } from './full.navigation-strategy';
import { filePathToUri, segmentName } from './navigation-strategy';
import {
    referenceShapeOf,
    segmentNameRange,
    namedSegmentAt,
    segmentSpanAt,
    segmentTarget,
    segmentTargetIdentity,
    segmentTargetNode,
    segmentsNamed,
} from './reference-segment';
import { definitionLocationOf, locationKey, normalizeUri, referenceSiteLocation } from './reference-location';
import { findReferenceTargetAtPosition, referenceNodesOf } from './reference-index';
import { resolveSchemaSiblingReference, stringValueNodesOf, valueTextRange } from './schema-reference.navigation';
import { schemaReferenceFieldOf } from './schema-id-reference.navigation';
import { idReferenceSites, idSymbolAt, idSymbolAtMapKey } from './schema-id-symbol';
import { particleChannelAt, channelOccurrences, channelRangeOf } from './particle-channel';
import { documentRootClass } from '../../document/schema/document-root';
import { isValueNode } from '../../core/ast/ast';
import { documentsMatching, documentsMentioning } from './workspace-files';
import {
    buildLocalizationKeyRenameEdit,
    localizationKeyRenameTargetAt,
    RenameRefusedError,
} from '../refactor/rename-localization-key';
import * as l10n from '@vscode/l10n';

export { RenameRefusedError };

/** A renameable symbol: the identifier text to rewrite, its name, and the target identity. */
interface RenameSymbol {
    nameNode: IdentifierNode;
    name: string;
    targetKey: string;
}

/** A valid Cosmoteer member name: what a rename target may be renamed to. A leading digit is
 *  excluded because a bare number is a list index, a position in a container rather than a name,
 *  and rewriting one would move an element instead of renaming anything. */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Guard a rename against writing into `root` (the read-only vanilla Cosmoteer `Data` tree).
 *
 * Rename searches the whole game so cross-file references resolve, but the install is never written.
 * Half a rename is worse than none: dropping the edits under `root` used to leave the mod renaming
 * its own uses of a vanilla symbol the game still calls by the old name, and the author was told
 * nothing. So a rename that reaches the install is refused instead, and the author can override the
 * symbol in the mod and rename that. A no-op when `root` is unknown or nothing lands there.
 *
 * @param edit the rename's workspace edit.
 * @param root the game `Data` root, or undefined when it is not known.
 * @returns the edit unchanged.
 * @throws RenameRefusedError when any edit falls inside the install.
 */
export const refuseEditsUnderRoot = (edit: WorkspaceEdit, root: string | undefined): WorkspaceEdit => {
    if (!root || !edit.changes) return edit;
    const rootNorm = normalizeUri(root);
    for (const uri of Object.keys(edit.changes)) {
        const norm = normalizeUri(uri);
        if (norm === rootNorm || norm.startsWith(`${rootNorm}/`)) {
            throw new RenameRefusedError(
                l10n.t("Renaming this would have to change the game's own files, which the editor never writes.")
            );
        }
    }
    return edit;
};

/** A valid Cosmoteer ID value like a member name but dotted ids are allowed (`cosmoteer.fire`). */
const VALID_ID = /^[A-Za-z0-9_.]+$/;

const identifierRange = (node: IdentifierNode): Range => {
    const { line, characterStart, characterEnd } = node.position;
    return Range.create(line, characterStart, line, characterEnd);
};

/**
 * Rename (`textDocument/rename` + `prepareRename`).
 *
 * A Cosmoteer symbol is referred to by the last segment that resolves to it, which can
 * be the endpoint of a reference (`&…/B`) or a mid-path segment (`&…/B/InnerValue` when
 * renaming `B`). So rename can't just rewrite the reference-index buckets (those key only
 * endpoints): for every reference whose path contains a segment textually equal to the
 * name, it resolves that segment's prefix and rewrites it only when the prefix resolves to
 * the exact target. Plus the declaration identifier itself. The result is a
 * {@link WorkspaceEdit} grouping per-file {@link TextEdit}s.
 */
export class RenameService {
    private static _instance: RenameService;
    private readonly navigation = new FullNavigationStrategy();
    private constructor() {}

    public static get instance(): RenameService {
        if (!RenameService._instance) {
            RenameService._instance = new RenameService();
        }
        return RenameService._instance;
    }

    /**
     * Validate the cursor sits on a renameable name and report its range + current text.
     *
     * @param document the parsed document the caret is in.
     * @param position the caret position.
     * @param cancellationToken cancellation for the schema lookup a localization key needs.
     * @returns the span to rewrite and its current text, or null when nothing here can be renamed.
     */
    public async prepareRename(
        document: AbstractNodeDocument,
        position: Position,
        cancellationToken: CancellationToken = CancellationToken.None
    ): Promise<{ range: Range; placeholder: string } | null> {
        await warmInheritedClasses(document, cancellationToken).catch(() => undefined);
        // A localization key is a slash path into the mod's language files rather than a member name
        // or a reference segment, so it is recognized before either of those branches can claim it.
        // Inside a strings file the general member rename would rewrite the key in that one language.
        const localizationKey = await localizationKeyRenameTargetAt(document, position, cancellationToken);
        if (localizationKey) return { range: localizationKey.range, placeholder: localizationKey.segment };

        const found = findReferenceTargetAtPosition(document, position);
        if (!found) return null;

        if (isReferenceValue(found)) {
            const span = segmentSpanAt(found, position);
            if (!span) return null;
            const name = segmentName(span);
            // Only a plain member segment is renameable, not a `<file.rules>` part, a
            // super-path sigil, or a `^`/`~`/`..` navigation op.
            if (!VALID_NAME.test(name)) {
                // `EditorGroups = &<editor_groups.rules>`: the path names a file, which has no name
                // to rewrite, but the key it is assigned to has one and is what other files point at.
                const keySymbol = wholeFileReference(found) ? deriveRenameSymbol(found) : null;
                return keySymbol ? { range: identifierRange(keySymbol.nameNode), placeholder: keySymbol.name } : null;
            }
            return { range: segmentNameRange(found, span), placeholder: name };
        }

        // A schema `ID<>` sibling reference value renames via the component it names (resolve first).
        const sibling = resolveSchemaSiblingReference(found);
        if (sibling) {
            const symbol = deriveRenameSymbol(sibling);
            return symbol ? { range: identifierRange(symbol.nameNode), placeholder: symbol.name } : null;
        }

        // A particle data channel value (`DataOut = rot_vel`) renames the channel file-wide.
        const channel = particleChannelAt(document, position);
        if (channel) return { range: channelRangeOf(channel), placeholder: channel.name };

        // A cross-file `ID<X>` value (a bare-id reference usage, or a whole-file root's own `ID`)
        // renames the id (dotted ids allowed). The cross-file rewrite happens in `rename`.
        const idValue = crossFileIdValue(found);
        if (idValue) {
            const text = String(idValue.valueType.value);
            return VALID_ID.test(text) ? { range: valueTextRange(idValue), placeholder: text } : null;
        }

        const symbol = deriveRenameSymbol(found);
        if (!symbol) return null;
        return { range: identifierRange(symbol.nameNode), placeholder: symbol.name };
    }

    /**
     * The whole rename as one {@link WorkspaceEdit}: the declaration plus every site that refers to it.
     *
     * @param document the parsed document the caret is in.
     * @param position the caret position.
     * @param newName the name the symbol is being given.
     * @param folderPaths the project folders to search.
     * @param cancellationToken cancels the search.
     * @param readOverride the unsaved text of an open file, so a cross-file edit is measured against
     *        the buffer the editor will apply it to rather than against stale bytes on disk.
     * @returns the edit to apply, or null when nothing under the caret can be renamed.
     */
    public async rename(
        document: AbstractNodeDocument,
        position: Position,
        newName: string,
        folderPaths: string[],
        cancellationToken: CancellationToken,
        readOverride?: (absPath: string) => string | undefined
    ): Promise<WorkspaceEdit | null> {
        // An id inside a group deriving from a base in another file is a schema reference only once
        // that group's class is known to the synchronous schema lookups.
        await warmInheritedClasses(document, cancellationToken).catch(() => undefined);
        const changes: { [uri: string]: TextEdit[] } = {};
        const add = (uri: string, range: Range, text: string) => {
            (changes[uri] ??= []).push(TextEdit.replace(range, text));
        };

        // A localization key renames across the mod's language files and every field pointing at it,
        // so it is handled first, before the reference-shaped branches below.
        const localizationKey = await localizationKeyRenameTargetAt(document, position, cancellationToken);
        if (localizationKey) {
            return buildLocalizationKeyRenameEdit(
                localizationKey,
                newName,
                document.uri,
                folderPaths,
                cancellationToken,
                readOverride
            );
        }

        // Cross-file `ID<X>` rename: rewrite the whole-file root's `ID` declaration and every bare-id
        // reference to it across the project (e.g. rename resource `battery` → all `ResourceType =`).
        const rawFound = findReferenceTargetAtPosition(document, position);
        const idSymbol =
            (await idSymbolAt(rawFound, folderPaths, cancellationToken).catch(() => null)) ??
            (await idSymbolAtMapKey(document, position, folderPaths, cancellationToken).catch(() => null));
        if (idSymbol) {
            if (!VALID_ID.test(newName)) return null;
            const declKey = locationKey(idSymbol.location);
            add(idSymbol.location.uri, idSymbol.location.range, newName); // the ID declaration
            for await (const doc of documentsMentioning(folderPaths, idSymbol.id, cancellationToken)) {
                for (const site of idReferenceSites(doc, idSymbol)) {
                    const location = referenceSiteLocation(site);
                    if (locationKey(location) !== declKey) add(location.uri, location.range, newName);
                }
            }
            dedupeEdits(changes);
            return { changes };
        }

        // A particle data channel rename rewrites every occurrence of the name in the same file.
        const channel = particleChannelAt(document, position);
        if (channel) {
            if (!VALID_NAME.test(newName)) return null;
            for (const occurrence of channelOccurrences(document, channel.name)) {
                add(filePathToUri(getStartOfAstNode(occurrence.node).uri), channelRangeOf(occurrence), newName);
            }
            dedupeEdits(changes);
            return { changes };
        }

        if (!VALID_NAME.test(newName)) return null;
        const symbol = await this.resolveSymbol(document, position, cancellationToken);
        if (!symbol) return null;

        // 1. The declaration itself.
        add(filePathToUri(getStartOfAstNode(symbol.nameNode).uri), identifierRange(symbol.nameNode), newName);

        // 2. Every reference segment that resolves to the target. Only files whose text spells the
        // name where a reference could use it are scanned, so this scales to the whole Cosmoteer
        // Data tree.
        const shape = referenceShapeOf(symbol.name);
        for await (const doc of documentsMatching(folderPaths, symbol.name, cancellationToken, (text) =>
            shape.test(text)
        )) {
            for (const reference of referenceNodesOf(doc)) {
                const sourceUri = getStartOfAstNode(reference).uri;
                for (const span of segmentsNamed(reference, symbol.name)) {
                    const resolved = await segmentTargetNode(doc, reference, span, cancellationToken);
                    if (!resolved || locationKey(definitionLocationOf(resolved)) !== symbol.targetKey) continue;
                    add(filePathToUri(sourceUri), segmentNameRange(reference, span), newName);
                }
            }
        }

        // 3. Schema `ID<>` sibling references (bare strings, always same-file): scan this document.
        for (const candidate of stringValueNodesOf(document)) {
            if (String(candidate.valueType.value) !== symbol.name) continue;
            const target = resolveSchemaSiblingReference(candidate);
            if (!target || locationKey(definitionLocationOf(target)) !== symbol.targetKey) continue;
            add(filePathToUri(getStartOfAstNode(candidate).uri), valueTextRange(candidate), newName);
        }

        dedupeEdits(changes);
        return { changes };
    }

    /** The renameable symbol under the cursor, resolving through a reference if needed. */
    private async resolveSymbol(
        document: AbstractNodeDocument,
        position: Position,
        cancellationToken: CancellationToken
    ): Promise<RenameSymbol | null> {
        const found = findReferenceTargetAtPosition(document, position);
        if (!found) return null;
        if (!isReferenceValue(found)) return deriveRenameSymbol(resolveSchemaSiblingReference(found) ?? found);

        // The cursor names the segment it sits on, not the path's endpoint. Resolving the whole
        // value would rename `RGBA` when the reader put the caret on `Lime` in `&/SW_COLORS/Lime/RGBA`.
        const span = namedSegmentAt(found, position);
        if (!span) return null;
        const resolved = await segmentTarget(document, found, span, cancellationToken);
        if (!resolved) return null;
        const symbol = deriveRenameSymbol(resolved as AbstractNode);
        // `EditorGroups = &<editor_groups.rules>`: the reference names a whole file, which has no
        // name to rewrite, but the key it is assigned to has one and is what other files write. The
        // sites reach the file through that key, so the file is what they have to resolve to.
        if (isFile(resolved as unknown as FileWithPath)) {
            const keySymbol = deriveRenameSymbol(found);
            return keySymbol ? { ...keySymbol, targetKey: segmentTargetIdentity(resolved) } : null;
        }
        return symbol;
    }
}

/**
 * Whether a reference names a whole `.rules` file with no member after it
 * (`EditorGroups = &<editor_groups.rules>`).
 *
 * @param node the reference value node.
 * @returns true when the path is a bare file reference.
 */
const wholeFileReference = (node: ValueNode): boolean => {
    const value = String(node.valueType.value).replace(/^&/, '').trim();
    return value.startsWith('<') && value.endsWith('>');
};

/**
 * A cross-file `ID<X>` value node the cursor sits on a bare-id reference usage (a schema reference
 * field's value) or a whole-file root's own top-level `ID` declaration or undefined. Synchronous
 * (no cross-file resolution): just enough to drive `prepareRename`'s range/placeholder. The actual
 * cross-file rewrite happens in `rename` via {@link idSymbolAt}.
 */
const crossFileIdValue = (node: AbstractNode): ValueNode | undefined => {
    if (!isValueNode(node) || node.valueType.type !== 'String') return undefined;
    if (schemaReferenceFieldOf(node)) return node; // a reference usage
    const container = node.parent;
    if (container && isDocumentNode(container) && documentRootClass(container)) {
        for (const element of container.elements) {
            if (isAssignmentNode(element) && element.left.name === 'ID' && element.right === node) return node;
        }
    }
    return undefined;
};

/**
 * Derive the renameable symbol from a definition node: an identified `Group`/`List`
 * renames via its identifier an assignment value renames via its key. Anything else
 * (anonymous element, inheritance value) has no name to rewrite.
 */
const deriveRenameSymbol = (node: AbstractNode): RenameSymbol | null => {
    if ((isGroupNode(node) || isListNode(node)) && node.identifier) {
        return { nameNode: node.identifier, name: node.identifier.name, targetKey: locationKey(definitionLocationOf(node)) };
    }
    // An assignment value's parent is its container, so find the
    // `key = value` whose right-hand side is this node to recover the key to rewrite.
    const container = node.parent;
    if (container && (isGroupNode(container) || isListNode(container) || isDocumentNode(container))) {
        for (const element of container.elements) {
            if (isAssignmentNode(element) && element.right === node) {
                return {
                    nameNode: element.left,
                    name: element.left.name,
                    targetKey: locationKey(definitionLocationOf(node)),
                };
            }
        }
    }
    return null;
};

