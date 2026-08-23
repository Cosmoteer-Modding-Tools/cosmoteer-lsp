/**
 * Renders the part wiring report: the four checklist rows for the part at a document offset, as
 * markdown both clients already know how to display (VS Code's built-in markdown preview, a
 * read-only in-memory document on JetBrains).
 *
 * This module is the renderer only. Every verdict comes from `part-wiring.probes.ts`, and the whole
 * feature is on demand: it must never be called from validation, from the whole-workspace scan, or
 * per keystroke. One report costs a handful of file reads, which is fine for a click and ruinous for
 * an edit.
 */
import { CancellationToken } from 'vscode-languageserver';
import * as l10n from '@vscode/l10n';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { code } from '../report/markdown-link';
import { locatePartGroup } from './part-grid-data.service';
import {
    PartReferenceSite,
    WiringMark,
    WiringRow,
    fileLink,
    localizationRow,
    modeOfferingsRow,
    paletteRow,
    partIdentityOf,
    partReferenceSites,
    registrationRow,
} from './part-wiring.probes';

/** The glyph each verdict renders as, matching the mod overview's action marks. */
const MARKS: Record<WiringMark, string> = { ok: '✓', missing: '✗', unknown: '·' };

/**
 * Renders the "what does this part still need" markdown report for the part at an offset: whether a
 * ship pulls the file in at all, whether the build palette has anywhere to show it, which techs and
 * modes offer it, and whether its localization keys exist in each language the project ships.
 *
 * @param document the parsed document the request was aimed at.
 * @param offset the request's byte offset, anywhere inside the part group.
 * @param folderPaths the project folders the cross-file searches run over.
 * @param token cancels the searches and the index builds.
 * @returns the markdown text, or undefined when no part encloses the offset.
 */
export const generatePartWiringReport = async (
    document: AbstractNodeDocument,
    offset: number,
    folderPaths: string[],
    token: CancellationToken
): Promise<string | undefined> => {
    const part = locatePartGroup(document, offset);
    if (!part) return undefined;

    const identity = await partIdentityOf(part, token);
    const sites: PartReferenceSite[] = identity.id
        ? await partReferenceSites(identity, document.uri, folderPaths, token)
        : [];

    const rows: WiringRow[] = [
        registrationRow(part, identity),
        await paletteRow(part, sites, folderPaths, token),
        await modeOfferingsRow(sites, folderPaths, token),
        await localizationRow(part, folderPaths, token),
    ];

    const lines: string[] = [];
    const heading = identity.id ?? identity.memberName;
    lines.push(heading ? `# ${l10n.t('Part wiring')} — ${heading}` : `# ${l10n.t('Part wiring')}`);
    lines.push('');
    lines.push(`- **${l10n.t('File')}**: ${fileLink(document.uri)}`);
    if (identity.aliases.length > 0) {
        lines.push(`- **${l10n.t('Also known as')}**: ${identity.aliases.map(code).join(', ')}`);
    }
    lines.push('');
    lines.push(
        l10n.t(
            'Every row answers one thing the game needs before this part can be built. ✓ the wiring is there, ✗ it is missing, · it cannot be judged from what is indexed.'
        )
    );
    lines.push('');
    for (const row of rows) {
        lines.push(`## ${MARKS[row.mark]} ${row.title}`);
        lines.push('');
        for (const finding of row.findings) lines.push(`- ${finding}`);
        lines.push('');
    }
    return lines.join('\n');
};
