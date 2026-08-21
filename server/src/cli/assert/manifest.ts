import { basename } from 'path';
import { AbstractNode, isListNode, isValueNode } from '../../core/ast/ast';
import { namedMembersOf } from '../../utils/ast.utils';
import { DocumentCache, ParsedFile, positionOf } from './documents';
import { ManifestFailure } from './model';

// The manifest half of the load check. `Cosmoteer.Mods.ModInfo` decides two things before any
// action runs: which `mod.rules` of the folder the game reads, and whether that file carries the
// metadata the mod cannot load without. Both are reproduced here from the loader itself, because
// both are ways for a mod to fail to load that have nothing to do with its actions.

/** One candidate manifest, with the fields the game's own choice reads. */
export interface ManifestCandidate {
    file: string;
    parsed: ParsedFile;
    id?: string;
    name?: string;
    /** Whether the file declares `CompatibleGameVersions`, which decides the choice by game version. */
    declaresVersions: boolean;
    useThisFileIfNoVersionMatch: boolean;
}

/** Which manifest the game reads, and what stands in the way of saying so. */
export interface ManifestChoice {
    candidates: ManifestCandidate[];
    /** The manifests the game may read. One when the choice is certain, several when it is not. */
    selected: ManifestCandidate[];
    /** The ones the game can never read, each with the reason. */
    rejected: { candidate: ManifestCandidate; reason: string }[];
    /** True when the mod ships several manifests and the running game version picks between them. */
    undecided: boolean;
}

/**
 * Read the fields the game's manifest choice and its metadata check need.
 *
 * @param parsed the parsed manifest.
 * @returns the candidate.
 */
export const readCandidate = (parsed: ParsedFile): ManifestCandidate => {
    const members = topLevelMembers(parsed);
    const compatible = members.get('compatiblegameversions');
    return {
        file: parsed.file,
        parsed,
        id: stringValue(members.get('id')),
        name: stringValue(members.get('name')),
        declaresVersions: compatible !== undefined && isListNode(compatible),
        useThisFileIfNoVersionMatch: stringValue(members.get('usethisfileifnoversionmatch'))?.toLowerCase() === 'true',
    };
};

/**
 * Decide which manifest the game reads.
 *
 * With one candidate the game uses it without looking at anything in it. With several it scores
 * them and takes the highest, and a candidate missing `ID` or `Name` scores nothing at all and can
 * never win. The rest of the score is the running game version against `CompatibleGameVersions`,
 * which a command line cannot know, so a mod that ships version-split manifests is reported as
 * undecided instead of guessed at, and every candidate is checked.
 *
 * @param candidates every manifest found under the mod folder.
 * @returns the choice, with the candidates that can never be read named separately.
 */
export const chooseManifest = (candidates: ManifestCandidate[]): ManifestChoice => {
    if (candidates.length <= 1) {
        return { candidates, selected: candidates, rejected: [], undecided: false };
    }
    const rejected: { candidate: ManifestCandidate; reason: string }[] = [];
    const eligible: ManifestCandidate[] = [];
    for (const candidate of candidates) {
        if (candidate.id === undefined || candidate.name === undefined) {
            rejected.push({
                candidate,
                reason: 'it declares no ID or no Name, and the game never picks such a manifest when a mod ships several',
            });
        } else if (!candidate.declaresVersions && basename(candidate.file).toLowerCase() !== 'mod.rules') {
            rejected.push({
                candidate,
                reason: 'it is not named mod.rules and declares no CompatibleGameVersions, so the game scores it as unusable',
            });
        } else {
            eligible.push(candidate);
        }
    }
    return {
        candidates,
        selected: eligible,
        rejected,
        undecided: eligible.length > 1,
    };
};

/**
 * The metadata failures that stop the game loading a mod, straight out of the `ModInfo`
 * constructor: `ID` and `Name` are both required, and an `ID` needs a name on each side of a dot.
 *
 * @param candidate the manifest to check.
 * @param path the manifest's path relative to the mod folder, for the report.
 * @returns one failure per rule the manifest breaks, empty when it carries all three.
 */
export const metadataFailures = (candidate: ManifestCandidate, path: string): ManifestFailure[] => {
    const failures: ManifestFailure[] = [];
    const members = topLevelMembers(candidate.parsed);
    if (candidate.id === undefined) {
        failures.push({
            subject: 'ID',
            path,
            detail: 'The manifest declares no ID. The game cannot read it and starts without this mod.',
            ...positionOfMember(candidate.parsed, members.get('id')),
        });
    } else {
        const dot = candidate.id.indexOf('.');
        if (dot < 1 || dot >= candidate.id.length - 1) {
            failures.push({
                subject: 'ID',
                path,
                detail: `The ID "${candidate.id}" needs a name on each side of a dot, as in author_name.mod_name. The game refuses it and starts without this mod.`,
                ...positionOfMember(candidate.parsed, members.get('id')),
            });
        }
    }
    if (candidate.name === undefined) {
        failures.push({
            subject: 'Name',
            path,
            detail: 'The manifest declares no Name. The game cannot read it and starts without this mod.',
            ...positionOfMember(candidate.parsed, members.get('name')),
        });
    }
    return failures;
};

/**
 * Read one manifest for every candidate file.
 *
 * @param files the manifest paths found under the mod folder.
 * @param cache the shared reader.
 * @returns the candidates that could be parsed, in the order the files were given.
 */
export const readCandidates = async (files: readonly string[], cache: DocumentCache): Promise<ManifestCandidate[]> => {
    const candidates: ManifestCandidate[] = [];
    for (const file of files) {
        const parsed = await cache.get(file);
        if (parsed) candidates.push(readCandidate(parsed));
    }
    return candidates;
};

/**
 * The top-level members of a document, keyed by their lower-cased name. The game looks members up
 * without regard to case, so the check has to as well.
 *
 * @param parsed the parsed file.
 * @returns the members, with the last spelling of a repeated name winning as the game's own tree
 *     does.
 */
const topLevelMembers = (parsed: ParsedFile): Map<string, AbstractNode> => {
    const members = new Map<string, AbstractNode>();
    for (const [name, node] of namedMembersOf(parsed.document)) members.set(name.toLowerCase(), node);
    return members;
};

/**
 * The text of a member that holds a plain value.
 *
 * @param node the member node, when the manifest has one.
 * @returns the value as written, or undefined when the member is missing or holds no value.
 */
const stringValue = (node: AbstractNode | undefined): string | undefined => {
    if (!node || !isValueNode(node)) return undefined;
    return String(node.valueType.value);
};

/**
 * Where to point a metadata failure. A missing field has no node of its own, so it is reported at
 * the top of the file, which is where it has to be written.
 *
 * @param parsed the parsed manifest.
 * @param node the member node, when there is one.
 * @returns the one-based line and column.
 */
const positionOfMember = (parsed: ParsedFile, node: AbstractNode | undefined): { line: number; column: number } =>
    node ? positionOf(parsed.lineStarts, node.position.start) : { line: 1, column: 1 };
