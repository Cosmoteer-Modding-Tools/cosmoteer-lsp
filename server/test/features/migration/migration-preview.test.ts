import { describe, expect, it } from 'vitest';
import {
    MAX_PREVIEW_CONTENT_BYTES,
    MAX_PREVIEW_DIFF_BYTES,
    MAX_PREVIEW_FILES,
    createMigrationPreview,
} from '../../../src/features/migration/migrate-workspace';

// A whole-mod migration can touch every file of a 4000-file mod. The rewritten contents of all of
// them do not belong in one LSP message, so the collector carries what fits and counts the rest
// rather than implying the view is the whole change.
describe('createMigrationPreview', () => {
    it('carries a changed file with its rewritten contents and a diff section', () => {
        const preview = createMigrationPreview();
        preview.add('C:/mod/a.rules', 'a.rules', 'A = 1\n', 'A = 2\n');
        const result = preview.result();
        expect(result.changed).toEqual([{ fsPath: 'C:/mod/a.rules', after: 'A = 2\n' }]);
        expect(result.diff).toContain('a.rules');
        expect(result.omitted).toBe(0);
        expect(result.diffTruncated).toBe(false);
    });

    it('counts a file the caller could not render', () => {
        const preview = createMigrationPreview();
        preview.omit();
        expect(preview.result().omitted).toBe(1);
    });

    it('stops carrying contents past the file cap but keeps diffing', () => {
        const preview = createMigrationPreview();
        for (let index = 0; index < MAX_PREVIEW_FILES + 5; index++) {
            preview.add(`C:/mod/${index}.rules`, `${index}.rules`, 'A = 1\n', 'A = 2\n');
        }
        const result = preview.result();
        expect(result.changed).toHaveLength(MAX_PREVIEW_FILES);
        expect(result.omitted).toBe(5);
        // The diff still accounts for every file, which is what makes the counts honest.
        expect(result.diff).toContain(`${MAX_PREVIEW_FILES + 4}.rules`);
    });

    it('stops carrying contents once the byte budget is spent', () => {
        const preview = createMigrationPreview();
        const big = 'x'.repeat(MAX_PREVIEW_CONTENT_BYTES);
        preview.add('C:/mod/big.rules', 'big.rules', '', big);
        preview.add('C:/mod/next.rules', 'next.rules', 'A = 1\n', 'A = 2\n');
        const result = preview.result();
        expect(result.changed.map((file) => file.fsPath)).toEqual(['C:/mod/big.rules']);
        expect(result.omitted).toBe(1);
    });

    it('truncates the diff and says so rather than sending an unbounded message', () => {
        const preview = createMigrationPreview();
        const line = `${'y'.repeat(200)}\n`;
        // Each file contributes a diff section, so enough of them pass the diff budget.
        for (let index = 0; index < 12000; index++) {
            preview.add(`C:/mod/${index}.rules`, `${index}.rules`, line, `${line}z\n`);
        }
        const result = preview.result();
        expect(result.diffTruncated).toBe(true);
        expect(result.diff.length).toBeLessThanOrEqual(MAX_PREVIEW_DIFF_BYTES);
    });

    it('records nothing for a file whose text did not change', () => {
        const preview = createMigrationPreview();
        preview.add('C:/mod/a.rules', 'a.rules', 'A = 1\n', 'A = 1\n');
        // The contents are still carried (the caller only calls add for a file it edited), but an
        // empty diff section is not appended.
        expect(preview.result().diff).toBe('');
    });
});
