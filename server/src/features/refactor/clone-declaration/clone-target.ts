import { statSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../../core/ast/ast';
import { lexer } from '../../../core/lexer/lexer';
import { parser } from '../../../core/parser/parser';
import { isManifestBasename, isModRules, isRulesFileName } from '../../../document/document-kind';
import { documentRootClass } from '../../../document/schema/document-root';
import { ENTITY_FIELDS, identityKeyOf, PART_RULES_CLASS } from '../../../document/schema/entity-schema';
import { resolveGroupClass } from '../../../document/schema/schema-context';
import { flattenGroup } from '../../../semantics/effective-group';
import { parseText } from '../../../utils/ast.utils';
import { safeReaddir } from '../../../utils/fs.utils';
import { isStringsFile } from '../../../mod/strings-folder';
import { modIdDeclarationsOf } from '../../diagnostics/validator.duplicate-id';

/**
 * How much of the source a clone carries.
 *
 * `directory` is the normal shape for a ship part: the file sits alone in a folder with its sprites
 * and its particle fragments, and the game resolves every one of those paths against that folder, so
 * copying the folder is the only way the copy still finds its own art. `file` is the fallback for a
 * folder holding several declarations, where copying it would duplicate the neighbours' ids too.
 * `listElement` is the whole-collection shape (`Factions [ { ID = … } … ]`), where the copy is another
 * element of the very same list rather than another file.
 */
export type CloneUnit = 'directory' | 'file' | 'listElement';

/** Why the caret anchors no clone. */
export type CloneTargetRefusal = 'noDeclaration' | 'inheritedIdentity' | 'unreadableBase' | 'severalIdentities';

/** The identity slot a declaration writes. */
interface CloneIdentity {
    /** The field's name as the file writes it (`ID`, `ToggleID`, …). */
    readonly key: string;
    /** The id as written. */
    readonly id: string;
    /** The value node the new id replaces. */
    readonly node: ValueNode;
}

/** One thing in a document that declares an instance of a class, whether or not it writes its own id. */
interface CloneShape {
    /** The class the declaration is an instance of. */
    readonly cls: string;
    /** The group or document being cloned. */
    readonly container: GroupNode | AbstractNodeDocument;
    /** The field name the class identifies its instances by. */
    readonly identityKey: string;
    /** The identity the container writes itself, absent when it writes none. */
    readonly identity?: CloneIdentity;
    /** True when the container is an element of an aggregate list rather than a file-level group. */
    readonly inList: boolean;
    /** The member a registration wires in (`Part`, `Factions`), empty for a whole-file root. */
    readonly member: string;
}

/** The declaration a clone was anchored on, with everything the plan needs to copy it. */
export interface CloneTarget {
    /** The declaring file's on-disk path, with forward slashes. */
    readonly fsPath: string;
    /** The declaring file's uri. */
    readonly uri: string;
    readonly cls: string;
    readonly identityKey: string;
    readonly id: string;
    /** The identity value node, whose span the new id is written over. */
    readonly node: ValueNode;
    readonly container: GroupNode | AbstractNodeDocument;
    readonly member: string;
    readonly unit: CloneUnit;
}

/** What a lookup came to. */
export type CloneTargetResult = { target: CloneTarget } | { refusal: CloneTargetRefusal };

/** The span a container covers in its file, so the innermost one under the caret can be picked. */
const spanOf = (container: GroupNode | AbstractNodeDocument): { start: number; end: number } => {
    if (isDocumentNode(container)) return { start: 0, end: Number.MAX_SAFE_INTEGER };
    const start = container.identifier?.position.start ?? container.position.start;
    // A group whose brace never arrived leaves its end at zero, which the container-position
    // invariant means as open-ended rather than as an empty span.
    const end = container.position.end > start ? container.position.end : Number.MAX_SAFE_INTEGER;
    return { start, end };
};

/** The identity a container writes itself, read by the name the class spells its identity slot with. */
const ownIdentityOf = (
    container: GroupNode | AbstractNodeDocument,
    identityKey: string
): CloneIdentity | undefined => {
    for (const element of container.elements) {
        if (!isAssignmentNode(element) || !isValueNode(element.right)) continue;
        if (element.left.name.toLowerCase() !== identityKey.toLowerCase()) continue;
        const id = String(element.right.valueType.value).trim();
        if (id === '') continue;
        return { key: element.left.name, id, node: element.right };
    }
    return undefined;
};

/**
 * Every declaration in a document a clone could be anchored on, in the three shapes an id is
 * decidable in. Deliberately the same three {@link modIdDeclarationsOf} judges, so a clone is only
 * ever offered where the duplicate-id check can afterwards tell whether the new id collides.
 *
 * @param document the parsed document.
 * @returns the shapes in document order, outermost last.
 */
export const cloneShapesOf = (document: AbstractNodeDocument): CloneShape[] => {
    const shapes: CloneShape[] = [];
    for (const element of document.elements) {
        // A ship part, which is a top-level group of the part class however the file names it.
        if (isGroupNode(element) && element.identifier && resolveGroupClass(element) === PART_RULES_CLASS) {
            shapes.push({
                cls: PART_RULES_CLASS,
                container: element,
                identityKey: identityKeyOf(PART_RULES_CLASS) ?? 'ID',
                identity: ownIdentityOf(element, 'ID'),
                inList: false,
                member: element.identifier.name,
            });
        }
        // An element of an aggregate collection, restricted to list names that reach exactly one
        // class. A name reaching two says nothing about which collection the element joins, and those
        // collections legitimately carry the same ids.
        if (isListNode(element) && element.identifier) {
            const candidates = ENTITY_FIELDS.get(element.identifier.name.toLowerCase());
            if (candidates?.length === 1) {
                const { elementClass, identityKey } = candidates[0];
                for (const entry of element.elements) {
                    if (!isGroupNode(entry)) continue;
                    shapes.push({
                        cls: elementClass,
                        container: entry,
                        identityKey,
                        identity: ownIdentityOf(entry, identityKey),
                        inList: true,
                        member: element.identifier.name,
                    });
                }
            }
        }
    }
    // The whole file as one instance, which is how a resource, a status or a shot is written. Last,
    // so a group inside it wins the innermost-container pick.
    const rootClass = documentRootClass(document);
    if (rootClass) {
        shapes.push({
            cls: rootClass,
            container: document,
            identityKey: identityKeyOf(rootClass) ?? 'ID',
            identity: ownIdentityOf(document, identityKeyOf(rootClass) ?? 'ID'),
            inList: false,
            member: '',
        });
    }
    return shapes;
};

/**
 * The declaration the caret sits in: the innermost container covering the offset, or the file's only
 * declaration when the caret sits above all of them, the way the part registration anchors its offer.
 *
 * @param document the parsed document.
 * @param offset the caret's byte offset.
 * @returns the shape, or the reason the caret picks none.
 */
export const cloneShapeAt = (
    document: AbstractNodeDocument,
    offset: number
): { shape: CloneShape } | { refusal: CloneTargetRefusal } => {
    const shapes = cloneShapesOf(document);
    if (shapes.length === 0) return { refusal: 'noDeclaration' };
    let best: CloneShape | undefined;
    let bestStart = -1;
    for (const shape of shapes) {
        const span = spanOf(shape.container);
        if (offset < span.start || offset >= span.end) continue;
        if (span.start > bestStart) {
            best = shape;
            bestStart = span.start;
        }
    }
    if (best) return { shape: best };
    if (shapes.length === 1) return { shape: shapes[0] };
    // Several declarations and a caret in none of them: which one is meant is the author's to say.
    return { refusal: 'severalIdentities' };
};

/**
 * Whether the container gets its identity from a base rather than writing one, and whether its chain
 * could be read at all. A base template writes no `ID` on purpose, so a copy of it would carry
 * whatever id the base hands it and collide with the original the moment the game loads both.
 *
 * @param shape the declaration to judge.
 * @param cancellationToken cancels the cross-file walk over the inheritance chain.
 * @returns the refusal, or undefined when the container is safe to copy.
 */
const identityRefusalOf = async (
    shape: CloneShape,
    cancellationToken: CancellationToken
): Promise<CloneTargetRefusal | undefined> => {
    const flattened = await flattenGroup(shape.container, cancellationToken).catch(() => undefined);
    // Nothing could be read about the chain, so nothing can be promised about the copy.
    if (!flattened) return 'unreadableBase';
    if (flattened.unreadable.length > 0) return 'unreadableBase';
    if (shape.identity) return undefined;
    const inherited = flattened.members.find(
        (member) => member.name.toLowerCase() === shape.identityKey.toLowerCase()
    );
    return inherited?.origin.inherited ? 'inheritedIdentity' : 'noDeclaration';
};

/** The directories a copy-unit walk never descends into, because none of them is part of the part. */
const SKIPPED_DIRS = new Set(['.git', '.svn', 'node_modules', '.vs', '.vscode', '.idea']);

/** How many files a copy unit may hold before the whole-directory shape is given up on. */
const MAX_UNIT_FILES = 4000;

/** Every file below a directory, with forward slashes, capped so a mistaken root cannot be copied. */
export const filesUnder = (dir: string): string[] => {
    const files: string[] = [];
    const walk = (current: string): void => {
        if (files.length > MAX_UNIT_FILES) return;
        for (const name of safeReaddir(current)) {
            if (SKIPPED_DIRS.has(name.toLowerCase())) continue;
            const path = join(current, name).replace(/\\/g, '/');
            let directory: boolean;
            try {
                directory = statSync(path).isDirectory();
            } catch {
                continue;
            }
            if (directory) walk(path);
            else files.push(path);
        }
    };
    walk(dir.replace(/\\/g, '/'));
    return files;
};

/**
 * How a file inside a copied unit is treated.
 *
 * `rules` is a `.rules` file, which holds rules whatever is written in it. `maybeRules` is a file the
 * project walks index alongside it, a `.txt`, which mods really do declare whole parts in and just as
 * often use for a note to the reader, so only reading it says which of the two it is. `other` is
 * everything else, the sprites and sounds a copy carries byte for byte.
 */
export type UnitFileKind = 'rules' | 'maybeRules' | 'other';

/**
 * How a file of a copied unit is treated, from its name alone.
 *
 * @param file the file's path, with either separator.
 * @returns the kind, which says whether the file has to be read before it can be judged.
 */
export const unitFileKindOf = (file: string): UnitFileKind => {
    if (file.toLowerCase().endsWith('.rules')) return 'rules';
    // The name alone decides this, so both separators have to be cut off it. A path left whole would
    // carry its directories into the name test, and `readme.txt` under any folder would stop reading
    // as the prose it is.
    const name = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
    return isRulesFileName(name) ? 'maybeRules' : 'other';
};

/**
 * The document a `maybeRules` file contributes, which is none when the text reads as prose. The game's
 * loader reads a file the same way and refuses what the parser reports here, so a note left in a part
 * folder stays a note rather than becoming content the copy rewrites.
 *
 * A fragment the parser reports an error in comes back as none too. Nothing in a file that does not
 * parse can be trusted to say what it declares, and reading it as prose is the price of keeping prose
 * out.
 *
 * @param text the file's text.
 * @param path the file's on-disk path.
 * @returns the parsed document, or undefined when the text does not read as rules.
 */
export const maybeRulesDocumentOf = (text: string, path: string): AbstractNodeDocument | undefined => {
    try {
        const parsed = parser(lexer(text), path);
        return parsed.parserErrors.length === 0 ? parsed.value : undefined;
    } catch {
        return undefined;
    }
};

/**
 * How much of the source a clone has to carry.
 *
 * The whole directory when the declaring file is the only thing in it that declares an id: the game
 * resolves a part's sprites, sounds and particle fragments against the folder the file is written in,
 * so a copy that leaves them behind loads with no art and no error, which is the failure this whole
 * refactoring exists to prevent. A folder that holds a second declaration is copied file by file
 * instead, because carrying the neighbours along would duplicate their ids as well.
 *
 * A folder holding a mod manifest is never the unit either: that is a whole mod, not a part.
 *
 * @param fsPath the declaring file's on-disk path.
 * @param cancellationToken cancels the sibling reads.
 * @returns the unit to copy.
 */
export const copyUnitOf = async (fsPath: string, cancellationToken: CancellationToken): Promise<CloneUnit> => {
    const dir = fsPath.replace(/\\/g, '/').slice(0, fsPath.replace(/\\/g, '/').lastIndexOf('/'));
    if (dir === '') return 'file';
    const files = filesUnder(dir);
    if (files.length === 0 || files.length > MAX_UNIT_FILES) return 'file';
    if (files.some((file) => isManifestBasename(file.slice(file.lastIndexOf('/') + 1)))) return 'file';
    const own = fsPath.replace(/\\/g, '/').toLowerCase();
    for (const file of files) {
        if (cancellationToken.isCancellationRequested) return 'file';
        if (file.toLowerCase() === own) continue;
        const kind = unitFileKindOf(file);
        if (kind === 'other') continue;
        const text = await readFile(file, { encoding: 'utf-8' }).catch(() => undefined);
        let document: AbstractNodeDocument | undefined;
        if (kind === 'rules') {
            // An unreadable neighbour could declare anything, so the safe unit is the single file.
            if (text === undefined) return 'file';
            try {
                document = parseText(text, file);
            } catch {
                return 'file';
            }
        } else {
            // A `.txt` counts only once it reads as rules, which a note does not and which a
            // fragment holding a parse error cannot be told apart from. Judging the folder on
            // either would leave a part's art behind for the sake of a note.
            document = text === undefined ? undefined : maybeRulesDocumentOf(text, file);
            if (document === undefined) continue;
        }
        if (!modIdDeclarationsOf(document).next().done) return 'file';
    }
    return 'directory';
};

/**
 * The declaration the caret anchors a clone on, with the copy unit worked out and every refusal that
 * can be decided before a destination is even known.
 *
 * @param document the parsed document the caret is in.
 * @param offset the caret's byte offset.
 * @param fsPath the document's on-disk path, with forward slashes.
 * @param uri the document's uri.
 * @param cancellationToken cancels the inheritance walk and the sibling reads.
 * @returns the target, or the reason there is none.
 */
export const locateCloneTarget = async (
    document: AbstractNodeDocument,
    offset: number,
    fsPath: string,
    uri: string,
    cancellationToken: CancellationToken
): Promise<CloneTargetResult> => {
    // A manifest declares actions, never content, and a group inside one is a fragment it points at.
    if (isModRules(uri)) return { refusal: 'noDeclaration' };
    // A language file holds the text the player reads. A rules-shaped block in one is dead content the
    // game reads as a string, so there is nothing there to copy however much it looks like a part.
    let strings = false;
    try {
        strings = await isStringsFile(uri, cancellationToken);
    } catch {
        /* an unreadable manifest says nothing about the file, so it is judged on its content alone */
    }
    if (strings) return { refusal: 'noDeclaration' };
    const found = cloneShapeAt(document, offset);
    if ('refusal' in found) return found;
    const shape = found.shape;
    const refusal = await identityRefusalOf(shape, cancellationToken);
    if (refusal) return { refusal };
    if (!shape.identity) return { refusal: 'noDeclaration' };
    // Two containers of one file writing their own id is a real shape (three of the game's own files
    // do it), and the caret has already said which of them is meant, so nothing is refused here.
    const unit = shape.inList ? 'listElement' : await copyUnitOf(fsPath, cancellationToken);
    return {
        target: {
            fsPath,
            uri,
            cls: shape.cls,
            identityKey: shape.identity.key,
            id: shape.identity.id,
            node: shape.identity.node,
            container: shape.container,
            member: shape.member,
            unit,
        },
    };
};

/**
 * The member the container writes under `name`, with the exact source span to cut out when it is
 * removed. An assignment carries no position of its own, so the span is measured from the name it
 * assigns to the end of the value, then grown over the whitespace in front of it and over the rest of
 * its line when nothing but spaces or a trailing comment follow.
 *
 * @param container the group or document holding the member.
 * @param text the file's source.
 * @param name the member name to find.
 * @returns the span to remove and the value as written, or undefined when the container writes none.
 */
export const removableMemberSpan = (
    container: GroupNode | AbstractNodeDocument,
    text: string,
    name: string
): { start: number; end: number; value: AbstractNode } | undefined => {
    for (const element of container.elements) {
        if (!isAssignmentNode(element) || element.left.name.toLowerCase() !== name.toLowerCase()) continue;
        const value = element.right;
        if (!value) continue;
        let start = element.left.position.start;
        let end = value.position.end;
        while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
        let cursor = end;
        while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor++;
        if (text.startsWith('//', cursor)) {
            while (cursor < text.length && text[cursor] !== '\n') cursor++;
        }
        if (text[cursor] === '\r') cursor++;
        if (text[cursor] === '\n') cursor++;
        // Only swallow the line ending when the line really ends there, so a member written beside a
        // sibling on one line does not take the sibling with it.
        if (cursor > end && (text[cursor - 1] === '\n' || cursor === text.length)) end = cursor;
        return { start, end, value };
    }
    return undefined;
};

/** The directory a path lives in, with forward slashes. */
export const dirOfPath = (fsPath: string): string => {
    const normalized = fsPath.replace(/\\/g, '/');
    const cut = normalized.lastIndexOf('/');
    return cut <= 0 ? normalized : normalized.slice(0, cut);
};

/** A path resolved against a directory, with forward slashes, so every comparison sees one spelling. */
export const resolvePath = (dir: string, path: string): string => resolve(dir, path).replace(/\\/g, '/');
