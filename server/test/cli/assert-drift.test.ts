import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isTypableTargetPath } from '../../src/mod/action-rooting.index';
import { isTypableTarget } from '../../src/cli/assert/judge';
import { ACTION_FINDING_EFFECTS } from '../../src/cli/assert/model';

// The load check reads two things out of the server without importing them: which target paths the
// editor can type, and what each mod action finding means. Both are copies, and a copy that drifts
// turns the report into a confident wrong answer, so both are pinned here against the source they
// were taken from.

const SERVER_SOURCE = join(__dirname, '..', '..', 'src');

describe('the target paths the editor can type', () => {
    it('answers exactly what the rooting index answers', () => {
        const paths = [
            '<parts/cannon.rules>/Part',
            '<parts/cannon.rules>',
            '&<parts/cannon.rules>/Part/Components',
            '<ships/terran/terran.rules>/Terran/Parts/0',
            '<a.rules>/B/^',
            '<a.rules>/B/..',
            '<a.rules>/B/:',
            '<a.rules>/B/#',
            '<./Data/cosmoteer.rules>/Ships',
            'Part/Components',
            '',
            '   <a.rules>/B  ',
        ];
        for (const path of paths) expect(isTypableTarget(path), path).toBe(isTypableTargetPath(path));
    });
});

describe('what a mod action finding means', () => {
    it('carries every message the validation pass writes, and no message it does not', () => {
        const source = readFileSync(join(SERVER_SOURCE, 'features', 'diagnostics', 'validator.mod-action.ts'), 'utf8');
        const written = new Set<string>();
        for (const match of source.matchAll(/message:\s*l10n\.t\('((?:[^'\\]|\\.)*)'\)/g)) {
            written.add(match[1].replace(/\\'/g, "'"));
        }
        expect(written.size).toBeGreaterThan(0);
        expect([...written].sort()).toEqual([...ACTION_FINDING_EFFECTS.keys()].sort());
    });
});
