import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
    rebaseUnitFile,
    rebaseUnitPath,
    scanSpans,
    UnitRebaseContext,
} from '../../../../src/features/refactor/clone-declaration/unit-rebase';
import { foldPathCase } from '../../../../src/workspace/fs-cache';
import { FIXTURES_DIR } from '../../../helpers';

// The half of the clone that decides where a copied file's paths point afterwards. This is where a
// naive reuse of the shared-base rebaser would go wrong, so every case it has to tell apart is here.
const FIXTURE = join(FIXTURES_DIR, 'clone-declaration-mod').replace(/\\/g, '/');
const DATA = `${FIXTURE}/Data`;
const CANNON_DIR = `${DATA}/ships/terran/cannon`;
const CANNON = `${CANNON_DIR}/cannon.rules`;
const MOD = `${FIXTURE}/mod`;
const INTO_MOD = `${MOD}/ships/terran/big_cannon`;

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The unit map of a whole-directory copy: every file of the source folder, keyed the way a lookup is. */
const unitMap = (from: string, to: string, names: readonly string[]): Map<string, string> => {
    const map = new Map<string, string>();
    for (const name of names) map.set(foldPathCase(`${from}/${name}`), `${to}/${name}`);
    return map;
};

const CANNON_FILES = ['cannon.rules', 'icon.png', 'upgrade.rules', 'particles/smoke.rules'];

/** The cannon folder copied into the fixture mod, which is the vanilla-into-a-mod case. */
const intoMod = (fileFrom = CANNON_DIR, fileTo = INTO_MOD): UnitRebaseContext => ({
    sourceDir: fileFrom,
    destinationDir: fileTo,
    unit: unitMap(CANNON_DIR, INTO_MOD, CANNON_FILES),
    dataRoot: DATA,
    destinationRoot: MOD,
});

/** The cannon folder copied to a sibling of itself, which is the same-tree case. */
const beside = (): UnitRebaseContext => ({
    sourceDir: CANNON_DIR,
    destinationDir: `${DATA}/ships/terran/big_cannon`,
    unit: unitMap(CANNON_DIR, `${DATA}/ships/terran/big_cannon`, CANNON_FILES),
    dataRoot: undefined,
    destinationRoot: DATA,
});

describe('rebasing one path', () => {
    it('maps a target inside the copy unit to the copy, never back to the original', () => {
        expect(rebaseUnitPath('icon.png', intoMod())).toEqual({ newText: 'icon.png' });
        // The particle fragment sits a folder deeper and reads the icon through a hop, which has to
        // land on the copy's own icon rather than on the source part's.
        const deeper = intoMod(`${CANNON_DIR}/particles`, `${INTO_MOD}/particles`);
        expect(rebaseUnitPath('../icon.png', deeper)).toEqual({ newText: '../icon.png' });
    });

    it('writes a target inside the game install as a game-root path rather than as a hop chain', () => {
        expect(rebaseUnitPath('../base_part.rules', intoMod())).toEqual({
            newText: './Data/ships/terran/base_part.rules',
        });
        expect(rebaseUnitPath('../shared/shared_icon.png', intoMod())).toEqual({
            newText: './Data/ships/terran/shared/shared_icon.png',
        });
    });

    it('carries a path that already starts at the game root over untouched', () => {
        expect(rebaseUnitPath('./Data/statuses/heat/heat.rules', intoMod())).toEqual({
            newText: './Data/statuses/heat/heat.rules',
        });
    });

    it('rewrites nothing at all for a copy beside the source', () => {
        expect(rebaseUnitPath('icon.png', beside())).toEqual({ newText: 'icon.png' });
        expect(rebaseUnitPath('../base_part.rules', beside())).toEqual({ newText: '../base_part.rules' });
    });

    it('refuses a path that resolves to nothing rather than guessing where it should point', () => {
        expect(rebaseUnitPath('gone.png', intoMod())).toEqual({ refusal: 'unresolvablePath' });
    });

    it('refuses a path that would have to climb out of the destination mod', () => {
        const escaping: UnitRebaseContext = {
            sourceDir: `${DATA}/ships/terran/escape`,
            destinationDir: `${MOD}/ships/terran/escape`,
            unit: new Map(),
            dataRoot: DATA,
            destinationRoot: MOD,
        };
        expect(rebaseUnitPath('../../../../outside/thing.png', escaping)).toEqual({ refusal: 'escapingPath' });
    });

    it('never writes a drive letter or an absolute path into a mod', () => {
        for (const path of ['icon.png', '../base_part.rules', '../shared/shared_icon.png']) {
            const rebased = rebaseUnitPath(path, intoMod());
            expect('newText' in rebased).toBe(true);
            if ('newText' in rebased) expect(rebased.newText).not.toMatch(/^[A-Za-z]:|^\//);
        }
    });
});

describe('reading a copied file', () => {
    it('finds comments and references without mistaking a slash inside a quoted path for one', () => {
        const text = 'A = "http://x/y.png" // a comment with <not/a.rules>\nB = <c.rules>\n/* block */\n';
        const { comments, references } = scanSpans(text);
        expect(comments).toHaveLength(2);
        expect(references.map((span) => text.slice(span.innerStart, span.innerEnd))).toEqual(['c.rules']);
    });

    it('leaves scope-relative references alone rather than refusing the copy over them', () => {
        // `~`, `^`, `:` and a bare `&Name` all resolve against the copy itself, so a verbatim copy
        // keeps their meaning. This is exactly where the clone parts company with the shared-base
        // extraction, which refuses a member carrying any of them.
        const text = 'EXTRA = (&~/Part/MaxHealth) * 2\nX : ^/0/Y\nZ = &SOME_CONSTANT\nW = &A:B\n';
        expect(rebaseUnitFile(text, intoMod())).toEqual({ rebases: [] });
    });

    it('rewrites every path of a real part file and leaves everything else exactly as written', () => {
        const text = read(CANNON);
        const rebased = rebaseUnitFile(text, intoMod());
        expect('rebases' in rebased).toBe(true);
        if (!('rebases' in rebased)) return;
        let out = text;
        for (const rebase of [...rebased.rebases].sort((a, b) => b.start - a.start)) {
            out = out.slice(0, rebase.start) + rebase.newText + out.slice(rebase.end);
        }
        expect(out).toContain('Part : <./Data/ships/terran/base_part.rules>/Part');
        expect(out).toContain('File = "./Data/ships/terran/shared/shared_icon.png"');
        expect(out).toContain('File = "icon.png"');
        expect(out).toContain('&<./Data/statuses/heat/heat.rules>/STATUS_TO_RESOURCE_RATIO');
        expect(out).toContain('EXTRA = (&~/Part/MaxHealth) * 2');
        // The id and the comment that follows it are not paths and are left completely alone.
        expect(out).toContain('ID = cosmoteer.cannon // Part IDs must always be in the form of');
    });

    it('refuses the whole copy when one path in the file resolves to nothing', () => {
        const broken = `${DATA}/ships/terran/broken`;
        const context: UnitRebaseContext = {
            sourceDir: broken,
            destinationDir: `${MOD}/ships/terran/broken`,
            unit: new Map(),
            dataRoot: DATA,
            destinationRoot: MOD,
        };
        expect(rebaseUnitFile(read(`${broken}/broken.rules`), context)).toEqual({
            refusal: 'unresolvablePath',
            path: 'gone.png',
        });
    });
});
