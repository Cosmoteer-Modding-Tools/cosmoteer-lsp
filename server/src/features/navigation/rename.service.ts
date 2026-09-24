// Rename: textDocument/rename and prepareRename.
//
// A Cosmoteer symbol is referred to by the last segment that resolves to it, which can be the
// endpoint of a reference (`&…/B`) or a mid-path segment (`&…/B/InnerValue` when renaming `B`). So
// rename cannot just rewrite the reference-index buckets, which key only endpoints. For every
// reference whose path contains a segment textually equal to the name, it resolves that segment's
// prefix and rewrites it only when the prefix resolves to the exact target, plus the declaration
// identifier itself. The result is a WorkspaceEdit grouping per-file TextEdits.

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
import { isReferenceValue } from './reference-target';
import { filePathToUri, segmentName } from '../../document/reference-path';
import {
    referenceShapeOf,
    segmentNameRangeExact,
    namedSegmentAt,
    segmentSpanAt,
    segmentTarget,
    segmentTargetIdentity,
    segmentTargetNode,
    segmentsNamed,
} from './reference-segment';
import {
    definitionLocationOf,
    locationKey,
    normalizeUri,
    referenceSiteLocation,
} from '../../document/reference-location';
import { findReferenceTargetAtPosition } from './reference-index';
import { referenceNodesOf } from './reference-nodes';
import { resolveSchemaSiblingReference, stringValueNodesOf, valueTextRange } from './schema-reference.navigation';
import { schemaReferenceFieldOf } from './schema-id-reference.navigation';
import { idReferenceSites, idSymbolAt, idSymbolAtMapKey } from './schema-id-symbol';
import { ChannelOccurrence, particleChannelAt, channelOccurrences, channelRangeOf } from './particle-channel';
import {
    componentDeclarationIdOf,
    componentIdSites,
    componentIdSlotOf,
    findComponentDeclaration,
} from './rename-component-id';
import { collectPartComponentIds } from '../diagnostics/validator.schema-sibling';
import { documentRootClass } from '../../document/schema/document-root';
import { entityDeclarationsOf } from '../../document/schema/entity-schema';
import { isValueNode } from '../../core/ast/ast';
import { documentsMatching, documentsMentioning } from '../../workspace/workspace-files';
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

/**
 * What the caret names: the kind of symbol, the span `prepareRename` shows the author, and the node
 * the rewrite starts from.
 *
 * Both requests answer from this one resolution, so the name the rename box offers and the text the
 * edit replaces can never be two different tokens. `rename` refuses a kind it cannot follow to a
 * declaration instead of falling back to whatever name happens to sit next to the caret, which used
 * to rewrite the enclosing field of an `ID<>` slot and silently delete the field.
 */
export type RenameCaret =
    | {
          readonly kind: 'reference';
          readonly range: Range;
          readonly placeholder: string;
          readonly reference: ValueNode;
      }
    | {
          readonly kind: 'fileKey';
          readonly range: Range;
          readonly placeholder: string;
          readonly reference: ValueNode;
      }
    | {
          readonly kind: 'componentId';
          readonly range: Range;
          readonly placeholder: string;
          readonly value: ValueNode;
          readonly id: string;
      }
    | {
          readonly kind: 'channel';
          readonly range: Range;
          readonly placeholder: string;
          readonly channel: ChannelOccurrence;
      }
    | {
          readonly kind: 'crossFileId';
          readonly range: Range;
          readonly placeholder: string;
          readonly value: ValueNode;
      }
    | {
          readonly kind: 'member';
          readonly range: Range;
          readonly placeholder: string;
          readonly symbol: RenameSymbol;
          readonly node: AbstractNode;
      };

/**
 * The refusal for a new name the game could not read back.
 *
 * @param newName the name the author typed.
 * @returns the refusal to throw.
 */
const refusedName = (newName: string): RenameRefusedError =>
    new RenameRefusedError(l10n.t("'{0}' cannot be used as a name here.", newName));

/** A valid Cosmoteer member name: what a rename target may be renamed to. A leading digit is
 *  excluded because a bare number is a list index, a position in a container rather than a name,
 *  and rewriting one would move an element instead of renaming anything. */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A valid Cosmoteer ID value like a member name but dotted ids are allowed (`cosmoteer.fire`). */
const VALID_ID = /^[A-Za-z0-9_.]+$/;

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

const identifierRange = (node: IdentifierNode): Range => {
    const { line, characterStart, characterEnd } = node.position;
    return Range.create(line, characterStart, line, characterEnd);
};

/**
 * Validate the cursor sits on a renameable name and report its range + current text.
 *
 * @param document the parsed document the caret is in.
 * @param position the caret position.
 * @param cancellationToken cancellation for the schema lookup a localization key needs.
 * @returns the span to rewrite and its current text, or null when nothing here can be renamed.
 */
export const prepareRename = async (
    document: AbstractNodeDocument,
    position: Position,
    cancellationToken: CancellationToken = CancellationToken.None
): Promise<{ range: Range; placeholder: string } | null> => {
    await warmInheritedClasses(document, cancellationToken).catch(() => undefined);
    // A localization key is a slash path into the mod's language files rather than a member name
    // or a reference segment, so it is recognized before either of those branches can claim it.
    // Inside a strings file the general member rename would rewrite the key in that one language.
    const localizationKey = await localizationKeyRenameTargetAt(document, position, cancellationToken);
    if (localizationKey) return { range: localizationKey.range, placeholder: localizationKey.segment };

    const caret = resolveRenameCaret(document, position);
    return caret ? { range: caret.range, placeholder: caret.placeholder } : null;
};

/**
 * What the caret names, as both requests read it.
 *
 * Synchronous on purpose: everything here is decided from this document's own text and the schema, so
 * `prepareRename` answers a keystroke without reading another file, and `rename` starts from the very
 * same answer rather than resolving the caret a second time its own way.
 *
 * @param document the parsed document the caret is in.
 * @param position the caret position.
 * @returns the caret's symbol, or null when nothing here can be renamed.
 */
const resolveRenameCaret = (document: AbstractNodeDocument, position: Position): RenameCaret | null => {
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
            if (!keySymbol) return null;
            return {
                kind: 'fileKey',
                range: identifierRange(keySymbol.nameNode),
                placeholder: keySymbol.name,
                reference: found,
            };
        }
        // A value the segment cannot be placed inside (several quoted pieces joined into one text)
        // has no span to draw the box around, and the whole-value span would rewrite the delimiters
        // and every other segment along with the name.
        const range = segmentNameRangeExact(found, span);
        if (!range) return null;
        return { kind: 'reference', range, placeholder: name, reference: found };
    }

    // A component `ID<>` slot (`SignificanceToggle = ScorchedToggle`, `Toggles = [PowerToggle]`,
    // `OperationalToggle = IsOperational`) names a component of this part by its id, and the id is the
    // token under the caret, so that is what the box offers and what `rename` rewrites part-wide.
    const componentId = isValueNode(found) ? componentIdSlotOf(found) : undefined;
    if (componentId !== undefined && isValueNode(found)) {
        return VALID_NAME.test(componentId)
            ? {
                  kind: 'componentId',
                  range: valueTextRange(found),
                  placeholder: componentId,
                  value: found,
                  id: componentId,
              }
            : null;
    }

    // A particle data channel value (`DataOut = rot_vel`) renames the channel file-wide.
    const channel = particleChannelAt(document, position);
    if (channel) return { kind: 'channel', range: channelRangeOf(channel), placeholder: channel.name, channel };

    // A cross-file `ID<X>` value (a bare-id reference usage, or a declaration's own id)
    // renames the id (dotted ids allowed). The cross-file rewrite happens in `rename`.
    const idValue = crossFileIdValue(found);
    if (idValue) {
        const text = String(idValue.valueType.value);
        return VALID_ID.test(text)
            ? { kind: 'crossFileId', range: valueTextRange(idValue), placeholder: text, value: idValue }
            : null;
    }

    const symbol = deriveRenameSymbol(found);
    if (!symbol) return null;
    return { kind: 'member', range: identifierRange(symbol.nameNode), placeholder: symbol.name, symbol, node: found };
};

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
export const rename = async (
    document: AbstractNodeDocument,
    position: Position,
    newName: string,
    folderPaths: string[],
    cancellationToken: CancellationToken,
    readOverride?: (absPath: string) => string | undefined
): Promise<WorkspaceEdit | null> => {
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

    const caret = resolveRenameCaret(document, position);
    if (!caret) return null;

    // Cross-file `ID<X>` rename: rewrite the whole-file root's `ID` declaration and every bare-id
    // reference to it across the project (e.g. rename resource `battery` → all `ResourceType =`).
    // A map key is the other spelling of such a reference, so a caret on one starts the same rename.
    if (caret.kind === 'crossFileId' || caret.kind === 'member') {
        const idSymbol =
            caret.kind === 'crossFileId'
                ? await idSymbolAt(caret.value, folderPaths, cancellationToken).catch(() => null)
                : await idSymbolAtMapKey(document, position, folderPaths, cancellationToken).catch(() => null);
        if (idSymbol) {
            if (!VALID_ID.test(newName)) throw refusedName(newName);
            const declKey = locationKey(idSymbol.location);
            add(idSymbol.location.uri, idSymbol.location.range, newName); // the ID declaration
            for await (const doc of documentsMentioning(folderPaths, idSymbol.id, cancellationToken)) {
                for (const site of idReferenceSites(doc, idSymbol)) {
                    const location = referenceSiteLocation(site);
                    if (locationKey(location) !== declKey) add(location.uri, location.range, newName);
                }
            }
            dedupeEdits(changes);
            return guardPreparedRange({ changes }, caret, document);
        }
        // Nothing in the project declares the id, so there is no declaration to rewrite. The field
        // the id is written in is a different name than the box offered, so it is left alone and the
        // author is told why rather than watching the file stay as it was.
        if (caret.kind === 'crossFileId') {
            throw new RenameRefusedError(
                l10n.t("No file in this project declares '{0}', so there is nothing to rename.", caret.placeholder)
            );
        }
    }

    // A particle data channel rename rewrites every occurrence of the name in the same file.
    if (caret.kind === 'channel') {
        if (!VALID_NAME.test(newName)) throw refusedName(newName);
        for (const occurrence of channelOccurrences(document, caret.channel.name)) {
            add(filePathToUri(getStartOfAstNode(occurrence.node).uri), channelRangeOf(occurrence), newName);
        }
        dedupeEdits(changes);
        return guardPreparedRange({ changes }, caret, document);
    }

    if (!VALID_NAME.test(newName)) throw refusedName(newName);

    // A component `ID<>` slot renames the component it names: its declaration plus every other slot
    // in the part that names it. Without a declaration to follow there is nothing correct to write,
    // so the rename is refused with the reason rather than falling back to the enclosing field.
    if (caret.kind === 'componentId') {
        const declaration = findComponentDeclaration(caret.value, caret.id);
        const declared = declaration ? deriveRenameSymbol(declaration) : null;
        if (!declared) throw new RenameRefusedError(await componentRefusal(document, caret.id, cancellationToken));
        add(filePathToUri(getStartOfAstNode(declared.nameNode).uri), identifierRange(declared.nameNode), newName);
        addComponentIdSites(add, caret.value, caret.id, newName);
        dedupeEdits(changes);
        return guardPreparedRange({ changes }, caret, document);
    }

    const symbol =
        caret.kind === 'member'
            ? caret.symbol
            : await referenceSymbol(document, position, caret.reference, cancellationToken);
    // The box opened on the name the reference spells, so the author has already typed a new one. A
    // reference that resolves nowhere has no declaration to rewrite, and answering nothing at all
    // leaves them re-reading the file to find out that the rename did not happen.
    if (!symbol) {
        throw new RenameRefusedError(
            l10n.t(
                "'{0}' does not resolve to anything the editor can follow, so there is nothing to rename.",
                caret.placeholder
            )
        );
    }

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
                const range = segmentNameRangeExact(reference, span);
                // A site whose name cannot be placed in the text would have to be rewritten over the
                // whole value, delimiters included. Leaving it out instead would point it at a name
                // nothing declares any more, so the whole rename is refused with the reason.
                if (!range) {
                    throw new RenameRefusedError(
                        l10n.t(
                            'One of the references to this is written in a form the editor cannot rewrite, so nothing was renamed.'
                        )
                    );
                }
                add(filePathToUri(sourceUri), range, newName);
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

    // 4. A component declaration is named part-wide by its plain id, from slots the sibling
    // resolution above does not type: a part-level field, a bare list element, and the `Toggle =` of
    // a group written as a list element. Renaming the declaration without those leaves the part
    // pointing at a name nothing declares any more, which the game refuses to load.
    if (caret.kind === 'member') {
        const declaredId = componentDeclarationIdOf(caret.node);
        if (declaredId !== undefined) addComponentIdSites(add, caret.node, declaredId, newName);
    }

    dedupeEdits(changes);
    return guardPreparedRange({ changes }, caret, document);
};

/**
 * Add an edit for every component `ID<>` slot in the part that names `id`.
 *
 * @param add the edit collector of the running rename.
 * @param from any node of the part the component belongs to.
 * @param id the component id the slots name.
 * @param newName the name the component is being given.
 */
const addComponentIdSites = (
    add: (uri: string, range: Range, text: string) => void,
    from: AbstractNode,
    id: string,
    newName: string
): void => {
    for (const site of componentIdSites(from, id)) {
        add(filePathToUri(getStartOfAstNode(site).uri), valueTextRange(site), newName);
    }
};

/**
 * Why a component `ID<>` slot cannot be renamed from here: the component is declared in another file
 * the part folds in, or the part declares no component of that name at all.
 *
 * @param document the parsed document the caret is in.
 * @param id the component id written in the slot.
 * @param cancellationToken cancels the part-wide walk.
 * @returns the reason to show the author.
 */
const componentRefusal = async (
    document: AbstractNodeDocument,
    id: string,
    cancellationToken: CancellationToken
): Promise<string> => {
    const partIds = await collectPartComponentIds(document, cancellationToken).catch(() => undefined);
    const declaration = partIds?.declarations.get(id.toLowerCase());
    const elsewhere = declaration && normalizeUri(getStartOfAstNode(declaration).uri) !== normalizeUri(document.uri);
    // A component the part inherits is shared with every other part deriving from that base, so
    // rewriting it from here would leave the ones this rename never looked at pointing at the old name.
    return elsewhere
        ? l10n.t('The component is inherited from a base part. Declare it locally first.')
        : l10n.t("No component named '{0}' in this part.", id);
};

/**
 * The edit set, unless it fails to rewrite the very span `prepareRename` offered the author.
 *
 * The backstop behind every branch: the author typed a new name into a box drawn around one token,
 * so an edit set that rewrites this file somewhere else and leaves that token alone is renaming
 * something the author never asked about, whatever the reason. Both the file and the range are
 * compared, since several branches answer with a span away from the caret (a whole-file reference
 * offers its key, a component slot follows the id to its declaration).
 *
 * An edit set that touches this file not at all is left alone: a rename searches the folders it was
 * given, which need not contain the file the caret sits in, and rewriting nothing here damages
 * nothing here either.
 *
 * @param edit the edit the branch built.
 * @param caret what the caret resolved to, which is what `prepareRename` answered from.
 * @param document the parsed document the caret is in.
 * @returns the edit, or null when this file is rewritten anywhere but at the prepared span.
 */
export const guardPreparedRange = (
    edit: WorkspaceEdit,
    caret: RenameCaret,
    document: AbstractNodeDocument
): WorkspaceEdit | null => {
    const uri = normalizeUri(filePathToUri(document.uri));
    const edits = Object.entries(edit.changes ?? {}).find(([key]) => normalizeUri(key) === uri)?.[1];
    if (!edits?.length) return edit;
    return edits.some((candidate) => sameRange(candidate.range, caret.range)) ? edit : null;
};

/** Whether two ranges cover exactly the same span, which is how an edit is matched to a prepared one. */
const sameRange = (a: Range, b: Range): boolean =>
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character;

/**
 * The symbol a reference names, resolving through the path segment the caret sits on.
 *
 * @param document the parsed document the caret is in.
 * @param position the caret position.
 * @param found the reference value under the caret.
 * @param cancellationToken cancels the cross-file resolution.
 * @returns the symbol to rewrite, or null when the segment resolves nowhere.
 */
const referenceSymbol = async (
    document: AbstractNodeDocument,
    position: Position,
    found: ValueNode,
    cancellationToken: CancellationToken
): Promise<RenameSymbol | null> => {
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
};

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
 * A cross-file `ID<X>` value node: the cursor sits on a bare-id reference usage (a schema reference
 * field's value), on a whole-file root's own top-level `ID`, or on an aggregate entity's own id
 * (`Factions [ { ID = monolith } ]`, a colored light's `ColorID`). Synchronous (no cross-file
 * resolution): just enough to drive `prepareRename`'s range/placeholder. The actual cross-file
 * rewrite happens in `rename` via {@link idSymbolAt}, and the three shapes here are exactly the ones
 * it follows, so the box and the edit always name the same text.
 *
 * @param node the node under the caret.
 * @returns the id value node, or undefined when the caret is on no cross-file id.
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
    for (const declaration of entityDeclarationsOf(getStartOfAstNode(node))) {
        if (declaration.node === node) return node;
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
        return {
            nameNode: node.identifier,
            name: node.identifier.name,
            targetKey: locationKey(definitionLocationOf(node)),
        };
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
