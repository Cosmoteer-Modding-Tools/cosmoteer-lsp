import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    IdentifierNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { declaredFieldNames } from '../../document/schema/schema';
import { MentionIndex } from '../navigation/mention.index';
import { isCoveredByFolders, normalizeUri } from '../navigation/reference-location';
import { isStringsFile } from '../../mod/strings-folder';
import { ParserResultRegistrar } from '../../registrar/parser-result-registrar';
import { addSegments, walkReferenceReads } from './validator.ignored-field';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * The SCREAMING_CASE spelling of a user constant (`HEAT_TARGET_STORAGE`, `RELOAD`). A constant is not
 * a field the game deserializes: it exists to be read back through a reference, which is why one that
 * nothing reads is loaded and dropped. Two characters minimum, so a one-letter key (an `X`/`Y`
 * positional member) is never judged.
 */
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]+$/;

/**
 * Containers whose members the game instantiates by presence. A `Components` entry runs because it
 * sits in the map, not because anything spells its name, so a SCREAMING_CASE member (`FTL_DRIVE`, a
 * common mod idiom) is a live component, never a constant to judge.
 */
const INSTANTIATING_MAPS = new Set(['components', 'buffs']);

/** One reportable constant declaration, with everything the report and the cross-file check need. */
interface ConstantDeclaration {
    /** The name as written. */
    name: string;
    /** The lower-cased name, the identity reads are matched against (the game folds case). */
    key: string;
    /** The names a cross-file read could spell to reach it: its own, plus those of the constants
     *  nested inside it, which a read of the container's body can name instead. */
    names: string[];
    /** The identifier the diagnostic is anchored to. */
    anchor: IdentifierNode;
    /** Byte span of the whole declaration, key and value together. */
    range: { start: number; end: number };
}

/** What a document's own text says about its constants, before any cross-file evidence. */
interface DocumentConstants {
    /** Every top-level constant declaration, grouped by lower-cased name. */
    declarations: Map<string, ConstantDeclaration[]>;
    /** Names read from outside every constant, so the game's own data reaches them. */
    live: Set<string>;
    /** For each name read, the constants whose value reads it. */
    readBy: Map<string, Set<string>>;
}

/**
 * Whether a written member name is a user constant rather than a field the game reads. Any name the
 * schema declares anywhere is treated as a field, even in a container whose class did not resolve:
 * the game looks members up case-insensitively, so a `RANGE` key really is read as the `Range` field
 * of a class that declares one.
 *
 * @param name the written member name.
 * @returns true when the name can only be a user constant.
 */
const isConstantName = (name: string): boolean =>
    CONSTANT_NAME.test(name) && !declaredFieldNames().has(name.toLowerCase());

/**
 * The constant a node declares, or undefined when the node is a normal member. An assignment carries
 * its value in the same declaration (`HEAT_MAX = 5`), while a group or list declares its whole body
 * (`RELOAD_CURVE [ … ]`), so the removable span differs per shape.
 *
 * @param node the assignment, group or list to inspect.
 * @returns the declaration, or undefined when the node declares no constant.
 */
const declarationOf = (node: AbstractNode): ConstantDeclaration | undefined => {
    const named = (identifier: IdentifierNode, end: number): ConstantDeclaration => ({
        name: identifier.name,
        key: identifier.name.toLowerCase(),
        names: [identifier.name],
        anchor: identifier,
        range: { start: identifier.position.start, end },
    });
    if (isAssignmentNode(node)) {
        if (!isConstantName(node.left.name)) return undefined;
        return named(node.left, node.right?.position?.end ?? node.left.position.end);
    }
    if ((isGroupNode(node) || isListNode(node)) && node.identifier && isConstantName(node.identifier.name)) {
        return named(node.identifier, node.position.end);
    }
    return undefined;
};

/**
 * Reads the document's constants and who reads them. Every reference is attributed to the constant it
 * is written inside, so a value that only feeds another constant is recorded as such instead of
 * counting as a real read. A reference written anywhere else belongs to the game's own data and makes
 * what it names live. Constants nested inside another constant are not tracked separately: the
 * outermost one is the unit that lives or dies, and its body goes with it.
 *
 * @param document the parsed document to read.
 * @returns the declarations, the directly live names, and who read the rest.
 */
const readDocumentConstants = (document: AbstractNodeDocument): DocumentConstants => {
    const declarations = new Map<string, ConstantDeclaration[]>();
    const live = new Set<string>();
    const readBy = new Map<string, Set<string>>();
    const record = (text: string, owner: string | undefined): void => {
        const segments = new Set<string>();
        addSegments(text, segments);
        for (const segment of segments) {
            if (owner === undefined) live.add(segment);
            else (readBy.get(segment) ?? readBy.set(segment, new Set()).get(segment)!).add(owner);
        }
    };
    const declare = (node: AbstractNode, owner: string | undefined, container: AbstractNode): string | undefined => {
        const declaration = declarationOf(node);
        if (!declaration) return owner;
        // A member of an instantiating map is run by the game because it is in the map, so its
        // SCREAMING name declares a live thing, not a constant. Its reads stay attributed to the
        // enclosing owner (none at part level), which keeps what it reads live.
        if (
            (isGroupNode(container) || isListNode(container)) &&
            container.identifier &&
            INSTANTIATING_MAPS.has(container.identifier.name.toLowerCase())
        ) {
            return owner;
        }
        if (owner !== undefined) {
            // A nested constant is part of the enclosing one's surface: a read from another file can
            // name it instead of the container, which the cross-file check has to look for too.
            for (const outer of declarations.get(owner) ?? []) outer.names.push(declaration.name);
            return owner;
        }
        const known = declarations.get(declaration.key);
        if (known) known.push(declaration);
        else declarations.set(declaration.key, [declaration]);
        return declaration.key;
    };
    // A plain identifier value reads a member by name without any reference syntax: a schema id
    // field (`ComponentID = CRAM_AMMOSTORAGE`) names the component group that declares it, which
    // makes an upper-case group name load-bearing.
    walkReferenceReads(document, { reference: record, bareName: record, declare });
    return { declarations, live, readBy };
};

/**
 * The constants of a document that nothing in it reaches, each with whether anything reads it at all.
 * Liveness spreads from the reads written outside every constant: a constant a field reads is live,
 * and so is every constant that live one reads, transitively. What is left over is either read by
 * nobody, or read only by constants that are themselves unreachable, which is the chain the `read`
 * flag distinguishes.
 *
 * @param document the parsed document to analyze.
 * @param extraLive lower-cased constant keys proven read from outside the document (another file, an
 *        open buffer), which seed reachability like an in-file read: whatever their values read
 *        lives through them.
 * @returns one entry per unreachable declaration, in document order.
 */
export const unreachableConstants = (
    document: AbstractNodeDocument,
    extraLive?: ReadonlySet<string>
): Array<{ declaration: ConstantDeclaration; read: boolean }> => {
    const { declarations, live, readBy } = readDocumentConstants(document);
    if (declarations.size === 0) return [];
    const reachable = new Set<string>();
    // The inverse of `readBy`: what each constant reads, so spreading liveness is one lookup per step.
    const readsOf = new Map<string, string[]>();
    for (const [candidate, readers] of readBy) {
        for (const reader of readers) {
            const read = readsOf.get(reader);
            if (read) read.push(candidate);
            else readsOf.set(reader, [candidate]);
        }
    }
    const queue = [...live, ...(extraLive ?? [])];
    while (queue.length > 0) {
        const key = queue.pop()!;
        if (reachable.has(key) || !declarations.has(key)) continue;
        reachable.add(key);
        // Whatever this constant's own value reads is reached through it.
        for (const candidate of readsOf.get(key) ?? []) {
            if (!reachable.has(candidate)) queue.push(candidate);
        }
    }
    const unreachable: Array<{ declaration: ConstantDeclaration; read: boolean }> = [];
    for (const [key, declared] of declarations) {
        if (reachable.has(key)) continue;
        const read = (readBy.get(key)?.size ?? 0) > 0;
        for (const declaration of declared) unreachable.push({ declaration, read });
    }
    return unreachable.sort((a, b) => a.declaration.range.start - b.declaration.range.start);
};

/** Per-document memo of {@link namesReadBy}. Documents are replaced wholesale on re-parse, so a
 *  WeakMap keyed by the document needs no invalidation. */
const readNamesCache = new WeakMap<AbstractNodeDocument, Set<string>>();

/**
 * Every name a document reads, lower-cased: reference path segments, references embedded in quoted
 * expressions, and the plain identifier values a schema id field names a member with. Used for the
 * open buffers whose unsaved text the mention index has not seen.
 *
 * @param document the parsed document to read.
 * @returns the lower-cased names the document reads.
 */
const namesReadBy = (document: AbstractNodeDocument): Set<string> => {
    const cached = readNamesCache.get(document);
    if (cached) return cached;
    const { live, readBy } = readDocumentConstants(document);
    const names = new Set<string>(live);
    for (const name of readBy.keys()) names.add(name);
    readNamesCache.set(document, names);
    return names;
};

/**
 * Whole-document pass flagging user constants nothing reads. Both shapes are reported, the constant
 * no one reads at all and the constant read only by other unread constants, since a chain that ends
 * nowhere is as dead as its last link. Reported as a hint with a remove quick fix.
 *
 * Conservative, to stay false-positive-free. A constant is only judged when
 *  - the name is spelled like no field in the schema, so a case-folded read of a real field
 *    (`RANGE` against `Range`) is never mistaken for a constant,
 *  - the document lives under the searched folders, so the mention index has seen the files that
 *    could read it,
 *  - no other file in the project reads the name, which covers every cross-file read shape
 *    (`&<file>/NAME`, a derived part reading its base's constant, a `mod.rules` action targeting it)
 *    without resolving a single reference.
 * Strings files and mod manifests are skipped whole.
 *
 * @param document the parsed document to validate.
 * @param folderPaths the project folders the mention index covers.
 * @param cancellationToken cancels the index sync and the walk.
 * @returns one hint per unread constant, with a remove quick fix.
 */
export const validateUnusedConstants = async (
    document: AbstractNodeDocument,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    if (!isCoveredByFolders(document.uri, folderPaths)) return [];
    let unreachable = unreachableConstants(document);
    if (unreachable.length === 0) return [];
    if (await isStringsFile(document.uri, cancellationToken).catch(() => false)) return [];

    // Unsaved edits the index has not seen yet. Open buffers are few, and each one's read set is
    // memoized on its parsed document, so this stays a set lookup per constant.
    const selfKey = normalizeUri(document.uri);
    const openReads = new Set<string>();
    for (const open of ParserResultRegistrar.instance.allResults()) {
        if (normalizeUri(open.uri) === selfKey) continue;
        for (const name of namesReadBy(open)) openReads.add(name);
    }

    // Files the watcher reported changed are re-read first, so a reader created or edited on disk
    // (a `git checkout`, an external tool) is seen before its absence condemns a constant here. A
    // no-op when nothing is dirty. A full walk is still only paid when the index has not seen this
    // file at all (an unbuilt index, a file created since the last sweep): a sweep per validated
    // file would re-stat the whole project thousands of times over a whole-workspace scan. Without
    // the file itself in the index there is no project view to judge against, and reporting from
    // that state would flag everything.
    await MentionIndex.instance.syncDirty(cancellationToken).catch(() => undefined);
    if (!MentionIndex.instance.knows(selfKey)) {
        await MentionIndex.instance.ensureBuilt(folderPaths, cancellationToken).catch(() => undefined);
        if (!MentionIndex.instance.knows(selfKey)) return [];
    }

    // Cross-file and open-buffer evidence feeds the chain, not just the report: a constant another
    // file reads keeps alive everything its own value reads, so the reachability is recomputed with
    // the externally-read constants as live seeds. Skipping them in the report alone would still
    // flag the constants only they read as dead chain links.
    const externallyRead = new Set<string>();
    for (const { declaration } of unreachable) {
        if (
            declaration.names.some((name) => openReads.has(name.toLowerCase())) ||
            readElsewhere(declaration.names, selfKey, folderPaths)
        ) {
            externallyRead.add(declaration.key);
        }
    }
    if (externallyRead.size > 0) {
        unreachable = unreachableConstants(document, externallyRead);
        if (unreachable.length === 0) return [];
    }

    const errors: ValidationError[] = [];
    for (const { declaration, read } of unreachable) {
        if (cancellationToken.isCancellationRequested) return errors;
        errors.push({
            message: read
                ? l10n.t(
                      "'{0}' is only read by constants that are themselves never read, so the game loads none of them.",
                      declaration.name
                  )
                : l10n.t("'{0}' is a constant that nothing reads, so the game ignores it.", declaration.name),
            node: declaration.anchor,
            range: declaration.range,
            severity: 'hint',
            unnecessary: true,
            data: {
                remove: {
                    title: l10n.t("Remove '{0}'", declaration.name),
                    start: declaration.range.start,
                    end: declaration.range.end,
                },
            },
        });
    }
    return errors;
};

/**
 * Whether any file but this one reads one of the names. Answered from the mention index's read-word
 * table, which knows per file which words it reads rather than declares, so a sibling file that
 * merely declares a constant of the same name (the copied-template idiom) does not count. Reads are
 * matched by name and never resolved, so one file reading its own copy of a name keeps every other
 * copy of that name silent. That is the safe direction: a path from another file could just as well
 * land on this copy.
 *
 * @param names the constant's own name plus the names nested inside it.
 * @param selfKey the normalized key of the document being validated, excluded from the answer.
 * @param folderPaths the project folders the index covers.
 * @returns true when another file reads one of the names.
 */
const readElsewhere = (names: string[], selfKey: string, folderPaths: string[]): boolean =>
    names.some((name) =>
        MentionIndex.instance.filesReading(name, folderPaths).some((key) => key !== selfKey)
    );
