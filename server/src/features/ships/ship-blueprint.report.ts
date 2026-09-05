import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { ValueNode } from '../../core/ast/ast';
import { PART_RULES_CLASS } from '../part-editor/part-fields';
import { IdReferenceJudgment, judgeIdReference } from '../diagnostics/validator.schema-id-reference';
import { code, tableCell } from '../report/markdown-link';
import { readShipBlueprint } from './ship-blueprint';

/**
 * The "what does this blueprint place" report for a `.ship.png`.
 *
 * A saved ship is a picture with the ship hidden in it, so the parts it places were unreadable
 * without loading it in game. The list matters to a mod author for one reason: a blueprint naming a
 * part the mod renamed or removed still loads, with that part missing, and nothing says so.
 *
 * The verdict per id is the one the reference validator itself uses, escape hatches and all, so a
 * part a dependency mod declares is not reported as missing here while being accepted everywhere
 * else in the editor.
 */

/** The sentence each verdict is rendered as. */
const VERDICTS: Readonly<Record<IdReferenceJudgment, () => string>> = {
    resolved: () => l10n.t('found'),
    'no-coverage': () => l10n.t('nothing here declares parts, so this is not judged'),
    'label-field': () => l10n.t('not judged'),
    'declared-loosely': () => l10n.t('declared somewhere the harvest cannot classify'),
    'vanilla-leftover': () => l10n.t("declared by the game's own files"),
    'dependency-declared': () => l10n.t('declared by an installed mod'),
    unresolved: () => l10n.t('**nothing declares this part**'),
};

/**
 * A value node standing for an id the blueprint holds, so the shared verdict can be asked for one.
 * A blueprint is not a `.rules` file and has no tree of its own, and the judgment reads the id and
 * its class and nothing else about where it was written.
 *
 * @param value the part id.
 * @returns the stand-in node.
 */
const syntheticNode = (value: string): ValueNode => ({
    type: 'Value',
    valueType: { type: 'String', value },
    position: { line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 },
});

/**
 * Renders what a `.ship.png` places.
 *
 * @param path the blueprint file.
 * @param folderPaths the project folders the part-id index is built from.
 * @param token cancels the id index build and the consults.
 * @returns the markdown report, or undefined when the file is not a blueprint this can read.
 */
export const generateShipBlueprintReport = async (
    path: string,
    folderPaths: string[],
    token: CancellationToken
): Promise<string | undefined> => {
    const blueprint = await readShipBlueprint(path);
    if (!blueprint) return undefined;

    const counts = new Map<string, number>();
    for (const part of blueprint.parts) counts.set(part.id, (counts.get(part.id) ?? 0) + 1);

    const idsByClass = new Map<string, Set<string>>();
    const rows: Array<{ id: string; count: number; verdict: IdReferenceJudgment }> = [];
    for (const [id, count] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
        if (token.isCancellationRequested) return undefined;
        const verdict = await judgeIdReference(
            { node: syntheticNode(id), targetClass: PART_RULES_CLASS, value: id },
            folderPaths,
            idsByClass,
            token
        ).catch((): IdReferenceJudgment => 'no-coverage');
        rows.push({ id, count, verdict });
    }
    const missing = rows.filter((row) => row.verdict === 'unresolved');

    const xs = blueprint.parts.map((part) => part.x);
    const ys = blueprint.parts.map((part) => part.y);
    const width = xs.length > 0 ? Math.max(...xs) - Math.min(...xs) + 1 : 0;
    const height = ys.length > 0 ? Math.max(...ys) - Math.min(...ys) + 1 : 0;

    const lines: string[] = [];
    lines.push(`# ${blueprint.name ?? l10n.t('Ship blueprint')}`);
    lines.push('');
    if (blueprint.author) lines.push(`- **${l10n.t('Author')}**: ${blueprint.author}`);
    lines.push(`- **${l10n.t('Parts')}**: ${blueprint.parts.length}`);
    lines.push(`- **${l10n.t('Different parts')}**: ${counts.size}`);
    lines.push(`- **${l10n.t('Size')}**: ${width} × ${height}`);
    lines.push(`- **${l10n.t('Doors')}**: ${blueprint.doors}`);
    lines.push(`- **${l10n.t('Decals')}**: ${blueprint.decals}`);
    lines.push('');
    if (blueprint.description) {
        lines.push(`> ${blueprint.description.replace(/\r?\n/g, ' ')}`);
        lines.push('');
    }

    if (missing.length > 0) {
        lines.push(
            l10n.t(
                'This blueprint places {0} parts nothing in the project declares. The game loads such a ship with those parts missing and says nothing.',
                String(missing.reduce((sum, row) => sum + row.count, 0))
            )
        );
        lines.push('');
    }

    lines.push(`## ${l10n.t('Parts it places')}`);
    lines.push('');
    lines.push(`| ${l10n.t('Part')} | ${l10n.t('Count')} | ${l10n.t('Verdict')} |`);
    lines.push('| --- | --- | --- |');
    for (const row of rows) {
        lines.push(`| ${tableCell(code(row.id))} | ${row.count} | ${tableCell(VERDICTS[row.verdict]())} |`);
    }
    lines.push('');
    lines.push(
        l10n.t(
            'The blueprint is read out of the low bits of the picture, in the format the game writes today. A game update can change that format, and this report says it cannot read the file rather than guessing when it does.'
        )
    );
    return lines.join('\n');
};
