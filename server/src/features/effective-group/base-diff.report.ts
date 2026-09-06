import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { findEnclosingGroup } from '../../document/schema/schema-context';
import { flattenGroup } from '../../semantics/effective-group';
import { EffectiveMemberEntry, MemberOrigin } from '../../semantics/effective-group.types';
import { declarationsMatch } from '../../semantics/member-diff';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { navigationDepKey } from '../../utils/navigation-deps';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { code, tableCell } from '../report/markdown-link';
import { nearestGroup, pathOf } from './effective-group.report';
import { placeLink, valueText } from '../report/report-values';

/**
 * The "what does this group change from the version the game ships" report.
 *
 * A mod part usually derives from a game part and rewrites a handful of its fields. Reading which
 * ones meant opening the base by hand and comparing it field by field, and after a game update the
 * same reading had to be done again to find out whether the base had moved underneath. This puts the
 * two side by side for the group under the cursor.
 *
 * It answers only for a group that reaches the game's own tree through its inheritance chain, since
 * that chain is what makes the two comparable. A mod that copies a game file wholesale and edits the
 * copy has no chain to follow, and guessing at one by file name would be a different feature with a
 * far weaker claim to being right.
 *
 * A member the group leaves to its base is left out. It is not a difference, and listing every
 * inherited field would bury the handful of rows the report exists for.
 */

/** One member the group loads differently from the base it derives from. */
interface BaseDiffRow {
    readonly name: string;
    /** The declaration the game's own file supplies, null where the group writes a new name. */
    readonly theirs: AbstractNode | null;
    /** The declaration this chain loads instead. */
    readonly mine: AbstractNode | null;
    /** Where the winning declaration is written. */
    readonly origin: MemberOrigin;
}

/**
 * Whether a file is one of the game's own, so a declaration in it is what the game ships rather than
 * what a mod writes over it.
 *
 * @param uri the file's uri or path, in either of the two shapes the walk produces.
 * @param dataRootKey the canonical key of the game `Data` folder.
 * @returns true when the file sits inside the game's `Data` folder.
 */
const isGameFile = (uri: string, dataRootKey: string): boolean =>
    (navigationDepKey(uri) + '/').startsWith(dataRootKey + '/');

/**
 * The container a report is about.
 *
 * @param document the parsed document.
 * @param offset the caret's byte offset.
 * @returns the group under the cursor, or the document root when the caret is outside every group.
 */
const containerAt = (document: AbstractNodeDocument, offset: number): GroupNode | ListNode | AbstractNodeDocument => {
    const group = findEnclosingGroup(document, offset);
    return group && (isGroupNode(group) || isListNode(group)) ? group : document;
};

/**
 * The rows two flattened member sets differ by, from the deriving side's point of view.
 *
 * @param mine the flattened members of the group under the cursor.
 * @param theirs the flattened members of the game's own base.
 * @param dataRootKey the canonical key of the game `Data` folder.
 * @returns one row per member this chain loads differently.
 */
const diffRows = (
    mine: readonly EffectiveMemberEntry[],
    theirs: readonly EffectiveMemberEntry[],
    dataRootKey: string
): BaseDiffRow[] => {
    const byName = new Map<string, EffectiveMemberEntry>();
    for (const member of theirs) byName.set(member.name.toLowerCase(), member);
    const rows: BaseDiffRow[] = [];
    for (const member of mine) {
        // A member whose winning declaration is the game's own is one this chain leaves alone, which
        // is not a difference however far down the chain it was found.
        if (isGameFile(member.origin.uri, dataRootKey)) continue;
        const other = byName.get(member.name.toLowerCase());
        if (other && declarationsMatch(other.value, member.value)) continue;
        rows.push({ name: member.name, theirs: other?.value ?? null, mine: member.value, origin: member.origin });
    }
    return rows;
};

/**
 * One row of the comparison table.
 *
 * @param row the row.
 * @returns the markdown row.
 */
const tableRow = (row: BaseDiffRow): string => {
    const verdict = row.theirs === null ? l10n.t('written only here') : l10n.t('changed');
    const theirs = row.theirs === null ? l10n.t('*(not written)*') : valueText(row.theirs);
    return `| ${tableCell(code(row.name))} | ${tableCell(theirs)} | ${tableCell(valueText(row.mine))} | ${verdict} | ${placeLink(row.origin)} |`;
};

/**
 * Renders the group-against-its-game-base comparison for the container at an offset.
 *
 * @param document the parsed document.
 * @param offset the caret's byte offset.
 * @param token cancels the two cross-file folds.
 * @returns the markdown report, or null when the caret sits in nothing that derives from the game.
 */
export const generateBaseDiffReport = async (
    document: AbstractNodeDocument,
    offset: number,
    token: CancellationToken
): Promise<string | null> => {
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return null;
    const dataRootKey = navigationDepKey(dataRoot);

    const container = containerAt(document, offset);
    const group = isListNode(container) ? nearestGroup(container) : container;
    if (!group) return null;
    if (isGameFile(getStartOfAstNode(group).uri, dataRootKey)) return null;

    const mine = await flattenGroup(group, token);
    // The nearest hop of the chain that lives in the game's own tree is the version this group is
    // written against, and everything above it is folded into that hop's own answer anyway.
    const base = mine.bases.find((hop) => isGameFile(hop.uri, dataRootKey));
    if (!base) return null;
    const baseNode = base.node;
    if (!isGroupNode(baseNode) && !isListNode(baseNode) && !isDocumentNode(baseNode)) return null;
    const theirs = await flattenGroup(baseNode, token);

    const rows = diffRows(mine.members, theirs.members, dataRootKey);
    const lines: string[] = [];
    lines.push(`# ${l10n.t('What {0} changes from the game', code(pathOf(group)))}`);
    lines.push('');
    lines.push(l10n.t('Compared against {0}, the nearest base of this group the game ships itself.', placeLink(base)));
    lines.push('');
    if (!mine.complete || !theirs.complete) {
        lines.push(
            `> ⚠ ${l10n.t('One of the two chains could not be read in full, so a member a missing base supplies is absent from the table below.')}`
        );
        lines.push('');
    }
    if (rows.length === 0) {
        lines.push(l10n.t('This group loads every member the way the game writes it, so it changes nothing.'));
        return lines.join('\n');
    }
    lines.push(
        l10n.t(
            'A member this group leaves to its base is left out. Only what the game loads differently here is listed.'
        )
    );
    lines.push('');
    lines.push(
        `| ${l10n.t('Member')} | ${l10n.t('The game writes')} | ${l10n.t('Loaded here')} | ${l10n.t('Verdict')} | ${l10n.t('Written in')} |`
    );
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of rows) lines.push(tableRow(row));
    return lines.join('\n');
};
