/**
 * Ranked lexical search over the whole schema: every class, field, enum, enum member and `Type=`
 * registry, plus the community-written prose on the classes and their fields. This is what a modder
 * reaches for when they know what they want the game to do but not what the field is called, which
 * is exactly the question completion cannot answer (completion needs the class, and the class needs
 * the field).
 *
 * The two request bodies live here so the wiring in `server.ts` stays a call: the search itself is
 * pure in-memory work over {@link schemaSearchEntries} and never touches the workspace, and only
 * the optional caret context (sent once when the picker opens) needs the document.
 */
import * as l10n from '@vscode/l10n';
import { CancellationToken, Position } from 'vscode-languageserver';
import { AbstractNodeDocument, isGroupNode } from '../../core/ast/ast';
import { findEnclosingContainer, memberScopeClassAt } from '../../document/schema/schema-context';
import { resolveClassThroughInheritance } from '../completion/inheritance-resolution';
import {
    classAncestry,
    enumDef,
    fieldSignatureMarkdown,
    fieldsOf,
    registryOf,
    schema,
    typeDef,
    valueTypeLabel,
    wikiUrlForType,
} from '../../document/schema/schema';
import { SchemaField } from '../../document/schema/schema.types';
import {
    SchemaSearchEntry,
    SchemaSearchEntryKind,
    fieldEntryId,
    schemaSearchEntries,
    schemaSearchEntryById,
} from './schema-search.index';

/** What the client sends. The document position rides along once, when the picker opens. */
export interface SchemaSearchParams {
    /** The raw query, whitespace-separated terms that are ANDed. */
    query: string;
    /** How many hits to return at most, capped by {@link SCHEMA_SEARCH_HIT_CAP}. */
    limit?: number;
    textDocument?: { uri: string };
    position?: Position;
}

/** One search result, kept small on purpose: 500 of these ship on every keystroke. */
export interface SchemaSearchHit {
    id: string;
    kind: SchemaSearchEntryKind;
    label: string;
    /** The owning class short name for a field, the FullName for a type, enum or registry. */
    owner: string;
    /** The value type of a field, or the kind of a type, enum or registry. */
    detail: string;
    /** A one-line excerpt of the prose documentation: a field's description, a class's summary. */
    prose?: string;
    /** True when the field may be scaffolded at the caret the picker was opened from. */
    insertable?: boolean;
    dead?: boolean;
    deprecated?: boolean;
    modContributed?: boolean;
}

/** What a search answers with, including how much was left out. */
export interface SchemaSearchResult {
    hits: SchemaSearchHit[];
    /** How many entries matched, before the cap. */
    total: number;
    truncated: boolean;
    /** The class the caret sat in when the picker opened, when one resolved. */
    contextClass?: string;
    contextClassName?: string;
}

/**
 * How many hits one search answers with, mirroring the completion list cap: past a few hundred rows
 * nobody scrolls, and the honest `total` says what was left out.
 */
export const SCHEMA_SEARCH_HIT_CAP = 500;

/** How long a prose excerpt on a hit may get before it is elided. */
const PROSE_SNIPPET_MAX = 160;

/** Which kind wins a tie: the thing a modder writes most often comes first. */
const KIND_ORDER: Record<SchemaSearchEntryKind, number> = {
    field: 0,
    type: 1,
    enum: 2,
    registry: 3,
    enumMember: 4,
};

/** A prose character that continues a word, so a match right after one is mid-word. */
const WORD_CHAR = /[a-z0-9]/;

/**
 * How well a term matches an entry's prose: a match at a word start reads as the reader's word, a
 * match inside one is a coincidence that still deserves to be findable.
 *
 * @param prose the entry's lower-cased prose.
 * @param term the lower-cased query term.
 * @returns the tier score, or -1 when the prose does not contain the term.
 */
const proseScore = (prose: string, term: string): number => {
    if (!prose.includes(term)) return -1;
    for (let at = prose.indexOf(term); at >= 0; at = prose.indexOf(term, at + 1)) {
        if (at === 0 || !WORD_CHAR.test(prose[at - 1])) return 160;
    }
    return 90;
};

/**
 * How well one term matches one entry, as a ladder that stops at the first tier that fires, so an
 * entry costs at most one scan per key. The tiers are ordered by how strongly the match predicts
 * that this is the entry the user meant: an exact name, then a prefix, then a prefix at a camel
 * hump, then a substring, then the acronym, then the owner, the value type, and finally the prose.
 *
 * There is deliberately no loose subsequence match on names. At this corpus size it is noise: a
 * scattered subsequence puts `FadeFromColor` above every real hit for `armor`, and the camel-hump
 * and acronym tiers cover the abbreviations a subsequence was meant to catch.
 *
 * @param entry the entry being scored.
 * @param term the lower-cased query term.
 * @returns the tier score, or -1 when the entry does not match the term at all.
 */
const scoreTerm = (entry: SchemaSearchEntry, term: string): number => {
    const name = entry.nameLower;
    if (name === term) return 1000;
    if (entry.aliasLower === term) return 960;
    if (name.startsWith(term)) return 850 - Math.min(49, name.length - term.length);
    for (const hump of entry.humps) {
        if (hump > 0 && name.startsWith(term, hump)) return 700 - Math.min(49, hump);
    }
    const inName = name.indexOf(term);
    if (inName >= 0) return 550 - Math.min(49, inName);
    if (entry.aliasLower?.includes(term)) return 520;
    if (term.length >= 2 && entry.acr.includes(term)) return 450;
    if (entry.ownerLower.includes(term)) return 300;
    if (entry.typeLower.includes(term)) return 220;
    return entry.proseLower ? proseScore(entry.proseLower, term) : -1;
};

/**
 * The combined score of an entry against every term. Terms are ANDed, so one term the entry cannot
 * match drops it. The strongest single term dominates the total and the average of all terms breaks
 * ties within that tier, which is what makes `bullet penetration` prefer the penetration field on a
 * bullet class over a penetration field whose owner merely mentions bullets.
 *
 * @param entry the entry being scored.
 * @param terms the lower-cased query terms.
 * @returns the combined score, or -1 when any term fails.
 */
const scoreEntry = (entry: SchemaSearchEntry, terms: readonly string[]): number => {
    let best = -1;
    let sum = 0;
    for (const term of terms) {
        const score = scoreTerm(entry, term);
        if (score < 0) return -1;
        if (score > best) best = score;
        sum += score;
    }
    return best * 4096 + Math.round(sum / terms.length);
};

/** A scored entry, before the wire shape is built. */
interface ScoredEntry {
    entry: SchemaSearchEntry;
    score: number;
    /** True for a field the caret's own class declares or inherits, which decides ties only. */
    inScope: boolean;
}

/** True for a field the game no longer reads, which must never outrank a live one. */
const isStale = (entry: SchemaSearchEntry): boolean => entry.dead === true || entry.deprecated === true;

/**
 * The total order the hits are returned in. Every tier is decided, down to the entry id, so two runs
 * of the same query answer with the same sequence.
 *
 * @param a the left scored entry.
 * @param b the right scored entry.
 * @returns the comparator result.
 */
const compareScored = (a: ScoredEntry, b: ScoredEntry): number => {
    if (a.score !== b.score) return b.score - a.score;
    // Only ever a tie-break, never a boost: a weaker textual match must not climb over a stronger one
    // just because the caret happens to sit in its class. Within one tier, though, the field the
    // caret's own group can actually hold is the one the author meant, and it is the only hit there
    // that can be written in place.
    const scope = Number(b.inScope) - Number(a.inScope);
    if (scope !== 0) return scope;
    const staleness = Number(isStale(a.entry)) - Number(isStale(b.entry));
    if (staleness !== 0) return staleness;
    const kind = KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind];
    if (kind !== 0) return kind;
    if (a.entry.label.length !== b.entry.label.length) return a.entry.label.length - b.entry.label.length;
    if (a.entry.label !== b.entry.label) return a.entry.label < b.entry.label ? -1 : 1;
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
};

/**
 * Ranks the whole entry table against a query.
 *
 * @param query the raw query text, split on whitespace into ANDed terms.
 * @param limit how many entries to return at most.
 * @param ancestry the caret class's inheritance chain, empty when no caret was resolved. Decides
 * ties only, so a search with no caret ranks exactly as it did before.
 * @returns the top entries in rank order and how many matched in total.
 */
export const rankSchemaEntries = (
    query: string,
    limit: number,
    ancestry: readonly string[] = []
): { entries: SchemaSearchEntry[]; total: number } => {
    const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 0);
    if (terms.length === 0) return { entries: [], total: 0 };
    const inScopeOf = ancestry.length > 0 ? new Set(ancestry) : undefined;
    const scored: ScoredEntry[] = [];
    for (const entry of schemaSearchEntries()) {
        const score = scoreEntry(entry, terms);
        if (score < 0) continue;
        const inScope = entry.kind === 'field' && inScopeOf !== undefined && inScopeOf.has(entry.ownerFullName);
        scored.push({ entry, score, inScope });
    }
    scored.sort(compareScored);
    return { entries: scored.slice(0, Math.max(0, limit)).map((hit) => hit.entry), total: scored.length };
};

/** Renders an authored `[[Type.Member]]` cross-reference down to the member name a modder types. */
const renderCrefs = (prose: string): string =>
    prose.replace(/\[\[([^\]]+)\]\]/g, (_, ref: string) => ref.split('.').pop()?.trim() ?? ref);

/** The single-line prose excerpt a hit carries, markup flattened and elided to one screen width. */
const proseSnippet = (prose: string): string => {
    const flat = renderCrefs(prose).replace(/`/g, '').replace(/\s+/g, ' ').trim();
    return flat.length > PROSE_SNIPPET_MAX ? `${flat.slice(0, PROSE_SNIPPET_MAX - 1).trimEnd()}…` : flat;
};

/** The short class name shown for a resolved caret context. */
const classDisplayName = (fullName: string): string => {
    const def = typeDef(fullName);
    return def?.derivedType ?? def?.name ?? fullName;
};

/**
 * Turns one ranked entry into the wire hit.
 *
 * @param entry the ranked entry.
 * @param ancestry the caret class's inheritance chain, empty when no context was resolved.
 * @returns the hit the client renders.
 */
const toHit = (entry: SchemaSearchEntry, ancestry: readonly string[]): SchemaSearchHit => ({
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    owner: entry.ownerLabel,
    detail: entry.typeLabel,
    prose: entry.prose ? proseSnippet(entry.prose) : undefined,
    insertable: entry.kind === 'field' && ancestry.includes(entry.ownerFullName) ? true : undefined,
    dead: entry.dead,
    deprecated: entry.deprecated,
    modContributed: entry.modContributed,
});

/**
 * The fields of the caret's own class, offered before anything is typed so the picker opens on
 * something useful instead of an empty list. Own fields first, then inherited ones, which is the
 * order {@link fieldsOf} already walks.
 *
 * @param contextClass the class the caret resolved to.
 * @param limit how many entries to return at most.
 * @returns the field entries of that class and its bases.
 */
const contextFieldEntries = (contextClass: string, limit: number): { entries: SchemaSearchEntry[]; total: number } => {
    const out: SchemaSearchEntry[] = [];
    const seen = new Set<string>();
    for (const cls of classAncestry(contextClass)) {
        for (const field of typeDef(cls)?.fields ?? []) {
            const key = field.name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            const entry = schemaSearchEntryById(fieldEntryId(cls, field.name));
            if (entry) out.push(entry);
        }
    }
    return { entries: out.slice(0, Math.max(0, limit)), total: out.length };
};

/**
 * Answers one `cosmoteer/schemaSearch` request.
 *
 * @param params the query, the hit limit, and (on the picker's first request) the caret position.
 * @param contextClass the class the caret resolved to, already resolved by the caller.
 * @returns the ranked hits with the caret context echoed back.
 */
export const searchSchema = (params: SchemaSearchParams, contextClass?: string): SchemaSearchResult => {
    const limit = Math.min(params.limit && params.limit > 0 ? params.limit : SCHEMA_SEARCH_HIT_CAP, SCHEMA_SEARCH_HIT_CAP);
    const ancestry = contextClass ? classAncestry(contextClass) : [];
    const query = params.query?.trim() ?? '';
    // An empty query with a resolved caret still has something to say: the class's own vocabulary.
    const ranked = query
        ? rankSchemaEntries(query, limit, ancestry)
        : contextClass
          ? contextFieldEntries(contextClass, limit)
          : { entries: [], total: 0 };
    return {
        hits: ranked.entries.map((entry) => toHit(entry, ancestry)),
        total: ranked.total,
        truncated: ranked.total > ranked.entries.length,
        contextClass,
        contextClassName: contextClass ? classDisplayName(contextClass) : undefined,
    };
};

/**
 * The class whose members are in scope at a caret, resolved the way field completion resolves it so
 * the picker offers exactly what completion would have offered there. Inheritance-aware, because a
 * deriving group (`MyTurret : ^/0/Turret { … }`) usually does not redeclare its own `Type`.
 *
 * @param document the parsed document the caret sits in.
 * @param offset the caret byte offset.
 * @param cancellationToken cancellation for the cross-file base resolution.
 * @returns the class FullName in scope, or undefined when the position has none.
 */
export const resolveSchemaSearchContext = async (
    document: AbstractNodeDocument,
    offset: number,
    cancellationToken: CancellationToken
): Promise<string | undefined> => {
    const container = findEnclosingContainer(document, offset);
    if (container && isGroupNode(container)) {
        const inherited = await resolveClassThroughInheritance(container, cancellationToken);
        if (inherited) return inherited;
    }
    // Covers the list-slot and whole-file-root positions, and falls back to the synchronous group
    // resolution when the inheritance walk found nothing.
    return memberScopeClassAt(document, offset);
};

/** One `- **Name**: `type`` line of a class's field listing, with its prose excerpt when documented. */
const fieldListLine = (field: SchemaField): string => {
    const head = `- \`${field.name}\`: \`${valueTypeLabel(field.valueType)}\`${field.optional ? '' : ` — ${l10n.t('required')}`}`;
    return field.description ? `${head} — ${proseSnippet(field.description)}` : head;
};

/** The wiki footer under a documentation page, when the class has a specialized page. */
const wikiFooter = (fullName: string): string[] => {
    const wiki = wikiUrlForType(fullName);
    return wiki ? ['', `_[${l10n.t('Cosmoteer modding wiki ↗')}](${wiki})_`] : [];
};

/** The documentation page of a field: the same signature block hover and completion already show. */
const fieldDetail = (entry: SchemaSearchEntry): string[] => [
    `# ${entry.label}`,
    '',
    `\`${entry.ownerFullName}\``,
    '',
    fieldSignatureMarkdown(entry.field as SchemaField, entry.ownerFullName),
];

/**
 * The class summary line, the sentence that answers "what is this?" before the listing below it
 * means anything. Authored cross-references render down to the name a modder types, the same way a
 * field's prose does.
 *
 * @param description the class or registry summary, when one is documented.
 * @returns the summary line and its blank line, or nothing.
 */
const summaryLines = (description?: string): string[] =>
    description ? [renderCrefs(description), ''] : [];

/** The documentation page of a class: what it is, what it is written as, what it extends, and every field. */
const typeDetail = (entry: SchemaSearchEntry): string[] => {
    const def = typeDef(entry.ownerFullName);
    const lines = [`# ${entry.label}`, '', `\`${entry.ownerFullName}\``, '', ...summaryLines(def?.description)];
    if (def?.derivedType && def.registry) {
        lines.push(
            l10n.t('Written as `{0} = {1}` in a `{2}` slot.', registryOf(def.registry)?.typeField ?? 'Type', def.derivedType, registryOf(def.registry)?.name ?? def.registry),
            ''
        );
    }
    if (def?.extends) lines.push(l10n.t('Extends `{0}`.', typeDef(def.extends)?.name ?? def.extends), '');
    const fields = fieldsOf(entry.ownerFullName).filter((field) => !/^\d+$/.test(field.name));
    lines.push(`## ${l10n.t('Fields')} (${fields.length})`, '');
    for (const field of fields) lines.push(fieldListLine(field));
    lines.push(...wikiFooter(entry.ownerFullName));
    return lines;
};

/** The documentation page of an enum, also used as the page of one of its members. */
const enumDetail = (entry: SchemaSearchEntry): string[] => {
    const def = enumDef(entry.ownerFullName);
    const lines = [`# ${entry.label}`, ''];
    if (entry.kind === 'enumMember') lines.push(l10n.t('A value of the `{0}` enum.', def?.name ?? entry.ownerFullName), '');
    lines.push(`\`${entry.ownerFullName}\``, '', `## ${l10n.t('Values')} (${def?.members.length ?? 0})`, '');
    for (const member of def?.members ?? []) lines.push(`- \`${member}\``);
    return lines;
};

/** The documentation page of a `Type=` registry: what the slot is, its subtypes, and the base class's own fields. */
const registryDetail = (entry: SchemaSearchEntry): string[] => {
    const registry = registryOf(entry.ownerFullName);
    const members = Object.entries(registry?.members ?? {});
    const lines = [
        `# ${entry.label}`,
        '',
        `\`${entry.ownerFullName}\``,
        '',
        ...summaryLines(registry?.description ?? typeDef(entry.ownerFullName)?.description),
        l10n.t('A group in this slot picks its class with `{0} = …`.', registry?.typeField ?? 'Type'),
        '',
        `## ${l10n.t('Subtypes')} (${members.length})`,
        '',
    ];
    for (const [disc, cls] of members) lines.push(`- \`${disc}\` — \`${typeDef(cls)?.name ?? cls}\``);
    // The registry base is usually a class too, and its fields are legal in every subtype's group.
    const fields = schema.types[entry.ownerFullName]
        ? fieldsOf(entry.ownerFullName).filter((field) => !/^\d+$/.test(field.name))
        : [];
    if (fields.length > 0) {
        lines.push('', `## ${l10n.t('Fields')} (${fields.length})`, '');
        for (const field of fields) lines.push(fieldListLine(field));
    }
    lines.push(...wikiFooter(entry.ownerFullName));
    return lines;
};

/**
 * The markdown documentation page for one search hit, fetched only for the hit the user opened.
 * Shipping this with every search result would cost hundreds of kilobytes per keystroke, which is
 * the same reason completion defers its documentation to the resolve request.
 *
 * @param id the entry id the hit carried.
 * @returns the markdown page, or undefined when the schema no longer declares the entry.
 */
export const schemaSearchDetail = (id: string): string | undefined => {
    const entry = schemaSearchEntryById(id);
    if (!entry) return undefined;
    const lines =
        entry.kind === 'field' && entry.field
            ? fieldDetail(entry)
            : entry.kind === 'type'
              ? typeDetail(entry)
              : entry.kind === 'registry'
                ? registryDetail(entry)
                : enumDetail(entry);
    return `${lines.join('\n')}\n`;
};
