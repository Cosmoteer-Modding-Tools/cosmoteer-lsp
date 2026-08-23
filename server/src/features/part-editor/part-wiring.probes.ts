/**
 * The verdicts behind the part wiring report: is the part registered on a ship, does the build
 * palette have anywhere to show it, do the game modes offer it, and are its keys in the language
 * files. Every answer comes from an index the server already builds, plus one two-pass reference
 * search shared by the palette and the mode rows.
 *
 * This is a report and must never become a diagnostic. Half the base game would fire: 50 of the 96
 * parts in vanilla's `terran.rules` parts list are named by no tech at all, and 9 of them carry no
 * editor group. A row whose coverage gate is closed therefore reads `unknown`, never `missing`.
 *
 * Lives under `features/part-editor` on purpose. `esbuild.cache-id.mjs` seeds the cache-id closure
 * from `server/src/mod` (where `mod-overview.ts` lives) but not from here, so shipping this module
 * leaves every user's on-disk caches valid. For the same reason the two helpers it shares in spirit
 * with `mod-overview.ts` (`code`, `fileLink`) and the `isRegistered` predicate of
 * `validator.duplicate-id.ts` are reimplemented locally rather than exported out of those files.
 * Reading `fileReferenceSites` out of `features/navigation` is not such a case: find-all-references
 * missed the file-reference spelling entirely, so that search had to change regardless, and one
 * implementation of it is what keeps this report and find-all-references agreeing.
 */
import { CancellationToken } from 'vscode-languageserver';
import * as l10n from '@vscode/l10n';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ValueNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { basenameOf } from '../../document/document-kind';
import { aliasRootIndex } from '../../document/schema/alias-root';
import { documentRootClass } from '../../document/schema/document-root';
import { fieldsOf, isLocalizationKeyType, schema } from '../../document/schema/schema';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { ValueType } from '../../document/schema/schema.types';
import { ActionRootingIndex } from '../../mod/action-rooting.index';
import { findMemberThroughInheritance, ResolveReferenceFn } from '../../semantics/inheritance-resolver';
import { getStartOfAstNode, namedMembersOf } from '../../utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { LocalizationKeyIndex } from '../completion/localization-key.index';
import { SchemaIdIndex } from '../completion/schema-id.index';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { definitionLocationOf, locationKey, normalizeUri } from '../navigation/reference-location';
import { ReverseIncludeIndex } from '../navigation/reverse-include.index';
import { declaringFieldOf, isSameOrSubclass } from '../navigation/schema-id-reference.navigation';
import { FileReferenceAnchor, fileReferenceName, fileReferenceSites } from '../navigation/schema-id-symbol';
import { documentsMentioning, uriToFsPath } from '../navigation/workspace-files';
// The table lives in part-fields.ts so the mod overview's part-unlock section can read it without
// pulling this report into the cache-id closure. Re-exported, since callers already import it here.
import { MODE_PART_FIELDS, PART_RULES_CLASS } from './part-fields';
export { MODE_PART_FIELDS };

/** The verdict of one checklist row: wired, not wired, or not judgeable from what is indexed. */
export type WiringMark = 'ok' | 'missing' | 'unknown';

/** One row of the report: its stable id, its heading, its verdict, and the evidence behind it. */
export interface WiringRow {
    /** Stable row id, so the renderer and the tests can name a row without matching prose. */
    readonly id: 'registration' | 'palette' | 'modes' | 'localization';
    /** The localized row heading. */
    readonly title: string;
    /** The row's verdict. */
    readonly mark: WiringMark;
    /** The localized evidence lines, rendered as bullets under the heading. */
    readonly findings: string[];
}

/** A part's identity as the rest of the game names it: its `ID`, its `OtherIDs` aliases, and where. */
export interface PartIdentity {
    /** The written `ID`, absent when the part declares none. */
    readonly id?: string;
    /** The `OtherIDs` aliases, which every id reference resolves through just like the primary id. */
    readonly aliases: string[];
    /** The `ID` value node, the anchor a file-reference spelling (`&<part.rules>/Part/ID`) resolves to. */
    readonly idNode?: ValueNode;
    /** The part group's own member name (`Part` in every vanilla part file), '' for a nameless root. */
    readonly memberName: string;
}

/** One place some other file names this part, with the field that names it. */
export interface PartReferenceSite {
    /** The naming document's uri. */
    readonly uri: string;
    /** The naming node itself, so a caller can read its enclosing context (a tech's own `ID`). */
    readonly node: AbstractNode;
    /** The field the name is written under, as spelled in the file. */
    readonly fieldName?: string;
    /** The class owning that field, when the naming file is rooted well enough to resolve it. */
    readonly ownerClass?: string;
}

/** The schema class of a build-palette group, whose ids a part's `EditorGroup` names. */
const EDITOR_GROUP_RULES_CLASS = 'Cosmoteer.Game.Gui.Build.EditorGroupRules';

/**
 * The ship field naming the part the editor starts with. It is not in the schema (`ShipRules`
 * declares `DefaultDoorID` but no `DefaultPartID`), yet vanilla writes it at `terran.rules:6` and
 * the game honours it, so it is matched by name rather than through a schema reference field. It is
 * the only thing that puts `corridor` in the palette, which carries neither an editor group nor a
 * parent part.
 */
const DEFAULT_PART_FIELD = 'defaultpartid';

/** How far up the parent chain the enclosing tech group is looked for. */
const MAX_ENCLOSING_DEPTH = 8;

/** The field names worth collecting a naming site for: the mode surface plus the ship default. */
const WIRING_FIELD_NAMES: ReadonlySet<string> = new Set([...MODE_PART_FIELDS.keys(), DEFAULT_PART_FIELD]);

const navigation = new FullNavigationStrategy();

/** Adapts the shared navigation strategy to the inheritance resolver's reference-resolution shape. */
const resolveReference: ResolveReferenceFn = (path, startNode, currentLocation, token, inheritanceVisited) =>
    navigation.navigate(path, startNode, currentLocation, token, new Set(), inheritanceVisited) as ReturnType<
        ResolveReferenceFn
    >;

/**
 * A member of a container by name, matched case-insensitively like the game's own node lookup. The
 * corpus does not fold case for us: a workshop manifest targets `.../terran/parts` in lower case,
 * so an exact-case read (which `childNamed` in `vector-forms.ts` deliberately is) would miss.
 */
const memberNamed = (container: { elements: AbstractNode[] }, name: string): AbstractNode | undefined => {
    const lower = name.toLowerCase();
    for (const [memberName, value] of namedMembersOf(container)) {
        if (memberName.toLowerCase() === lower) return value;
    }
    return undefined;
};

/** A member read that prefers the local declaration and falls back to the inheritance chain. */
const effectiveMember = async (
    group: GroupNode,
    name: string,
    token: CancellationToken
): Promise<AbstractNode | undefined> => {
    const local = memberNamed(group, name);
    if (local) return local;
    const inherited = await findMemberThroughInheritance(group, name, resolveReference, token).catch(() => null);
    return inherited ?? undefined;
};

/** The written text of a plain value node, without the surrounding quotes the parser already drops. */
const textOf = (node: AbstractNode | undefined): string | undefined =>
    node && isValueNode(node) && node.valueType.type === 'String' ? String(node.valueType.value) : undefined;

/** The written texts of a list's plain elements, tolerating the group spelling of a list. */
const textsOf = (node: AbstractNode | undefined): string[] => {
    if (!node) return [];
    const single = textOf(node);
    if (single !== undefined) return [single];
    if (!isListNode(node) && !isGroupNode(node)) return [];
    const out: string[] = [];
    for (const element of node.elements) {
        const text = textOf(element);
        if (text !== undefined) {
            out.push(text);
            continue;
        }
        // A structured entry writes the name one level in: the group spelling
        // (`EditorParentParts [ { Parent = … } ]`) and the positional spelling vanilla's thermal pumps
        // use (`EditorParentParts = [ ["cosmoteer.resonance_beam_turret", -1] ]`, where slot 0 is the
        // parent and slot 1 a sort order, which is a number and drops out on its own).
        if (isGroupNode(element)) {
            for (const [, value] of namedMembersOf(element)) {
                const nested = textOf(value);
                if (nested !== undefined) out.push(nested);
            }
        } else if (isListNode(element)) {
            for (const inner of element.elements) {
                const nested = textOf(inner);
                if (nested !== undefined) out.push(nested);
            }
        }
    }
    return out;
};

/** Markdown-safe inline code (backticks cannot appear in an id or a `.rules` path anyway). */
const code = (text: string): string => '`' + text.replace(/`/g, "'") + '`';

/**
 * A markdown link to a file, labeled with its bare file name. The destination is a `vscode://file/…`
 * deep link, not a `file:` uri: markdown-it's link validator (in VS Code's own preview too) rejects
 * the `file:` scheme outright and leaves the raw `[…](…)` text visible. Parentheses are
 * percent-encoded on top of the per-segment encoding, since an unencoded `)` in a file name
 * (`Kopie (2).rules`) would close the markdown destination early.
 *
 * @param path the file's on-disk path or uri.
 * @returns the markdown link.
 */
export const fileLink = (path: string): string => {
    const plain = uriToFsPath(path).replace(/\\/g, '/');
    const encoded = plain
        .split('/')
        .map((segment) => encodeURIComponent(segment).replace(/\(/g, '%28').replace(/\)/g, '%29'))
        .join('/');
    return `[${basenameOf(plain)}](vscode://file/${encoded})`;
};

/**
 * The part's identity: its `ID`, its `OtherIDs` aliases, and the member name the part group is
 * written under. Both id fields are read through inheritance, because a part that derives from a
 * base and forgets its own `ID` really does load under the base's id.
 *
 * @param part the part group.
 * @param token cancels the inheritance resolution.
 * @returns the identity, with an absent id when the part declares none anywhere.
 */
export const partIdentityOf = async (part: GroupNode, token: CancellationToken): Promise<PartIdentity> => {
    const idMember = await effectiveMember(part, 'ID', token);
    const idNode = idMember && isValueNode(idMember) ? idMember : undefined;
    const id = textOf(idNode);
    const aliases = textsOf(await effectiveMember(part, 'OtherIDs', token)).filter((alias) => alias !== id);
    return { id, aliases, idNode, memberName: part.identifier?.name ?? '' };
};

/** Whether a recorded slot type is a part group (or a list of them), the shape a parts list gives. */
const isPartSlot = (slot: ValueType | undefined): boolean => {
    if (!slot) return false;
    if (slot.kind === 'group') return isSameOrSubclass(slot.ref, PART_RULES_CLASS);
    if (slot.kind === 'list' || slot.kind === 'range' || slot.kind === 'interpolated') return isPartSlot(slot.element);
    return false;
};

/**
 * Row 1: whether anything pulls the part file into a ship, which is the difference between a part
 * the game registers and a file it never opens. Three sources answer, and each supplies its own
 * evidence: the forward alias walk from `cosmoteer.rules` (how every vanilla part is reached), a
 * mod manifest action, and the reverse-include index (the chained case, and the only source that
 * can name the including file).
 *
 * @param part the part group.
 * @param identity the part's identity, for the member name the indexes are keyed by.
 * @returns the row.
 */
export const registrationRow = (part: GroupNode, identity: PartIdentity): WiringRow => {
    const title = l10n.t('Registered on a ship');
    const uri = getStartOfAstNode(part).uri;
    const member = identity.memberName;
    // Without the game tree the forward walk never ran, so a negative verdict would be a lie. This is
    // the same gate the server's cross-file existence validators hold off on.
    if (!aliasRootIndex.isReady() || !CosmoteerWorkspaceService.instance.dataRootPath) {
        return {
            id: 'registration',
            title,
            mark: 'unknown',
            findings: [
                l10n.t('The game Data folder is not configured, so nothing can say whether a ship pulls this part in.'),
            ],
        };
    }

    const findings: string[] = [];
    const aliased = member === '' ? aliasRootIndex.rootType(uri) : aliasRootIndex.memberType(uri, member);
    if (isPartSlot(aliased)) findings.push(l10n.t('Registered in the game data tree.'));

    const actioned = member === '' ? ActionRootingIndex.instance.rootType(uri) : ActionRootingIndex.instance.memberType(uri, member);
    if (isPartSlot(actioned)) findings.push(l10n.t('Wired in by a mod.rules action.'));

    const includers = new Set<string>();
    for (const include of ReverseIncludeIndex.instance.includesOf(uri)) {
        if (include.member.toLowerCase() !== member.toLowerCase() || !isPartSlot(include.slot)) continue;
        includers.add(ReverseIncludeIndex.instance.realPathFor(include.source) ?? include.source);
    }
    for (const source of includers) findings.push(l10n.t('Pulled into the parts list of {0}.', fileLink(source)));

    if (findings.length > 0) return { id: 'registration', title, mark: 'ok', findings };
    return {
        id: 'registration',
        title,
        mark: 'missing',
        findings: [
            l10n.t('Nothing pulls this part file into a ship, so the game never registers it and it can never be built.'),
        ],
    };
};

/**
 * Row 2: whether the build palette has anywhere to show the part. Three shapes are accepted, and
 * all 96 entries of vanilla's terran parts list pass by exactly these: an editor group (87 of them),
 * a parent part to stack under (8), and being a ship's default part (1, `corridor`).
 *
 * Only "is there at least one placement" is asked. The effective ordered group list is deliberately
 * not computed: an inheriting list (`EditorGroups : ^/0/EditorGroups [ SWTechI ]`) prepends rather
 * than replaces, which the redundant-override validator already records as undecidable.
 *
 * @param part the part group.
 * @param sites the naming sites of the part, for the default-part branch.
 * @param folderPaths the project folders the id index is built from.
 * @param token cancels the index build and the inheritance reads.
 * @returns the row.
 */
export const paletteRow = async (
    part: GroupNode,
    sites: readonly PartReferenceSite[],
    folderPaths: string[],
    token: CancellationToken
): Promise<WiringRow> => {
    const title = l10n.t('Shown in the build palette');
    const findings: string[] = [];
    let accepted = false;

    // (a) An editor group. Its ids come from the top-level members of the game's editor-groups file,
    // harvested only because the build gui aliases that whole file into a keyed map, so without the
    // game tree there is no coverage at all and the row must not judge.
    const declared = await SchemaIdIndex.instance.idsForClass(EDITOR_GROUP_RULES_CLASS, folderPaths, token);
    const groupsCovered = SchemaIdIndex.instance.hasFileDeclarationsFor(EDITOR_GROUP_RULES_CLASS);
    if (groupsCovered) {
        const written = [
            ...textsOf(await effectiveMember(part, 'EditorGroup', token)),
            ...textsOf(await effectiveMember(part, 'EditorGroups', token)),
        ];
        const hits = [...new Set(written.filter((name) => declared.has(name)))];
        if (hits.length > 0) {
            accepted = true;
            findings.push(l10n.t('In the editor group {0}.', hits.map(code).join(', ')));
        }
    }

    // (b) A parent part to stack under, the shape 8 of the 9 group-less vanilla terran parts use.
    const parents = textsOf(await effectiveMember(part, 'EditorParentParts', token));
    if (parents.length > 0) {
        accepted = true;
        findings.push(l10n.t('Stacked under {0} in the palette.', parents.map(code).join(', ')));
    }

    // (c) A ship whose default part this is, which is what puts `corridor` in the palette.
    const defaults = new Set<string>();
    for (const site of sites) {
        if (site.fieldName?.toLowerCase() === DEFAULT_PART_FIELD) defaults.add(site.uri);
    }
    for (const uri of defaults) {
        accepted = true;
        findings.push(l10n.t('The default part of {0}.', fileLink(uri)));
    }

    if (accepted) return { id: 'palette', title, mark: 'ok', findings };
    if (!groupsCovered) {
        return { id: 'palette', title, mark: 'unknown', findings: [l10n.t('Not enough of the game is indexed to judge this.')] };
    }
    return {
        id: 'palette',
        title,
        mark: 'missing',
        findings: [
            l10n.t('No editor group, no parent part and no ship makes this its default part, so the palette never shows it.'),
        ],
    };
};

/** The id of the nearest enclosing group that declares one, which for a mode site is the tech. */
const enclosingDeclaredId = (node: AbstractNode): string | undefined => {
    let current: AbstractNode | undefined = node.parent;
    for (let depth = 0; current && depth < MAX_ENCLOSING_DEPTH; depth++, current = current.parent) {
        if (!isGroupNode(current)) continue;
        const id = textOf(memberNamed(current, 'ID'));
        if (id !== undefined) return id;
    }
    return undefined;
};

/**
 * Row 3: which techs and modes offer the part. Informational on purpose, so it never reads
 * `missing`: 50 of the 96 parts in vanilla's terran parts list are named by no tech at all, which
 * means the career mode offers them from the start.
 *
 * @param sites the naming sites of the part.
 * @param folderPaths the project folders the id index is built from.
 * @param token cancels the index build.
 * @returns the row.
 */
export const modeOfferingsRow = async (
    sites: readonly PartReferenceSite[],
    folderPaths: string[],
    token: CancellationToken
): Promise<WiringRow> => {
    const title = l10n.t('Offered in the game modes');
    // The same coverage question the id validator asks: with no part declarations indexed at all,
    // nothing was searched and "no tech names it" would be an artefact rather than a fact.
    await SchemaIdIndex.instance.idsForClass(PART_RULES_CLASS, folderPaths, token);
    if (!SchemaIdIndex.instance.hasFileDeclarationsFor(PART_RULES_CLASS)) {
        return { id: 'modes', title, mark: 'unknown', findings: [l10n.t('Not enough of the game is indexed to judge this.')] };
    }

    const techIds = new Set<string>();
    const otherFields = new Set<string>();
    let whitelisted = false;
    for (const site of sites) {
        const field = site.fieldName?.toLowerCase();
        if (!field || !MODE_PART_FIELDS.has(field)) continue;
        const techId = enclosingDeclaredId(site.node);
        if (techId !== undefined) {
            techIds.add(techId);
        } else if (field === 'partswhitelist') {
            whitelisted = true;
        } else {
            otherFields.add(site.fieldName!);
        }
    }

    // The tech verdict and the whitelist verdict are about different modes, so they coexist: a part
    // no tech unlocks is buildable from the start whether or not the build battle whitelists it.
    const findings: string[] = [];
    if (techIds.size > 0) findings.push(l10n.t('Unlocked by {0}.', [...techIds].map(code).join(', ')));
    else findings.push(l10n.t('Named by no tech, so the career mode offers it from the start.'));
    if (whitelisted) findings.push(l10n.t('In the build battle parts whitelist.'));
    for (const field of otherFields) findings.push(l10n.t('Named in the game mode field {0}.', code(field)));
    return { id: 'modes', title, mark: 'ok', findings };
};

/**
 * Row 4: whether every localization key the part writes exists, and in which languages. Keys are
 * matched case-insensitively, because vanilla itself references keys in the wrong case and the game
 * resolves them that way.
 *
 * @param part the part group.
 * @param folderPaths the project folders the strings index is built from.
 * @param token cancels the index build and the inheritance reads.
 * @returns the row.
 */
export const localizationRow = async (
    part: GroupNode,
    folderPaths: string[],
    token: CancellationToken
): Promise<WiringRow> => {
    const title = l10n.t('Named in the language files');
    const allKeys = await LocalizationKeyIndex.instance.allKeys(folderPaths, token);
    if (allKeys.size === 0) {
        return {
            id: 'localization',
            title,
            mark: 'unknown',
            findings: [l10n.t('Not enough of the game is indexed to judge this.')],
        };
    }

    // The schema names the key fields (`NameKey`, `IconNameKey`, `DescriptionKey`, `JobsNameKey`,
    // `StatsNotesKey`), so a game update that adds one is covered by regenerating the schema.
    const findings: string[] = [];
    let written = 0;
    let missing = false;
    for (const field of fieldsOf(PART_RULES_CLASS)) {
        if (!isLocalizationKeyType(field.valueType)) continue;
        const key = textOf(await effectiveMember(part, field.name, token));
        if (key === undefined || key.trim() === '') continue;
        written++;
        let texts = await LocalizationKeyIndex.instance.textsForKey(key, folderPaths, token);
        if (texts.length === 0) {
            // The game's key lookup folds case, so a differently-cased spelling is still declared.
            const lower = key.toLowerCase();
            const actual = [...allKeys].find((candidate) => candidate.toLowerCase() === lower);
            if (actual) texts = await LocalizationKeyIndex.instance.textsForKey(actual, folderPaths, token);
        }
        if (texts.length === 0) {
            missing = true;
            findings.push(l10n.t('{0}: declared in no language file.', code(key)));
        } else {
            findings.push(l10n.t('{0}: declared in {1}.', code(key), texts.map((text) => text.language).join(', ')));
        }
    }

    if (written === 0) {
        return {
            id: 'localization',
            title,
            mark: 'missing',
            findings: [l10n.t('This part names no localization key, so the game has no name to show for it.')],
        };
    }
    return { id: 'localization', title, mark: missing ? 'missing' : 'ok', findings };
};

/** The class owning a value node's declaring field, and the field name as spelled in the file. */
const declaringFieldOfValue = (node: AbstractNode): { ownerClass?: string; fieldName?: string } => {
    const container = node.parent;
    if (!container) return {};
    if (isListNode(container)) return declaringFieldOf(container);
    if (!isGroupNode(container) && !isDocumentNode(container)) return {};
    for (const element of container.elements) {
        if (isAssignmentNode(element) && element.right === node) {
            return {
                fieldName: element.left.name,
                ownerClass: isGroupNode(container) ? resolveGroupClass(container) : documentRootClass(container),
            };
        }
    }
    return {};
};

/** Collects every plain-value site in a document that writes one of `names` under a wiring field. */
const collectNameSites = (document: AbstractNodeDocument, names: ReadonlySet<string>, out: PartReferenceSite[]): void => {
    const visit = (node: AbstractNode): void => {
        if (isValueNode(node)) {
            if (node.valueType.type === 'String' && names.has(String(node.valueType.value))) {
                const declaring = declaringFieldOfValue(node);
                if (declaring.fieldName && WIRING_FIELD_NAMES.has(declaring.fieldName.toLowerCase())) {
                    out.push({ uri: document.uri, node, ...declaring });
                }
            }
            return;
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? node.right
                      ? [node.right]
                      : []
                  : [];
        for (const child of children) visit(child);
    };
    for (const element of document.elements) visit(element);
};

/**
 * Every place the project names this part in a field that decides its wiring: a game mode's part
 * list and a ship's default part. Two passes, because the corpus writes the same relation two ways.
 *
 * Pass A is the bare-id spelling (`PartsUnlocked = [SW.bed1]`, `PartsWhitelist [ cosmoteer.corridor ]`,
 * `{ PartID=cosmoteer.cannon_med; … }`, `DefaultPartID = cosmoteer.corridor`), pre-filtered by the id
 * and each alias. Pass B is the file-reference spelling (`PartsUnlocked =
 * [&<./Data/ships/terran/cannon_med/cannon_med.rules>/Part/ID]`, which vanilla's own tech tree uses),
 * run by {@link fileReferenceSites}, the same pass find-all-references uses so both features see the
 * same relation. Only the part file itself is left out of it, since this row asks which OTHER file
 * names the part.
 *
 * Both passes keep only fields that decide wiring, which is what keeps the search affordable: a part
 * id is mentioned by a handful of files, and only their references in those few fields are resolved.
 *
 * @param identity the part's identity.
 * @param partUri the part file's uri, used for the file-reference pre-filter.
 * @param folderPaths the project folders to search.
 * @param token cancels the search.
 * @returns every naming site found, in discovery order.
 */
export const partReferenceSites = async (
    identity: PartIdentity,
    partUri: string,
    folderPaths: string[],
    token: CancellationToken
): Promise<PartReferenceSite[]> => {
    const sites: PartReferenceSite[] = [];
    const names = new Set<string>([...(identity.id ? [identity.id] : []), ...identity.aliases]);
    const seen = new Set<string>();

    // Pass A: the bare-id spelling. Each candidate document is walked once and matched against every
    // name, so a file mentioning both the id and an alias is not parsed twice.
    for (const name of names) {
        for await (const document of documentsMentioning(folderPaths, name, token)) {
            const key = normalizeUri(document.uri);
            if (seen.has(key)) continue;
            seen.add(key);
            collectNameSites(document, names, sites);
        }
    }

    // Pass B: the file-reference spelling. Without an `ID` declaration there is nothing to compare a
    // resolved reference against, so the pass has no anchor and is skipped.
    if (!identity.idNode) return sites;
    const anchor: FileReferenceAnchor = {
        declarationKey: locationKey(definitionLocationOf(identity.idNode)),
        fileName: fileReferenceName(partUri),
        // The wiring gate runs before any resolution, so a file naming the part outside a wiring
        // field costs a substring test rather than a cross-file walk.
        accept: (reference) => {
            const fieldName = declaringFieldOfValue(reference).fieldName;
            return !!fieldName && WIRING_FIELD_NAMES.has(fieldName.toLowerCase());
        },
    };
    if (!anchor.fileName) return sites;
    const partKey = normalizeUri(partUri);
    for await (const document of documentsMentioning(folderPaths, anchor.fileName, token)) {
        if (normalizeUri(document.uri) === partKey) continue;
        for await (const reference of fileReferenceSites(document, anchor, token)) {
            sites.push({ uri: document.uri, node: reference, ...declaringFieldOfValue(reference) });
        }
    }
    return sites;
};
