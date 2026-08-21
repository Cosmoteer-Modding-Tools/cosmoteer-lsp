import { plural, gamePathOrigin } from '../report/report';
import { TOOL_NAME, toolVersion } from '../version';
import { folderName } from './assert';
import { ActionVerdict, AssertReport, Disclosure, ManifestFailure, ModAssertion, REASON_TITLES } from './model';

// The two ways the load check is read: by a person looking at a build log, and by a script. Both
// say the same things in the same order, and both always carry the block naming what the check
// could not see, even when it is empty, because a reader has to be able to tell "nothing was left
// unchecked" from "the report does not mention it".

/** The word each verdict is written with. Plain words rather than symbols, so a build log on any
 *  machine shows them the same way. */
const MARK_WORDS: Readonly<Record<ActionVerdict['mark'], string>> = {
    ok: 'loads',
    failed: 'fails',
    unverifiable: 'unknown',
};

/** How many entries of one kind are listed before the rest are counted. */
const LIST_LIMIT = 5;

/** How wide a wrapped sentence is allowed to get. */
const WRAP_WIDTH = 96;

/**
 * The report a person reads.
 *
 * @param report the finished report.
 * @returns the whole text, ending in a newline.
 */
export const assertTextReport = (report: AssertReport): string => {
    const lines: string[] = [`${TOOL_NAME} ${toolVersion()}`, '', 'Does the game load this mod?', ''];
    lines.push(`Folders    ${report.folders.join('\n           ')}`);
    lines.push(
        report.gameData.available
            ? `Game data  ${report.gameData.dataRoot} (${gamePathOrigin(report.gameData.source)})`
            : 'Game data  not used'
    );
    lines.push('');
    lines.push('Every action says loads, fails, or unknown when this check could not judge it.');
    lines.push('');

    for (const mod of report.mods) lines.push(...modLines(mod), '');

    lines.push(...standingLimitLines(), '');
    lines.push(`Checked ${plural(report.files, 'file')} in ${(report.elapsedMs / 1000).toFixed(1)} s.`);
    lines.push(verdictLine(report));
    return `${lines.join('\n')}\n`;
};

/**
 * One mod's part of the readable report.
 *
 * @param mod the mod's verdict.
 * @returns the lines, without a trailing blank line.
 */
const modLines = (mod: ModAssertion): string[] => {
    const title = mod.name ?? folderName(mod.folder);
    const lines = [`${title}${mod.id ? ` (${mod.id})` : ''}`, `  ${mod.folder}`];
    for (const manifest of mod.manifests) {
        lines.push(`  Manifest ${manifest.path}${manifest.selectionNote ? `, ${manifest.selectionNote}` : ''}`);
    }
    lines.push(
        `  ${plural(mod.counts.actions, 'action')}: ${mod.counts.ok} load, ${mod.counts.failed} fail, ` +
            `${mod.counts.unverifiable} could not be judged.`
    );
    lines.push('');

    const failures = [...mod.failures, ...mod.manifests.flatMap((manifest) => manifest.failures)];
    for (const failure of failures) lines.push(...failureLines(failure));

    // Only what fails, and the action that loads while doing nothing. Everything that could not be
    // judged is explained once, in the block below, rather than twice in one report.
    const actions = mod.manifests.flatMap((manifest) => manifest.actions);
    const reported = actions.filter((action) => action.mark === 'failed' || action.effect === 'no-effect');
    for (const action of reported.slice(0, LIST_LIMIT * 4)) lines.push(...actionLines(action));
    if (reported.length > LIST_LIMIT * 4) {
        lines.push(`  ${plural(reported.length - LIST_LIMIT * 4, 'further action')} not listed here.`, '');
    }

    lines.push(...disclosureLines(mod.disclosures));
    if (mod.orphanActionFiles.length > 0) {
        lines.push(
            `  Files holding an Actions list that no manifest of this mod was seen to include (${mod.orphanActionFiles.length}):`,
            ...mod.orphanActionFiles
                .slice(0, LIST_LIMIT)
                .map((file) => `    ${file.path}, ${plural(file.actions, 'entry', 'entries')}`)
        );
        if (mod.orphanActionFiles.length > LIST_LIMIT) {
            lines.push(`    and ${mod.orphanActionFiles.length - LIST_LIMIT} more.`);
        }
        lines.push('');
    }
    lines.push(`  ${modVerdict(mod)}`);
    return lines;
};

/**
 * The sentence that says what happens to one mod.
 *
 * @param mod the mod's verdict.
 * @returns the sentence.
 */
const modVerdict = (mod: ModAssertion): string => {
    if (mod.verdict === 'does-not-load') {
        const stops = mod.manifests
            .flatMap((manifest) => manifest.actions)
            .some((action) => action.effect === 'game-stops');
        return stops
            ? 'This mod does not load, and the game stops loading with it.'
            : 'The game starts without this mod.';
    }
    if (mod.verdict === 'unknown') {
        return `The game loads everything this check could judge, and ${plural(mod.disclosures.length, 'thing')} could not be judged.`;
    }
    return 'The game loads this mod.';
};

/**
 * The lines for one manifest failure.
 *
 * @param failure the failure.
 * @returns the lines, ending in a blank line.
 */
const failureLines = (failure: ManifestFailure): string[] => [
    `  fails    ${failure.path}:${failure.line}  ${failure.subject}`,
    ...wrap(failure.detail, '      '),
    '',
];

/**
 * The lines for one action.
 *
 * @param action the action's verdict.
 * @returns the lines, ending in a blank line.
 */
const actionLines = (action: ActionVerdict): string[] => {
    const where = `${action.path}:${action.line}`;
    const target = action.targets.length > 0 ? `  "${action.targets[0]}"` : '';
    return [
        `  ${MARK_WORDS[action.mark].padEnd(8)} ${where}  ${action.verb || '(no Action field)'}${target}`,
        ...wrap(action.detail, '      '),
        '',
    ];
};

/**
 * The block that names everything the check could not see about this mod, grouped by the reason.
 * It is printed even when there is nothing in it, so a reader can tell an empty list from a report
 * that never mentions the question.
 *
 * @param disclosures everything the check could not judge.
 * @returns the lines, ending in a blank line.
 */
const disclosureLines = (disclosures: readonly Disclosure[]): string[] => {
    const lines = ['  What this check could not see here'];
    if (disclosures.length === 0) {
        lines.push('    Nothing. Every action was judged.', '');
        return lines;
    }
    const byReason = new Map<string, Disclosure[]>();
    for (const disclosure of disclosures) {
        const known = byReason.get(disclosure.reason);
        if (known) known.push(disclosure);
        else byReason.set(disclosure.reason, [disclosure]);
    }
    for (const [reason, group] of byReason) {
        lines.push(`    ${REASON_TITLES[group[0].reason]} (${group.length})`);
        for (const disclosure of group.slice(0, LIST_LIMIT)) {
            const where = disclosure.line === undefined ? disclosure.path : `${disclosure.path}:${disclosure.line}`;
            lines.push(`      ${where}`, ...wrap(disclosure.detail, '        '));
        }
        if (group.length > LIST_LIMIT) lines.push(`      and ${group.length - LIST_LIMIT} more of ${reason}.`);
    }
    lines.push('');
    return lines;
};

/**
 * The limits that hold for every run of this check, whatever it found. They are printed always,
 * because each of them is a way the answer can be right about the files and wrong about the game.
 */
export const STANDING_LIMITS: readonly string[] = [
    'This check answers whether the game loads the mod, and nothing else. Run it without --assert-loads for everything the editor reports.',
    'Targets are resolved against the game data plus this mod alone. Mods load in the order of their ID and each one sees the tree as the mods before it left it, so a target another mod creates reads as missing here, and a position in a list can name a different entry in the running game.',
    'Whether the player has the other mods installed cannot be known from this folder.',
    'The game data cannot be copied into a build service, so a run there needs the game installed on the machine that runs it. Without the game data this check refuses to run at all.',
];

/**
 * The standing limits as the readable report prints them.
 *
 * @returns the lines.
 */
const standingLimitLines = (): string[] => [
    'What this check cannot see at any time',
    ...STANDING_LIMITS.flatMap((limit) => wrap(limit, '  ')),
];

/**
 * The line that says how the whole run came out.
 *
 * @param report the finished report.
 * @returns the verdict line.
 */
const verdictLine = (report: AssertReport): string => {
    if (report.loadBlocking > 0) {
        const subject = report.loadBlocking === 1 ? '1 thing stops' : `${report.loadBlocking} things stop`;
        return `${subject} the game loading ${report.mods.length === 1 ? 'this mod' : 'these mods'}.`;
    }
    if (report.complete) return 'Everything was checked and the game loads what is here.';
    return `Nothing that was checked fails, and ${plural(report.unverifiable, 'thing')} could not be checked.`;
};

/**
 * Wrap a sentence so a build log stays readable.
 *
 * @param text the sentence.
 * @param indent the indent every line gets.
 * @returns the wrapped lines.
 */
const wrap = (text: string, indent: string): string[] => {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = indent;
    for (const word of words) {
        if (current.length > indent.length && current.length + 1 + word.length > WRAP_WIDTH) {
            lines.push(current);
            current = indent;
        }
        current = current.length > indent.length ? `${current} ${word}` : `${current}${word}`;
    }
    if (current.length > indent.length) lines.push(current);
    return lines;
};

/**
 * The machine-readable report.
 *
 * It carries no clock, for the same reason the lint command's JSON carries none: two runs over
 * unchanged files have to produce the same bytes, or the report cannot be diffed.
 *
 * @param report the finished report.
 * @returns the JSON text, ending in a newline.
 */
export const assertJsonReport = (report: AssertReport): string =>
    `${JSON.stringify(
        {
            tool: { name: TOOL_NAME, version: toolVersion(), check: 'assert-loads' },
            run: {
                folders: report.folders,
                files: report.files,
                passes: report.passes,
                gameData: {
                    available: report.gameData.available,
                    dataRoot: report.gameData.dataRoot ?? null,
                    source: report.gameData.source ?? null,
                    reason: report.gameData.reason ?? null,
                },
            },
            summary: {
                loadBlocking: report.loadBlocking,
                unverifiable: report.unverifiable,
                complete: report.complete,
            },
            limits: STANDING_LIMITS,
            mods: report.mods.map((mod) => ({
                folder: mod.folder,
                id: mod.id ?? null,
                name: mod.name ?? null,
                verdict: mod.verdict,
                counts: mod.counts,
                loadBlocking: mod.loadBlocking,
                failures: mod.failures,
                manifests: mod.manifests.map((manifest) => ({
                    path: manifest.path,
                    selectionNote: manifest.selectionNote ?? null,
                    failures: manifest.failures,
                    actions: manifest.actions.map(actionJson),
                })),
                orphanActionFiles: mod.orphanActionFiles,
                unreadableFiles: mod.unreadableFiles,
                disclosures: mod.disclosures,
            })),
        },
        null,
        2
    )}\n`;

/**
 * One action in the machine-readable report. The scan's own findings are carried along, so a
 * script can show what the check read without running a second pass.
 *
 * @param action the action's verdict.
 * @returns the object to write.
 */
const actionJson = (action: ActionVerdict): unknown => ({
    path: action.path,
    line: action.line,
    column: action.column,
    verb: action.verb,
    targets: action.targets,
    mark: action.mark,
    reason: action.reason ?? null,
    effect: action.effect ?? null,
    detail: action.detail,
    findings: action.findings.map((finding) => ({
        ruleId: finding.ruleId,
        severity: finding.severity,
        message: finding.message,
        startLine: finding.startLine,
        startColumn: finding.startColumn,
    })),
});
