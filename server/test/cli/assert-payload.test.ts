import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildAssertReport } from '../../src/cli/assert/assert';
import { FILE_LOAD_BLOCKERS, refusesTheFile } from '../../src/cli/assert/model';
import { walkModFiles } from '../../src/cli/assert/walk';
import type { LintFinding } from '../../src/cli/findings';
import { FIXTURES, GAME_DATA } from './assert-fixture';

// The load check answers one question, and the worst answer it can give is "loads" about a mod the
// game refuses. An action adds content out of the mod's own files, the game parses those files
// while it applies the action, and our own parser recovers from the inputs the game refuses, so the
// scan's findings on those files are the only thing that can say so.

const PAYLOAD_MOD = join(FIXTURES, 'assert-payload-mod');
const CLEAN_MOD = join(FIXTURES, 'assert-clean-mod');

/**
 * One finding the scan would publish on a file of a fixture mod.
 *
 * @param file the file it is in, absolute.
 * @param ruleId the rule that produced it.
 * @param message the message it carries.
 * @param severity the severity it carries, error unless another is given.
 * @returns the finding.
 */
const findingOn = (
    file: string,
    ruleId: string,
    message: string,
    severity: LintFinding['severity'] = 'error'
): LintFinding => ({
    file,
    path: file,
    ruleId,
    named: true,
    severity,
    message,
    startLine: 4,
    startColumn: 12,
    endLine: 4,
    endColumn: 13,
    unnecessary: false,
});

/**
 * The report for one fixture mod with the findings a scan would have published on its files.
 *
 * @param folder the fixture mod folder, absolute.
 * @param findings what the scan reported.
 * @returns the finished report.
 */
const reportWith = async (folder: string, findings: LintFinding[]) => {
    const { rulesFiles } = await walkModFiles(folder);
    return buildAssertReport({
        folders: [folder],
        gameData: GAME_DATA,
        findings,
        checkedFiles: rulesFiles,
        files: rulesFiles.length,
        passes: 1,
        elapsedMs: 0,
    });
};

describe('a mod whose action adds content the game refuses to read', () => {
    it('never answers that the mod loads, for a file that does not parse', async () => {
        const refused = join(PAYLOAD_MOD, 'parts', 'refused.rules');
        const report = await reportWith(PAYLOAD_MOD, [
            findingOn(refused, 'parse-error', 'This text is missing its closing quote'),
        ]);
        const mod = report.mods[0];
        expect(mod.verdict).toBe('does-not-load');
        expect(mod.loadBlocking).toBe(1);
        expect(mod.counts.failed).toBe(1);
        expect(mod.manifests[0].actions[0].effect).toBe('game-stops');
        expect(mod.manifests[0].actions[0].detail).toContain('parts/refused.rules');
    });

    it('never answers that the mod loads, for a name the game refuses to read twice', async () => {
        // The game throws an OTParseException on a repeated name too, and the editor reports that
        // as a duplicate field rather than as a parse error, so keying on the parse rule alone
        // would pass this mod.
        const refused = join(PAYLOAD_MOD, 'parts', 'refused.rules');
        const report = await reportWith(PAYLOAD_MOD, [
            findingOn(refused, 'syntax-and-references', 'Duplicate field "MaxHealth"'),
        ]);
        expect(report.mods[0].verdict).toBe('does-not-load');
        expect(report.mods[0].manifests[0].actions[0].detail).toContain('Duplicate field');
    });

    it('follows the content one more file on', async () => {
        // The action names `read.rules`, which inherits from `base.rules`, and the game reads both
        // while it applies the action.
        const report = await reportWith(PAYLOAD_MOD, [
            findingOn(join(PAYLOAD_MOD, 'parts', 'base.rules'), 'document-duplicate', 'Duplicate field "Base"'),
        ]);
        expect(report.mods[0].verdict).toBe('does-not-load');
        expect(report.mods[0].manifests[0].actions[0].detail).toContain('parts/base.rules');
    });

    it('never answers that the mod loads when the manifest itself carries a repeated name', async () => {
        // The manifest is read before anything is applied, and a name written twice in it is the
        // same refusal, so the manifest is weighed against the same allowlist.
        const report = await reportWith(PAYLOAD_MOD, [
            findingOn(join(PAYLOAD_MOD, 'mod.rules'), 'document-duplicate', 'Duplicate field "ID"'),
        ]);
        expect(report.mods[0].verdict).toBe('does-not-load');
        expect(report.mods[0].manifests[0].failures[0].subject).toBe('file');
    });

    it('says so when the scan published no result for a file the content comes from', async () => {
        const report = await buildAssertReport({
            folders: [PAYLOAD_MOD],
            gameData: GAME_DATA,
            findings: [],
            checkedFiles: [join(PAYLOAD_MOD, 'mod.rules')],
            files: 1,
            passes: 1,
            elapsedMs: 0,
        });
        const mod = report.mods[0];
        expect(mod.verdict).toBe('unknown');
        expect(mod.counts.unverifiable).toBe(1);
        expect(mod.disclosures.map((entry) => entry.reason)).toContain('file-not-checked');
        expect(report.complete).toBe(false);
    });
});

describe('what the load check keeps out of the fold', () => {
    it('still answers that a mod loads when the content carries an ordinary error', async () => {
        // The negative control. Without this, a check that always answered "does not load" would
        // pass every test above. A schema error is a real error the game reads past, so folding
        // every error on every file the content reaches would destroy the check.
        const report = await reportWith(PAYLOAD_MOD, [
            findingOn(join(PAYLOAD_MOD, 'parts', 'read.rules'), 'schema', 'Unknown value "Fast" for this field'),
            findingOn(
                join(PAYLOAD_MOD, 'parts', 'refused.rules'),
                'syntax-and-references',
                'Reference should start with an ampersand'
            ),
        ]);
        expect(report.mods[0].verdict).toBe('loads');
        expect(report.mods[0].loadBlocking).toBe(0);
        expect(report.complete).toBe(true);
    });

    it('still answers that a clean mod loads with nothing left unjudged', async () => {
        const report = await reportWith(CLEAN_MOD, []);
        expect(report.mods[0].verdict).toBe('loads');
        expect(report.mods[0].disclosures).toEqual([]);
    });
});

describe('what says the game refuses a whole file', () => {
    it('is the allowlist and nothing else', () => {
        // The set is pinned rather than derived, because widening it silently turns an ordinary
        // error into "does not load" for every mod that carries one.
        expect(FILE_LOAD_BLOCKERS.map((blocker) => [blocker.ruleId, blocker.messageStart])).toEqual([
            ['parse-error', ''],
            ['document-duplicate', 'Duplicate field "'],
            ['syntax-and-references', 'Duplicate field "'],
        ]);
        for (const blocker of FILE_LOAD_BLOCKERS) expect(blocker.engine).toMatch(/\.cs:\d+$/);
    });

    it('reads a repeated name the way the pass writes it', () => {
        // The pass writes the message, and the allowlist matches on its start, so the two are
        // pinned against each other rather than left to agree by eye.
        const source = readFileSync(
            join(__dirname, '..', '..', 'src', 'features', 'diagnostics', 'validator.duplicate-key.ts'),
            'utf8'
        );
        const written = [...source.matchAll(/message:\s*l10n\.t\('((?:[^'\\]|\\.)*)'/g)]
            .map((match) => match[1])
            .find((message) => message.startsWith('Duplicate'));
        expect(written).toBe('Duplicate field "{0}"');
        const asPublished = written!.replace('{0}', 'MaxHealth');
        expect(FILE_LOAD_BLOCKERS.some((blocker) => asPublished.startsWith(blocker.messageStart))).toBe(true);
    });

    it('weighs only an error, never a warning of the same words', () => {
        const file = join(PAYLOAD_MOD, 'parts', 'refused.rules');
        expect(refusesTheFile(findingOn(file, 'parse-error', 'anything'))).toBe(true);
        expect(refusesTheFile(findingOn(file, 'parse-error', 'anything', 'warning'))).toBe(false);
        expect(refusesTheFile(findingOn(file, 'schema', 'Duplicate field "X"'))).toBe(false);
    });
});
