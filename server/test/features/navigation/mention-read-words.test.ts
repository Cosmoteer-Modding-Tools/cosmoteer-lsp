import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { MentionIndex } from '../../../src/features/navigation/mention.index';

// The read-word table is what lets a caller tell "this file reads the name" from "this file declares
// a member of that name", which the plain word index cannot answer.
const token = CancellationToken.None;
let dir: string;

const endsWith = (keys: string[], name: string): boolean => keys.some((key) => key.endsWith(name));

describe('MentionIndex read words', () => {
    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'readwords-'));
        writeFileSync(join(dir, 'declares.rules'), 'Part\n{\n\tHEAT_MAX = 5\n\tGROUP_ONLY\n\t{\n\t\tX = 1\n\t}\n}\n');
        writeFileSync(join(dir, 'reads.rules'), 'Part\n{\n\tHeat = (&~/Part/HEAT_MAX)\n\tComponentID = SOME_ID\n}\n');
        writeFileSync(join(dir, 'inherits.rules'), 'Part\n{\n\tCopy : <declares.rules>/GROUP_ONLY\n\t{\n\t}\n}\n');
        writeFileSync(join(dir, 'bare_inherits.rules'), 'Part\n{\n\tTurret : GUN_TEMPLATE\n\t{\n\t}\n\tSecond : FIRST_BASE, SECOND_BASE\n\t{\n\t}\n}\n');
        writeFileSync(
            join(dir, 'commented.rules'),
            'Part\n{\n\t// Speed = (&~/Part/SHOT_SPEED)\n\t/* Size = (&~/Part/BLOCK_SIZE) */\n\tSpeed = 3\n}\n'
        );
        MentionIndex.instance.reset();
        await MentionIndex.instance.ensureBuilt([dir], token);
    });
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
        MentionIndex.instance.reset();
    });

    it('counts a name at the end of a reference path as read', () => {
        expect(endsWith(MentionIndex.instance.filesReading('HEAT_MAX', [dir]), 'reads.rules')).toBe(true);
    });

    it('counts a bare id value as read', () => {
        expect(endsWith(MentionIndex.instance.filesReading('SOME_ID', [dir]), 'reads.rules')).toBe(true);
    });

    it('does not count the declaration itself', () => {
        expect(endsWith(MentionIndex.instance.filesReading('HEAT_MAX', [dir]), 'declares.rules')).toBe(false);
    });

    it('counts an inheritance target followed by an override group as read', () => {
        // The name ends a path and the next thing in the file is the `{` of the deriving group, which
        // must not read as a declaration of the base's name.
        expect(endsWith(MentionIndex.instance.filesReading('GROUP_ONLY', [dir]), 'inherits.rules')).toBe(true);
        expect(endsWith(MentionIndex.instance.filesReading('GROUP_ONLY', [dir]), 'declares.rules')).toBe(false);
    });

    it('counts a bare-name inheritance target as read', () => {
        // The parser normalizes `Turret : GUN_TEMPLATE` to a `&GUN_TEMPLATE` reference, so the bare
        // name is a read even though the `{` of the deriving group follows it.
        expect(endsWith(MentionIndex.instance.filesReading('GUN_TEMPLATE', [dir]), 'bare_inherits.rules')).toBe(true);
    });

    it('counts every base of a multi-base inheritance list as read', () => {
        expect(endsWith(MentionIndex.instance.filesReading('FIRST_BASE', [dir]), 'bare_inherits.rules')).toBe(true);
        expect(endsWith(MentionIndex.instance.filesReading('SECOND_BASE', [dir]), 'bare_inherits.rules')).toBe(true);
    });

    it('does not count a reference inside a comment as read', () => {
        // A commented-out read is dead text to the game and must not vouch for the constant.
        expect(endsWith(MentionIndex.instance.filesReading('SHOT_SPEED', [dir]), 'commented.rules')).toBe(false);
        expect(endsWith(MentionIndex.instance.filesReading('BLOCK_SIZE', [dir]), 'commented.rules')).toBe(false);
    });
});
