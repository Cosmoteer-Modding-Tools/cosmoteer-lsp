/**
 * Alias-based fragment rooting.
 *
 * The game root `cosmoteer.rules` (schema class `Cosmoteer.Data.Rules`) doesn't inline most of its
 * data — it aliases it in from fragment files by field, e.g.
 *
 *     Factions = &<factions/factions.rules>/Factions     // field Factions : list<FactionRules>
 *     Buffs    = &<buffs/buffs.rules>                     // field Buffs    : map<BuffType, BuffRules>
 *     CareerMode = &<modes/career/career.rules>           // field CareerMode : group<CareerModeRules>
 *
 * A fragment file therefore has no self-describing root class — its type comes from the FIELD that
 * pulls it in. This module walks those aliases forward from `cosmoteer.rules` (recursing through
 * whole-file group aliases like `CareerMode`) and records, per target file, the schema {@link ValueType}
 * of each aliased member (or of the file root itself for a member-less alias). {@link resolveGroupClass}
 * / {@link expectedValueType} then root an otherwise-unrooted fragment by looking its members up here —
 * which is what makes references and completion inside fragment files (a tech's `Prerequisites`, a
 * buff group's fields) resolve, and disambiguates same-named lists by their source (a `Techs` from
 * `career.rules` is `TechRules`, not pvp `BuildBattleTechRules`).
 *
 * Built once from the workspace (see the navigation-side builder), cached, and invalidated when
 * `cosmoteer.rules` changes. The file resolver is injected so this schema-layer module needs no
 * dependency on the navigation layer.
 */
import { AbstractNodeDocument, isAssignmentNode, isDocumentNode, isGroupNode, isValueNode } from '../../core/ast/ast';
import { fieldOf } from './schema';
import { ValueType } from './schema.types';
import { normalizeUri } from '../../features/navigation/reference-location';

const ROOT_CLASS = 'Cosmoteer.Data.Rules';
const MAX_DEPTH = 12;

/** Resolve a file-only reference (`<path/to.rules>`) written in `fromUri` to its parsed document. */
export type FileRefResolver = (fileRef: string, fromUri: string) => Promise<AbstractNodeDocument | undefined>;

/** Split `&<path/to.rules>/Member/…` into the file ref and the first member segment (if any). */
export const parseAlias = (raw: string): { fileRef: string; member?: string } | undefined => {
    const m = /^&?\s*(<[^>]*>)\s*(?:\/\s*(.+))?$/.exec(raw.trim());
    if (!m) return undefined;
    const member = m[2]?.split('/')[0]?.trim();
    return { fileRef: m[1], member: member || undefined };
};

class AliasRootIndex {
    private static _instance: AliasRootIndex;
    public static get instance(): AliasRootIndex {
        return (AliasRootIndex._instance ??= new AliasRootIndex());
    }

    /** normalized file uri → (aliased member name, or '' for the file root → its schema valueType). */
    private readonly index = new Map<string, Map<string, ValueType>>();
    private built = false;
    private _revision = 0;

    /** A counter that moves whenever the index's content may have changed (a build or an
     *  invalidation), so rooting-dependent caches can detect change instead of assuming it. */
    public get revision(): number {
        return this._revision;
    }

    public isReady(): boolean {
        return this.built;
    }

    public invalidate(): void {
        this.built = false;
        this._revision++;
        this.index.clear();
    }

    /** The schema type aliased onto `member` of the file at `uri`, if any. The member name matches case-insensitively like the game's node lookup. */
    public memberType(uri: string, member: string): ValueType | undefined {
        return this.index.get(normalizeUri(uri))?.get(member.toLowerCase());
    }

    /** The schema type the whole file at `uri` was aliased to (a member-less `Field = &<file>`), if any. */
    public rootType(uri: string): ValueType | undefined {
        return this.index.get(normalizeUri(uri))?.get('');
    }

    /** Build the index by walking `cosmoteer.rules`'s aliases. Idempotent until {@link invalidate}. */
    public async build(rootDoc: AbstractNodeDocument, resolve: FileRefResolver): Promise<void> {
        if (this.built) return;
        this.index.clear();
        await this.walk(rootDoc, ROOT_CLASS, rootDoc.uri, resolve, new Set([normalizeUri(rootDoc.uri)]), 0);
        this.built = true;
        this._revision++;
    }

    private put(uri: string, member: string, valueType: ValueType): void {
        const norm = normalizeUri(uri);
        (this.index.get(norm) ?? this.index.set(norm, new Map()).get(norm)!).set(member.toLowerCase(), valueType);
    }

    /**
     * Walk a container (the root document, a file-aliased fragment, or an inline group like
     * `Game { GameGui = &<…> … }`) under its schema `ownerClass`, recording every `&<file>` alias and
     * recursing into both file-aliased and inline `group<C>` members. `sourceUri` is the document the
     * refs are written in (for relative file resolution); `seen` guards file-level recursion.
     */
    private async walk(
        container: { elements: AbstractNodeDocument['elements'] },
        ownerClass: string,
        sourceUri: string,
        resolve: FileRefResolver,
        seen: Set<string>,
        depth: number
    ): Promise<void> {
        if (depth > MAX_DEPTH) return;

        for (const element of container.elements) {
            // `Field = &<file>[/member]` — an alias to another file.
            if (isAssignmentNode(element) && isValueNode(element.right) && element.right.valueType.type === 'Reference') {
                const fieldType = fieldOf(ownerClass, element.left.name)?.valueType;
                if (!fieldType) continue;
                const alias = parseAlias(String(element.right.valueType.value));
                if (!alias) continue;
                const target = await resolve(alias.fileRef, sourceUri).catch(() => undefined);
                if (!target || !isDocumentNode(target)) continue;
                this.put(target.uri, alias.member ?? '', fieldType);
                if (!alias.member && fieldType.kind === 'group' && !seen.has(normalizeUri(target.uri))) {
                    seen.add(normalizeUri(target.uri));
                    await this.walk(target, fieldType.ref, target.uri, resolve, seen, depth + 1);
                }
                continue;
            }
            // `Field { … }` — an inline group that further aliases (e.g. `Game { GameGui = &<…> }`).
            if (isGroupNode(element) && element.identifier) {
                const fieldType = fieldOf(ownerClass, element.identifier.name)?.valueType;
                if (fieldType?.kind === 'group') {
                    await this.walk(element, fieldType.ref, sourceUri, resolve, seen, depth + 1);
                }
            }
        }
    }
}

export const aliasRootIndex = AliasRootIndex.instance;

/**
 * A secondary source of fragment-root types, consulted by {@link aliasedMemberType} when the forward
 * walk from `cosmoteer.rules` doesn't cover a file. The reverse-include index, which roots a fragment by
 * the field that `&<includes>` it, registers itself here, so a `_def.rules` pulled in deep inside an
 * effect file still roots. It is kept as a plain callback so this schema-layer module needs no dependency
 * on the navigation layer that owns the index. This is the same inversion {@link FileRefResolver} uses.
 */
export interface AliasMemberSource {
    /** The schema type aliased onto `member` of the file at `uri`, if this source knows it. */
    memberType(uri: string, member: string): ValueType | undefined;
    /** The schema type the whole file at `uri` was aliased to (member-less), if this source knows it. */
    rootType(uri: string): ValueType | undefined;
    /** The concrete classes of every group that inherits `member` of the file at `uri` as a base, so the
     *  schema layer can root the base to the best-fitting one. Empty when it isn't an inheritance base. */
    inheritanceDeriverClasses?(uri: string, member: string): string[];
}

let aliasFallback: AliasMemberSource | undefined;

/**
 * Registers (or clears) the secondary fragment-root source consulted by {@link aliasedMemberType}.
 *
 * @param source the fallback source to consult after the forward walk, or undefined to clear it.
 */
export const registerAliasFallbackSource = (source: AliasMemberSource | undefined): void => {
    aliasFallback = source;
};

/**
 * The schema type expected at top-level `memberName` of the unrooted document, derived from how the file
 * is aliased into the game root. That is an explicit member alias, or for a whole-file map or group alias
 * the map's value type or the group field's type. The forward alias walk is tried first, then the
 * registered reverse-include fallback, which is the field that `&<includes>` this fragment.
 *
 * @param document the unrooted fragment document.
 * @param memberName the top-level member whose aliased type is wanted.
 * @returns the schema type aliased onto the member, or undefined when the file isn't an aliased fragment.
 */
export const aliasedMemberType = (document: AbstractNodeDocument, memberName: string): ValueType | undefined => {
    const direct =
        aliasRootIndex.memberType(document.uri, memberName) ?? aliasFallback?.memberType(document.uri, memberName);
    if (direct) return direct;
    const root = aliasRootIndex.rootType(document.uri) ?? aliasFallback?.rootType(document.uri);
    if (root?.kind === 'map') return root.value;
    if (root?.kind === 'group') return fieldOf(root.ref, memberName)?.valueType;
    return undefined;
};

/**
 * The concrete classes of every group that inherits `memberName` of `document` as a cross-file base
 * (`Derived : <document>/memberName`), from the registered reverse-include source. The schema layer roots
 * an inheritance-base fragment to whichever of these (or their ancestors) best fits the base's own fields.
 *
 * @param document the base fragment document.
 * @param memberName the base member the derivers inherit.
 * @returns the deriver class FullNames, or an empty array when the file is not a recorded base.
 */
export const inheritanceBaseCandidates = (document: AbstractNodeDocument, memberName: string): string[] =>
    aliasFallback?.inheritanceDeriverClasses?.(document.uri, memberName) ?? [];
