import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
    deriveCloneKey,
    stringsInsertsFor,
    textForStringsFile,
} from '../../../../src/features/refactor/clone-declaration/clone-localization';
import { insertEditsForFile } from '../../../../src/features/diagnostics/localization-key-insert';
import { parseText } from '../../../../src/utils/ast.utils';
import { FIXTURES_DIR } from '../../../helpers';

// The half of the clone that names the copy's strings and writes them into the destination mod.
const FIXTURE = join(FIXTURES_DIR, 'clone-declaration-mod').replace(/\\/g, '/');
const STRINGS = `${FIXTURE}/mod/strings`;
const nothing = new Set<string>();

describe('naming the copy key', () => {
    it('swaps the entity name inside the key and keeps everything around it', () => {
        expect(deriveCloneKey('Parts/CannonMed', 'cosmoteer.cannon_med', 'me.cannon_big', nothing)).toBe(
            'Parts/CannonBig'
        );
        expect(deriveCloneKey('Parts/CannonMedDesc', 'cosmoteer.cannon_med', 'me.cannon_big', nothing)).toBe(
            'Parts/CannonBigDesc'
        );
        expect(deriveCloneKey('Lore/Cabal/Title', 'cabal', 'trader', nothing)).toBe('Lore/Trader/Title');
    });

    it('reads a key written with the id spelling as well as the PascalCase one', () => {
        expect(deriveCloneKey('Parts/cannon_med', 'cosmoteer.cannon_med', 'me.cannon_big', nothing)).toBe(
            'Parts/cannon_big'
        );
    });

    it('leaves a key that names no entity of its own pointing where it points', () => {
        // Every codex page writes the same tab name, so a fresh key for it would only leave the copy
        // showing nothing where the game shows the tab.
        expect(deriveCloneKey('Codex/Lore', 'cabal', 'trader', nothing)).toBeUndefined();
        // A name only counts when it stands as a name, so a two-letter id never claims a longer word.
        expect(deriveCloneKey('Parts/Ion', 'io', 'io_two', nothing)).toBeUndefined();
    });

    it('counts up rather than pointing at somebody else s string', () => {
        expect(deriveCloneKey('Parts/Cannon', 'cannon', 'big', new Set(['parts/big']))).toBe('Parts/Big2');
    });
});

describe('the text a language file gets', () => {
    it('matches the destination file by its own name and falls back to English', () => {
        const texts = [
            { language: 'English', text: 'Medium Cannon' },
            { language: 'Deutsch', text: 'Mittlere Kanone' },
        ];
        expect(textForStringsFile(`${STRINGS}/deutsch.rules`, texts)).toBe('"Mittlere Kanone"');
        expect(textForStringsFile(`${STRINGS}/english.rules`, texts)).toBe('"Medium Cannon"');
        expect(textForStringsFile(`${STRINGS}/french.rules`, texts)).toBe('"Medium Cannon"');
    });

    it('leaves a placeholder when the key has no text anywhere, rather than inventing one', () => {
        expect(textForStringsFile(`${STRINGS}/english.rules`, [])).toBe('""');
    });
});

describe('declaring several keys in one strings file', () => {
    const text = 'Parts\n{\n\tMine = "My Part"\n}\n';
    const document = (): ReturnType<typeof parseText> => parseText(text, 'strings.rules');

    it('writes every key that lands in one group as a single edit', () => {
        const edits = insertEditsForFile(document(), text, [
            { key: 'Parts/One', value: '"One"' },
            { key: 'Parts/Two', value: '"Two"' },
            { key: 'Parts/Three', value: '"Three"' },
        ]);
        expect(edits).toHaveLength(1);
        expect(edits[0].newText).toBe('\tOne = "One"\n\tTwo = "Two"\n\tThree = "Three"\n');
    });

    it('writes a missing group once however many keys go into it', () => {
        const edits = insertEditsForFile(document(), text, [
            { key: 'Stats/One', value: '"One"' },
            { key: 'Stats/Two', value: '"Two"' },
        ]);
        expect(edits).toHaveLength(1);
        expect(edits[0].newText).toBe('Stats\n{\n\tOne = "One"\n\tTwo = "Two"\n}\n');
    });

    it('adds nothing for a key the file already declares, and nothing twice for a repeated key', () => {
        expect(insertEditsForFile(document(), text, [{ key: 'Parts/Mine', value: '"x"' }])).toEqual([]);
        const edits = insertEditsForFile(document(), text, [
            { key: 'Parts/One', value: '"One"' },
            { key: 'Parts/One', value: '"Again"' },
        ]);
        expect(edits[0].newText).toBe('\tOne = "One"\n');
    });
});

describe('writing the keys into the destination mod', () => {
    it('reaches every language file and writes one edit each for the whole batch', async () => {
        const inserts = await stringsInsertsFor(
            [`${STRINGS}/english.rules`, `${STRINGS}/deutsch.rules`, `${STRINGS}/french.rules`],
            [
                { newKey: 'Parts/BigCannon', texts: [{ language: 'English', text: 'Big Cannon' }] },
                { newKey: 'Parts/BigCannonDesc', texts: [] },
            ]
        );
        expect(inserts.map((insert) => insert.fsPath.split('/').pop())).toEqual([
            'english.rules',
            'deutsch.rules',
            'french.rules',
        ]);
        for (const insert of inserts) expect(insert.edits).toHaveLength(1);
        expect(inserts[0].edits[0].newText).toBe('\tBigCannon = "Big Cannon"\n\tBigCannonDesc = ""\n');
    });

    it('does nothing at all when the copy declares no key', async () => {
        expect(await stringsInsertsFor([`${STRINGS}/english.rules`], [])).toEqual([]);
    });
});
