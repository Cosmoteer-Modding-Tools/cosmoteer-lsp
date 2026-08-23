import { createHash } from 'crypto';
import { dirname, relative, resolve } from 'path';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode } from '../../../core/ast/ast';
import { CosmoteerWorkspaceService } from '../../../workspace/cosmoteer-workspace.service';
import { cachedPathExists, onFsInvalidation } from '../../../workspace/fs-cache';
import { collectBaseUses, resolveBasePath } from './base-index';
import { extractableMembers, ExtractableMember, judgeContainer } from './extractability';
import { commentRanges } from './member-record';
import { BaseLocation, ExtractionPlan, ExtractionTier, MemberRecord, Participant } from './plan.types';

/** How many containers must repeat a field set before extracting it is worth a base file. */
const MIN_PARTICIPANTS = 3;

/** How many fields must move together, so a base file is never created for a single value. */
export const MIN_FIELDS = 2;

/**
 * How deep a named group may sit and still be extracted. One is a file's own root group (`Part`),
 * the shape every hand-written base file in the game and its mods uses, and two is a named group
 * directly inside it. Deeper groups are left alone: their duplication is nearly always a consequence
 * of their parent's, and a base file per nesting level is not what an author wants.
 */
const MAX_CONTAINER_DEPTH = 2;

/** One file handed to the analysis, parsed once by the caller. */
export interface AnalysisFile {
    document: AbstractNodeDocument;
    text: string;
    /** The file's on-disk path in its real spelling. */
    fsPath: string;
    /** The file's canonical uri, the key an edit for it is published under. */
    uri: string;
}

/** Everything the analysis needs that is not a file. */
interface AnalysisOptions {
    /** The directory every fingerprint is expressed relative to, in practice the mod root. */
    anchorDir?: string;
    minParticipants?: number;
    minFields?: number;
}

/** A container the analysis accepted, with its members already judged. Holds no AST. */
export interface Candidate {
    participant: Participant;
    members: ExtractableMember[];
    /** The absolute identity of the container's own base, absent when it inherits nothing. */
    baseIdentity?: string;
    /** The base reference as written, kept so the generated base file can carry it over. */
    baseReference?: string;
}

/**
 * The absolute identity of an inheritance reference, so the same base written from two directories
 * compares equal. Only a `<file path>` base has one: every other form resolves against the node it
 * is written on, which a base file cannot reproduce.
 *
 * @param reference the inheritance reference's text.
 * @param declaringDir the directory of the file the reference is written in.
 * @returns the case-folded absolute target and member suffix, or undefined when the form is not one
 * a base file could carry over.
 */
export const baseIdentityOf = (reference: string, declaringDir: string): string | undefined => {
    const key = `${declaringDir}\u0000${reference}`;
    if (identityCache.has(key)) return identityCache.get(key);
    const identity = computeBaseIdentity(reference, declaringDir);
    // Until the workspace knows where the game is, a `<./…>` path cannot be resolved to the file it
    // names, and pinning that unresolved answer would outlive the initialization that fixes it.
    if (CosmoteerWorkspaceService.instance.dataRootPath) {
        if (identityCache.size >= MAX_IDENTITY_ENTRIES) identityCache.clear();
        identityCache.set(key, identity);
    }
    return identity;
};

/**
 * Identities by directory and reference text, because the identity costs a filesystem probe and a
 * mod writes the same base reference in every file of a folder. Every container of every file is
 * asked for one, so without the memo one whole-mod pass probes the disk once per inheritance
 * reference in the mod.
 */
const identityCache = new Map<string, string | undefined>();

/** How many identities are kept, comfortably more distinct base references than a mod writes. */
const MAX_IDENTITY_ENTRIES = 20000;

onFsInvalidation(() => identityCache.clear());

/** The uncached half of {@link baseIdentityOf}. */
const computeBaseIdentity = (reference: string, declaringDir: string): string | undefined => {
    const match = /^\s*&?\s*<([^<>]+)>(.*)$/.exec(reference);
    if (!match) return undefined;
    const suffix = match[2].trim();
    if (/[~^:]/.test(suffix)) return undefined;
    const path = match[1].trim();
    // A `<./…>` path is read from the install root rather than from here, so it is resolved to the
    // same absolute form every other reference gets. One file must have one identity however it was
    // spelled: the safety proof for adding to a base counts its inheritors per identity, and a base
    // reached under two spellings would be counted twice at half strength. The unresolved form is
    // still the answer when the file cannot be found, so a broken reference keeps its container.
    if (/^\.[\\/]/.test(path)) {
        const inGame = resolveBasePath(path, declaringDir);
        if (inGame && cachedPathExists(inGame)) {
            return `${inGame.replace(/\\/g, '/').toLowerCase()}|${suffix.toLowerCase()}`;
        }
        return `game:${path.toLowerCase()}|${suffix.toLowerCase()}`;
    }
    const target = resolve(declaringDir, path);
    if (!cachedPathExists(target)) return undefined;
    return `${target.replace(/\\/g, '/').toLowerCase()}|${suffix.toLowerCase()}`;
};

/** The named groups of a document that are shallow enough to extract. */
const containersOf = (document: AbstractNodeDocument): GroupNode[] => {
    const out: GroupNode[] = [];
    const walk = (elements: readonly AbstractNode[], depth: number): void => {
        if (depth > MAX_CONTAINER_DEPTH) return;
        for (const element of elements) {
            if (!isGroupNode(element) || !element.identifier) continue;
            out.push(element);
            walk(element.elements, depth + 1);
        }
    };
    walk(document.elements, 1);
    return out;
};

/**
 * Turn one file into the containers worth grouping: every named group shallow enough to extract
 * whose class resolves and which still carries enough movable members to be worth a base file.
 *
 * The result holds no AST, so a caller may cache it for as long as the file is unchanged without
 * keeping the parsed document alive.
 *
 * @param file the parsed file to scan.
 * @param anchorDir the directory fingerprints are expressed relative to.
 * @param minFields the smallest movable member count a container is kept for.
 * @returns the accepted containers.
 */
export const candidatesInFile = (file: AnalysisFile, anchorDir: string, minFields: number): Candidate[] => {
    const candidates: Candidate[] = [];
    const declaringDir = dirname(file.fsPath);
    // Scanned on the first accepted container and reused by the rest, so a file whose containers are
    // all refused is never scanned at all.
    let comments: ReadonlyArray<{ start: number; end: number }> | undefined;
    for (const container of containersOf(file.document)) {
        const facts = judgeContainer(container, file.text);
        if (typeof facts === 'string') continue;
        comments ??= commentRanges(file.text);
        const members = extractableMembers(facts, file.document, file.text, declaringDir, anchorDir, comments);
        if (members.length < minFields) continue;
        const baseReference = facts.inheritance ? String(facts.inheritance.valueType.value) : undefined;
        const baseIdentity = baseReference ? baseIdentityOf(baseReference, declaringDir) : undefined;
        // A base the analysis cannot pin to one file cannot be carried over, so the container is
        // dropped rather than silently losing what that base supplied.
        if (baseReference && !baseIdentity) continue;
        const memberMap = new Map<string, MemberRecord>();
        for (const member of members) memberMap.set(member.key, member);
        candidates.push({
            participant: {
                uri: file.uri,
                fsPath: file.fsPath,
                className: facts.className,
                groupName: container.identifier?.name ?? facts.className,
                nameStart: facts.start,
                nameEnd: container.identifier?.position.end ?? facts.start,
                inheritanceRef: baseReference,
                inheritanceStart: facts.inheritance?.position.start,
                inheritanceEnd: facts.inheritance?.position.end,
                members: memberMap,
            },
            members,
            baseIdentity,
            baseReference,
        });
    }
    return candidates;
};

/** What one file contributes to a mod-wide analysis, holding no AST so it can be cached. */
export interface FileFacts {
    /** The file's containers that could take part in an extraction. */
    candidates: Candidate[];
    /**
     * One entry per inheritance reference in the file naming another file's group, at any depth and
     * whether or not the container could take part. Counting them across the mod is what proves that
     * adding a field to an existing base file hands it to nobody new.
     */
    baseIdentities: string[];
    /** Where each distinct base above lives, so it can be read and edited. */
    baseLocations: Map<string, BaseLocation>;
}

/**
 * Everything one file contributes to the mod-wide analysis, read in a single pass over it.
 *
 * @param file the parsed file to scan.
 * @param anchorDir the directory fingerprints are expressed relative to.
 * @param minFields the smallest movable member count a container is kept for.
 * @returns the file's candidates and the bases it inherits.
 */
export const fileFactsFrom = (file: AnalysisFile, anchorDir: string, minFields: number): FileFacts => {
    const uses = collectBaseUses(file.document, dirname(file.fsPath), baseIdentityOf);
    return {
        candidates: candidatesInFile(file, anchorDir, minFields),
        baseIdentities: uses.identities,
        baseLocations: uses.locations,
    };
};

/** The deepest directory every path lives under. */
const commonAncestorDir = (paths: readonly string[]): string => {
    const parts = paths.map((path) => dirname(path).replace(/\\/g, '/').split('/'));
    const first = parts[0] ?? [];
    let shared = first.length;
    for (const other of parts.slice(1)) {
        let i = 0;
        while (i < shared && i < other.length && first[i].toLowerCase() === other[i].toLowerCase()) i++;
        shared = i;
    }
    return first.slice(0, shared).join('/');
};

/**
 * The file name for a generated base, following the convention the game's own data and its mods
 * use: `base_` plus what the participating files have in common, falling back to the group's name.
 *
 * @param paths the participating files' paths.
 * @param groupName the name of the group being extracted.
 * @param className the schema class the group resolves to, the last resort when the group's own name
 * says nothing (a map entry named `1`, say).
 * @returns the base file's name, without a directory.
 */
export const baseFileNameFor = (paths: readonly string[], groupName: string, className = ''): string => {
    const names = paths.map((path) => (path.split(/[\\/]/).pop() ?? '').replace(/\.rules$/i, '').toLowerCase());
    let prefix = names[0] ?? '';
    for (const name of names.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
        prefix = prefix.slice(0, i);
    }
    prefix = prefix.replace(/[^a-z0-9]+$/, '');
    const readable = (candidate: string): string | undefined =>
        /^[a-z][a-z0-9_]{2,}$/.test(candidate) ? candidate : undefined;
    const fromClass = (className.split('.').pop() ?? '').replace(/(Rules|Def)$/, '').toLowerCase();
    const stem = readable(prefix) ?? readable(groupName.toLowerCase()) ?? readable(fromClass) ?? 'shared';
    return `base_${stem}.rules`;
};

/** A stable identity for a plan, so it survives the round trip to the client and back. */
const planIdOf = (participants: readonly Participant[], fields: readonly string[]): string => {
    const hash = createHash('sha1');
    for (const key of participants
        .map((participant) => `${participant.uri.toLowerCase()}#${participant.nameStart}`)
        .sort())
        hash.update(`${key}\u0000`);
    for (const field of [...fields].sort()) hash.update(`${field}\u0000`);
    return hash.digest('hex').slice(0, 16);
};

/**
 * Find every set of containers that repeat the same fields verbatim and could share a base file
 * instead.
 *
 * Fields are bucketed by the exact set of containers carrying them, never by a majority: a field
 * only some of a group declare cannot move into a base all of them inherit, because the rest would
 * silently gain it. That makes every plan behaviour-preserving by construction, at the cost of
 * splitting one near-duplicate family into several plans, the largest of which is the one offered.
 *
 * @param candidates the accepted containers, from {@link candidatesInFile}, across every file the
 * caller wants compared. Already narrowed to one mod by the caller.
 * @param options the thresholds.
 * @returns the plans, largest saving first.
 */
export const plansFromCandidates = (
    candidates: readonly Candidate[],
    options: Pick<AnalysisOptions, 'minParticipants' | 'minFields'> = {}
): ExtractionPlan[] => {
    const minParticipants = options.minParticipants ?? MIN_PARTICIPANTS;
    const minFields = options.minFields ?? MIN_FIELDS;
    if (candidates.length < minParticipants) return [];

    // Group by schema class first: two containers only share a base if the base's own class can
    // declare every field both of them move into it.
    const byClass = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
        const list = byClass.get(candidate.participant.className);
        if (list) list.push(candidate);
        else byClass.set(candidate.participant.className, [candidate]);
    }

    const plans: ExtractionPlan[] = [];
    for (const [className, group] of byClass) {
        if (group.length < minParticipants) continue;
        // A field is identified by its name and its exact normalized value, so only containers that
        // say precisely the same thing are ever grouped.
        const carriers = new Map<string, number[]>();
        group.forEach((candidate, index) => {
            for (const member of candidate.members) {
                const fieldKey = `${member.key}\u0000${member.norm}`;
                const list = carriers.get(fieldKey);
                if (list) list.push(index);
                else carriers.set(fieldKey, [index]);
            }
        });
        // Bucket the fields by the identical set of containers that carry them.
        const buckets = new Map<string, { indices: number[]; fields: string[] }>();
        for (const [fieldKey, indices] of carriers) {
            if (indices.length < minParticipants) continue;
            const signature = indices.join(',');
            const bucket = buckets.get(signature);
            if (bucket) bucket.fields.push(fieldKey);
            else buckets.set(signature, { indices, fields: [fieldKey] });
        }
        for (const bucket of buckets.values()) {
            if (bucket.fields.length < minFields) continue;
            const members = bucket.indices.map((index) => group[index]);
            const tier = tierOf(members);
            if (!tier) continue;
            const plan = planFor(className, members, bucket.fields, tier);
            if (plan) plans.push(plan);
        }
    }
    return plans.sort((a, b) => b.savedBytes - a.savedBytes);
};

/**
 * The tier a set of containers forms, or undefined when they cannot share one base: either none of
 * them inherits anything, or all of them inherit the very same base, which the generated file then
 * carries over on their behalf.
 *
 * @param candidates the containers that would share the base.
 * @returns the tier, or undefined when their bases disagree.
 */
const tierOf = (candidates: readonly Candidate[]): ExtractionTier | undefined => {
    const identities = new Set(candidates.map((candidate) => candidate.baseIdentity ?? ''));
    if (identities.size !== 1) return undefined;
    return identities.has('') ? 'cloneFamily' : 'sharedBase';
};

/**
 * Assemble one plan: pick the donor whose spelling the base file receives, work out where the base
 * file goes, and re-express the inherited base reference relative to it.
 *
 * @param className the schema class every participant resolves to.
 * @param candidates the participating containers.
 * @param fieldKeys the name-and-value keys of the fields that move.
 * @param tier which duplication this is.
 * @returns the plan, or undefined when the base reference cannot be re-expressed.
 */
const planFor = (
    className: string,
    candidates: readonly Candidate[],
    fieldKeys: readonly string[],
    tier: ExtractionTier
): ExtractionPlan | undefined => {
    const keys = fieldKeys.map((fieldKey) => fieldKey.slice(0, fieldKey.indexOf('\u0000')));
    // The donor is the participant whose path sorts first, so the same input always produces the
    // same base file, which the tests and the plan id both depend on.
    const ordered = [...candidates].sort((a, b) =>
        a.participant.fsPath.toLowerCase() < b.participant.fsPath.toLowerCase() ? -1 : 1
    );
    const donor = ordered[0];
    const participants = ordered.map((candidate) => candidate.participant);
    const paths = participants.map((participant) => participant.fsPath);
    const baseDir = commonAncestorDir(paths);
    if (!baseDir) return undefined;
    const baseFsPath = `${baseDir}/${baseFileNameFor(paths, donor.participant.groupName, className)}`;

    let inheritedRef: string | undefined;
    if (tier === 'sharedBase') {
        inheritedRef = rebaseInheritance(donor.baseReference ?? '', dirname(donor.participant.fsPath), baseDir);
        if (!inheritedRef) return undefined;
    }
    // Fields keep the donor's document order, so the base file reads like the file it came from.
    const ordering = new Map(donor.members.map((member, index) => [member.key, index]));
    const fields = [...keys].sort((a, b) => (ordering.get(a) ?? 0) - (ordering.get(b) ?? 0));
    const savedBytes = participants.reduce(
        (total, participant) =>
            total + fields.reduce((sum, key) => sum + (participant.members.get(key)?.raw.length ?? 0), 0),
        0
    );
    return {
        id: planIdOf(participants, fields),
        tier,
        className,
        groupName: donor.participant.groupName,
        fields,
        participants,
        donor: donor.participant,
        baseFsPath,
        inheritedRef,
        baseIdentity: donor.baseIdentity,
        savedBytes,
    };
};

/**
 * Re-express an inheritance reference so it means the same thing written in the base file.
 *
 * @param reference the reference as the donor writes it.
 * @param declaringDir the donor's directory.
 * @param baseDir the directory the base file will live in.
 * @returns the rewritten reference, or undefined when it is not a form that can be moved.
 */
export const rebaseInheritance = (
    reference: string,
    declaringDir: string,
    baseDir: string
): string | undefined => {
    const match = /^\s*&?\s*<([^<>]+)>(.*)$/.exec(reference);
    if (!match) return undefined;
    const path = match[1].trim();
    const suffix = match[2].trim();
    if (/^\.[\\/]/.test(path)) return `<${path}>${suffix}`;
    const target = resolve(declaringDir, path);
    const rebased = relative(baseDir, target).replace(/\\/g, '/');
    if (rebased.length === 0) return undefined;
    return `<${rebased}>${suffix}`;
};

/**
 * Run the whole analysis over a set of already-parsed files.
 *
 * @param files the parsed files to compare, already narrowed to one mod by the caller.
 * @param options the anchor directory and the thresholds.
 * @returns the plans, largest saving first.
 */
export const buildExtractionPlans = (files: readonly AnalysisFile[], options: AnalysisOptions = {}): ExtractionPlan[] => {
    const anchorDir = options.anchorDir ?? '';
    const minFields = options.minFields ?? MIN_FIELDS;
    const candidates = files.flatMap((file) => candidatesInFile(file, anchorDir, minFields));
    return plansFromCandidates(candidates, options);
};
