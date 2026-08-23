import * as l10n from '@vscode/l10n';
import { existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { foldPathCase } from '../../workspace/fs-cache';
import { code, linkDestination } from '../report/markdown-link';
import { GameVersionInfo } from './game-version';
import { PostUpdateSnapshot } from './post-update-baseline';
import {
    AttributionWarning,
    FindingDelta,
    ManifestVerdict,
    PostUpdateDiff,
    PostUpdateReportRequest,
    PostUpdateSummary,
} from './post-update-report';

/**
 * The markdown of the post-update report.
 *
 * The order of the sections follows the order the questions come up in: which versions are being
 * compared, what newly fails, what stopped failing, what the reader changed themselves, whether the
 * installed game still loads the mod, what the migration would rewrite, and last what none of it
 * can see. The closing section is not a footnote. Every one of the report's blind spots is named
 * there, because a report about what an update broke is worth nothing if the reader cannot tell a
 * quiet section from an unchecked one.
 */

/** How many rows one section shows before it says how many it left out. */
const MAX_ROWS = 100;

/** Everything the renderer needs, gathered by the report builder. */
interface PostUpdateRenderInput {
    readonly request: PostUpdateReportRequest;
    readonly info: GameVersionInfo;
    readonly summary: PostUpdateSummary;
    readonly diff: PostUpdateDiff;
    /** The generation from before the update, when one is stored. */
    readonly previous?: PostUpdateSnapshot;
    /** The snapshot of what the scan reports now, when the scan produced anything. */
    readonly current?: PostUpdateSnapshot;
    /** The newest game version the deprecation registry knows, empty when it holds none. */
    readonly registryVersion: string;
}

/**
 * Render the whole report.
 *
 * @param input everything the report was built from.
 * @returns the markdown.
 */
export const renderPostUpdateReport = (input: PostUpdateRenderInput): string => {
    displayCaseMemo.clear();
    const lines: string[] = [];
    lines.push(`# ${l10n.t('What the game update changed')}`);
    lines.push('');
    lines.push(...versionSection(input));
    lines.push(...statusSection(input));
    if (input.summary.status === 'compared') {
        lines.push(...attributionSection(input));
        lines.push(...deltaSection(input, 'appeared', l10n.t('What newly fails'), l10n.t(
            'These findings were not there under the previous game version, in files that did not change on disk since then.'
        )));
        lines.push(...deltaSection(input, 'resolved', l10n.t('What stopped failing'), l10n.t(
            'These findings were there under the previous game version and are gone now.'
        )));
        lines.push(...deltaSection(input, 'edited', l10n.t('Files you changed yourself'), l10n.t(
            'These files moved on disk since the recording, so a difference in them is as likely your own edit as the update.'
        )));
        lines.push(...deltaSection(input, 'capped', l10n.t('Findings a full file hides'), l10n.t(
            'These files reached the per-file problem limit, so the editor only ever published the first of their findings and one going missing means nothing.'
        )));
        lines.push(...scopeSection(input));
    }
    lines.push(...manifestSection(input));
    lines.push(...migrationSection(input));
    lines.push(...blindSpotSection(input));
    return lines.join('\n');
};

/**
 * The header: which versions the report is about and where those version facts come from.
 *
 * @param input the render input.
 * @returns the lines.
 */
const versionSection = (input: PostUpdateRenderInput): string[] => {
    const lines: string[] = [];
    const installed = input.info.installed;
    const previous = input.summary.previousVersion;
    if (installed && previous && previous !== installed) {
        lines.push(l10n.t('Installed game: {0}. The last recording of this project was taken under {1}.', code(installed), code(previous)));
    } else if (installed) {
        lines.push(l10n.t('Installed game: {0}.', code(installed)));
    } else {
        lines.push(l10n.t('The installed game version could not be read.'));
    }
    if (input.info.source === 'assembly' && input.info.assemblyPath) {
        lines.push('');
        lines.push(
            l10n.t(
                'The versions this build still accepts a mod for were read from {0}. There are {1} of them, from {2} to {3}.',
                code(input.info.assemblyPath),
                String(input.info.accepted.length),
                code(input.info.accepted[0] ?? ''),
                code(input.info.accepted[input.info.accepted.length - 1] ?? '')
            )
        );
    } else if (input.info.source === 'manifest') {
        lines.push('');
        lines.push(
            l10n.t(
                'The game assembly could not be read, so the version above comes from the manifests the game ships with its own mods. The list of older versions this build still accepts is unknown, and the compatibility verdict below is left open because of it.'
            )
        );
    }
    if (input.request.lastRunVersion) {
        lines.push('');
        lines.push(l10n.t('The imported game log was written by {0}.', code(input.request.lastRunVersion)));
    }
    if (input.previous) {
        lines.push('');
        lines.push(
            l10n.t(
                'The recording it is compared against was taken on {0} UTC and covered {1} files.',
                new Date(input.previous.savedAt).toISOString().slice(0, 16).replace('T', ' '),
                String(input.previous.fileCount)
            )
        );
    }
    lines.push('');
    return lines;
};

/**
 * The notice that says what the report can and cannot do in this state.
 *
 * @param input the render input.
 * @returns the lines, empty when the report compares two generations.
 */
const statusSection = (input: PostUpdateRenderInput): string[] => {
    const reason = statusReason(input);
    if (!reason) return [];
    return ['', `> ${reason}`, ''];
};

/**
 * The sentence explaining a status that is not a comparison.
 *
 * @param input the render input.
 * @returns the sentence, or undefined when the report compares two generations.
 */
const statusReason = (input: PostUpdateRenderInput): string | undefined => {
    switch (input.summary.status) {
        case 'compared':
            return undefined;
        case 'noGamePath':
            return l10n.t(
                'No Cosmoteer install is configured, so there is nothing to read a version from and nothing to compare. Set the game path in the settings and let the project be checked once.'
            );
        case 'wholeWorkspaceOff':
            return l10n.t(
                'Whole-workspace validation is off, so the editor never records what the project reports and this report has nothing to compare. Turn on cosmoteerLSPRules.diagnostics.validateWholeWorkspace and open the project once under each game version.'
            );
        case 'noScanResults':
            return l10n.t(
                'The check of the whole project has not produced anything yet in this session, so there is nothing to compare. Let it finish and run this again.'
            );
        case 'noBaseline':
            return l10n.t(
                'Nothing was recorded for this project before now. The recording is written as the project is checked, so a comparison becomes possible from the next game update on. Nothing here says the update changed nothing.'
            );
        case 'noPreviousGeneration':
            return l10n.t(
                'Only one recording exists, taken under {0}. A comparison needs one recording from before the update and one from after it, so what follows is only what the installed game makes of this mod.',
                input.previous?.gameVersion || input.current?.gameVersion || l10n.t('an unknown version')
            );
        case 'sameGameVersion':
            return l10n.t(
                'Both recordings were taken under {0}, so no game update sits between them and there is nothing for this report to attribute.',
                input.summary.previousVersion || l10n.t('an unknown version')
            );
    }
};

/**
 * The warnings about everything besides the game that moved between the two recordings.
 *
 * @param input the render input.
 * @returns the lines, empty when nothing else moved.
 */
const attributionSection = (input: PostUpdateRenderInput): string[] => {
    if (input.summary.attribution.length === 0) return [];
    const lines = ['', `## ${l10n.t('Why some of this may not be the update')}`, ''];
    lines.push(l10n.t('Something other than the game changed between the two recordings, so a difference below can come from it instead.'));
    lines.push('');
    for (const warning of input.summary.attribution) lines.push(`- ${attributionText(warning)}`);
    lines.push('');
    return lines;
};

/**
 * One attribution warning in words.
 *
 * @param warning the warning.
 * @returns the sentence.
 */
const attributionText = (warning: AttributionWarning): string => {
    switch (warning) {
        case 'serverBuild':
            return l10n.t(
                'The extension was upgraded between the two recordings. A check that was added, removed or corrected in that upgrade shows up below as if the game had changed.'
            );
        case 'settings':
            return l10n.t(
                'A setting that decides what is checked changed between the two recordings, so a whole check may have been switched on or off.'
            );
        case 'workshop':
            return l10n.t(
                'The installed workshop mods changed between the two recordings. Ids another mod declares count as declared here, so subscribing or unsubscribing moves findings on its own.'
            );
        case 'codeMods':
            return l10n.t(
                'A code mod assembly in this project was rebuilt between the two recordings, which changes the types and fields the editor knows about.'
            );
        case 'unknownVersion':
            return l10n.t(
                'One of the recordings carries no game version, so the report cannot prove an update sits between them.'
            );
        case 'untagged':
            return l10n.t(
                'Some findings come from a build that did not name the check that produced them. They are grouped under one name, which matches them more coarsely than the rest.'
            );
    }
};

/**
 * One table of differences.
 *
 * @param input the render input.
 * @param kind which differences the section shows.
 * @param title the section heading.
 * @param lead the sentence under the heading.
 * @returns the lines, empty when there is no difference of that kind.
 */
const deltaSection = (input: PostUpdateRenderInput, kind: FindingDelta['kind'], title: string, lead: string): string[] => {
    const rows = input.diff.deltas.filter((delta) => delta.kind === kind);
    if (rows.length === 0) return [];
    const lines = ['', `## ${title} (${rows.length})`, '', lead, ''];
    lines.push(`| ${l10n.t('Where')} | ${l10n.t('Check')} | ${l10n.t('Severity')} | ${l10n.t('How many')} | ${l10n.t('Example')} |`);
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of rows.slice(0, MAX_ROWS)) {
        lines.push(
            `| ${lineLinks(input.request.folderPaths, row.path, row.lines)} | ${code(row.ruleId)} | ${row.severity} | ${row.count} | ${cell(row.message)} |`
        );
    }
    if (rows.length > MAX_ROWS) {
        lines.push('');
        lines.push(l10n.t('{0} more are not shown.', String(rows.length - MAX_ROWS)));
    }
    lines.push('');
    return lines;
};

/**
 * The files that entered or left the checked set, which cannot be compared at all.
 *
 * @param input the render input.
 * @returns the lines, empty when the checked set is the same.
 */
const scopeSection = (input: PostUpdateRenderInput): string[] => {
    const { enteredFiles, leftFiles } = input.diff;
    if (enteredFiles.length === 0 && leftFiles.length === 0) return [];
    const lines = ['', `## ${l10n.t('Files the two recordings do not share')}`, ''];
    lines.push(
        l10n.t(
            'These files are in only one of the two recordings, so nothing about them can be compared. A file enters or leaves the checked set when it is added, deleted, or when the manifest stops reaching it.'
        )
    );
    lines.push('');
    if (enteredFiles.length > 0) {
        lines.push(`**${l10n.t('Only in the current check ({0})', String(enteredFiles.length))}**`);
        lines.push('');
        for (const path of enteredFiles.slice(0, MAX_ROWS)) lines.push(`- ${code(path)}`);
        if (enteredFiles.length > MAX_ROWS) lines.push(l10n.t('{0} more are not shown.', String(enteredFiles.length - MAX_ROWS)));
        lines.push('');
    }
    if (leftFiles.length > 0) {
        lines.push(`**${l10n.t('Only in the earlier recording ({0})', String(leftFiles.length))}**`);
        lines.push('');
        for (const path of leftFiles.slice(0, MAX_ROWS)) lines.push(`- ${code(path)}`);
        if (leftFiles.length > MAX_ROWS) lines.push(l10n.t('{0} more are not shown.', String(leftFiles.length - MAX_ROWS)));
        lines.push('');
    }
    return lines;
};

/**
 * The verdict on every manifest: whether the installed game would still load the mod.
 *
 * @param input the render input.
 * @returns the lines, empty when the open folders hold no manifest.
 */
const manifestSection = (input: PostUpdateRenderInput): string[] => {
    if (input.summary.manifests.length === 0) return [];
    const lines = ['', `## ${l10n.t('Whether the installed game still takes this mod')}`, ''];
    lines.push(
        l10n.t(
            'The game reads a mod as compatible when its CompatibleGameVersions names the installed version or one of the older versions this build still accepts. It only acts on that when its own auto-disable setting is on and the version last played is not one this build accepts, and then it removes the mod from the enabled list.'
        )
    );
    lines.push('');
    lines.push(`| ${l10n.t('Manifest')} | ${l10n.t('Declares')} | ${l10n.t('Verdict')} |`);
    lines.push('| --- | --- | --- |');
    for (const manifest of input.summary.manifests) lines.push(manifestRow(input, manifest));
    lines.push('');
    return lines;
};

/**
 * One manifest row.
 *
 * @param input the render input.
 * @param manifest the manifest verdict.
 * @returns the table row.
 */
const manifestRow = (input: PostUpdateRenderInput, manifest: ManifestVerdict): string => {
    const declared = manifest.declared === undefined ? `*${l10n.t('nothing')}*` : manifest.declared.map(code).join(', ');
    return `| ${fileLink(input.request.folderPaths, manifest.path, 1)} | ${declared || `*${l10n.t('an empty list')}*`} | ${verdictText(manifest, input.info)} |`;
};

/**
 * One verdict in words.
 *
 * @param manifest the manifest verdict.
 * @param info the installed game's version facts.
 * @returns the sentence.
 */
const verdictText = (manifest: ManifestVerdict, info: GameVersionInfo): string => {
    switch (manifest.verdict) {
        case 'namesInstalled':
            return l10n.t('Names the installed version, so the game takes it.');
        case 'namesAccepted':
            return l10n.t('Names an older version this build still accepts, so the game takes it.');
        case 'namesNone':
            return l10n.t(
                'Names no version this build accepts. With auto-disable on, the game removes this mod from the enabled list. Add {0} to the list.',
                code(info.installed)
            );
        case 'undeclared':
            return l10n.t(
                'Declares no versions at all. The game reads that as no match, so it disables the mod whenever it runs the auto-disable pass.'
            );
        case 'unknown':
            return l10n.t('The accepted version list could not be read, so there is no verdict here.');
    }
};

/**
 * What a dry run of the migration would rewrite.
 *
 * @param input the render input.
 * @returns the lines.
 */
const migrationSection = (input: PostUpdateRenderInput): string[] => {
    const lines = ['', `## ${l10n.t('What the migration would rewrite')}`, ''];
    const migration = input.request.migration;
    if (!migration) {
        lines.push(l10n.t('The migration was not run for this report, so nothing here says whether it would change anything.'));
        lines.push('');
        return lines;
    }
    if (migration.files === 0 && migration.manual.length === 0) {
        lines.push(l10n.t('The migration would change nothing in this project.'));
    } else {
        lines.push(`- ${l10n.t('Files it would rewrite')}: ${migration.files}`);
        lines.push(`- ${l10n.t('Changes it would make')}: ${migration.fixes}`);
        lines.push(`- ${l10n.t('Findings that need your decision')}: ${migration.manual.length}`);
        for (const [version, count] of Object.entries(migration.byVersion)) {
            if (count > 0) {
                lines.push(`- ${l10n.t('Changes for {0}', code(version || l10n.t('a release older than the records')))}: ${count}`);
            }
        }
        if (migration.unparsable > 0) {
            lines.push(
                `- ${l10n.t('Files it skipped because they do not parse, and never looked inside')}: ${migration.unparsable}`
            );
        }
    }
    lines.push('');
    return lines;
};

/**
 * The closing section: everything this report cannot see.
 *
 * @param input the render input.
 * @returns the lines.
 */
const blindSpotSection = (input: PostUpdateRenderInput): string[] => {
    const lines = ['', `## ${l10n.t('What this report cannot see')}`, ''];
    const points: string[] = [];
    points.push(
        l10n.t(
            'The schema this editor checks against is built into the extension, not read from the installed game. A game update on its own can never make a field or a type unknown here, so nothing in this report is evidence about fields the update added, removed or renamed. That only moves when the extension ships a new schema.'
        )
    );
    points.push(
        input.registryVersion
            ? l10n.t(
                  'The migration list comes from a registry that is written by hand and stops at {0}. Anything a later release changed is not in it, so a quiet migration section is not proof that nothing needs rewriting.',
                  code(input.registryVersion)
              )
            : l10n.t(
                  'The migration list comes from a registry that is written by hand and currently holds nothing, so the migration section says nothing about what a release changed.'
              )
    );
    points.push(
        l10n.t(
            'Only what the editor checks is compared. What the game does while it runs, balance, behaviour, art and sound, is invisible here, and so is anything in a file the editor does not read.'
        )
    );
    points.push(
        l10n.t(
            'Findings are matched by file, check, severity and line, never by their wording, so a display language change or a reworded message does not read as a change. Two findings of the same check on the same line of one file are only told apart by how many there are.'
        )
    );
    points.push(
        l10n.t(
            'Only the files the project check covers are compared. With the default setting that is the files the manifest reaches, so a backup or a template the game never loads is in neither recording.'
        )
    );
    points.push(
        l10n.t(
            'A difference is only laid at the update door when the file did not move on disk since the recording. Files you edited are listed on their own, because the editor cannot tell your change from the update in them.'
        )
    );
    points.push(
        l10n.t(
            'A file that reached the limit of {0} problems per file only ever published the first of them, so a finding leaving such a file is listed on its own rather than counted as fixed.',
            String(input.request.maxProblems)
        )
    );
    if (input.info.source !== 'assembly') {
        points.push(
            l10n.t(
                'The list of older versions this build still accepts a mod for lives only in the game assembly, and it could not be read here. Without it there is no way to tell a mod the game still takes from one it disables.'
            )
        );
    }
    if (input.current?.omittedFindings) {
        points.push(
            l10n.t('{0} groups of findings did not fit in the recording and are not compared.', String(input.current.omittedFindings))
        );
    }
    for (const point of points) {
        lines.push(`- ${point}`);
    }
    lines.push('');
    return lines;
};

/** How many lines of one difference the table names before it counts the rest. */
const MAX_LINKED_LINES = 5;

/**
 * The lines of one difference, as links into the file.
 *
 * @param folderPaths the open workspace folders.
 * @param relativePath the file as the recording stores it.
 * @param lines the lines the difference covers.
 * @returns the markdown links, with a count of whatever did not fit.
 */
const lineLinks = (folderPaths: readonly string[], relativePath: string, lines: readonly number[]): string => {
    const shown = lines.slice(0, MAX_LINKED_LINES).map((line) => fileLink(folderPaths, relativePath, line));
    if (lines.length > MAX_LINKED_LINES) {
        shown.push(l10n.t('and {0} more lines', String(lines.length - MAX_LINKED_LINES)));
    }
    return shown.join('<br>');
};

/**
 * One table cell of free text, kept on its own line and short enough to read.
 *
 * @param text the message.
 * @returns the cell content.
 */
const cell = (text: string): string => {
    const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
    return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
};

/**
 * The real spelling of a stored path, restored once per report.
 *
 * Scan results are keyed by a case-folded path, because that is how a Windows or macOS filesystem
 * compares two paths, so the stored path is lower case there. The report shows the path to a person,
 * who wrote it with capitals, so the spelling is read back off the disk. A file that is no longer
 * there keeps the stored spelling.
 */
const displayCaseMemo = new Map<string, string>();

/**
 * The stored path in the spelling the filesystem has for it.
 *
 * @param absolute the file's absolute path, when the report could build one.
 * @param relativePath the stored path.
 * @returns the path to show.
 */
const displayPath = (absolute: string | undefined, relativePath: string): string => {
    const memoized = displayCaseMemo.get(relativePath);
    if (memoized !== undefined) return memoized;
    let display = relativePath;
    if (absolute) {
        try {
            const real = realpathSync.native(absolute).replace(/\\/g, '/');
            const tail = real.slice(real.length - relativePath.length);
            if (foldPathCase(tail) === foldPathCase(relativePath)) display = tail;
        } catch {
            // The file is gone or unreadable, so the stored spelling is all there is.
        }
    }
    displayCaseMemo.set(relativePath, display);
    return display;
};

/**
 * A markdown link to a file and line, labeled with the path as the report stores it.
 *
 * The destination is a `vscode://file/…` deep link with a `:line` suffix rather than a `file:` uri,
 * which the markdown preview rejects outright.
 *
 * @param folderPaths the open workspace folders, to turn the stored relative path back into a file.
 * @param relativePath the file as the recording stores it.
 * @param line the line to open, one based.
 * @returns the markdown link, or the plain path when the file is in none of the folders.
 */
const fileLink = (folderPaths: readonly string[], relativePath: string, line: number): string => {
    const absolute = absolutePathOf(folderPaths, relativePath);
    const label = displayPath(absolute, relativePath);
    if (!absolute) return code(label);
    return `[${label}:${line}](vscode://file/${linkDestination(absolute)}:${line})`;
};

/**
 * The on-disk file a stored relative path names.
 *
 * @param folderPaths the open workspace folders.
 * @param relativePath the stored path.
 * @returns the absolute path, or undefined when no folder holds the file.
 */
const absolutePathOf = (folderPaths: readonly string[], relativePath: string): string | undefined => {
    if (folderPaths.length === 1) return join(folderPaths[0], relativePath);
    for (const folder of folderPaths) {
        const candidate = join(folder, relativePath);
        if (existsSync(candidate)) return candidate;
    }
    return undefined;
};
