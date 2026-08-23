import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import {
    buildClonePlan,
    ClonePlan,
    ClonePlanContext,
    ClonePlanResult,
} from '../../../../src/features/refactor/clone-declaration/clone-plan';
import { locateCloneTarget } from '../../../../src/features/refactor/clone-declaration/clone-target';
import { LocalizationText } from '../../../../src/features/completion/localization-key.index';
import { clearModRootCache } from '../../../../src/mod/mod-root';
import { globalSettings } from '../../../../src/settings';
import { parseText } from '../../../../src/utils/ast.utils';
import { FIXTURES_DIR } from '../../../helpers';

// The plan itself: what the copy would hold, which slots it rewrites, which it leaves alone, and
// every refusal that needs a destination to be decided. Nothing here writes to disk.
const FIXTURE = join(FIXTURES_DIR, 'clone-declaration-mod').replace(/\\/g, '/');
const DATA = `${FIXTURE}/Data`;
const MOD = `${FIXTURE}/mod`;
const OTHER_MOD = `${FIXTURE}/othermod`;
const CANNON = `${DATA}/ships/terran/cannon/cannon.rules`;
const WALL = `${DATA}/ships/terran/walls/wall.rules`;
const CREW = `${DATA}/ships/terran/prefix/crew.rules`;
const BROKEN = `${DATA}/ships/terran/broken/broken.rules`;
const ESCAPE = `${DATA}/ships/terran/escape/escape.rules`;
const LORE = `${DATA}/codex/lore/lore_cabal.rules`;
const MOD_FACTIONS = `${MOD}/factions/factions_mod.rules`;
const MINE = `${MOD}/parts/mine/mine.rules`;
const EMITTER = `${DATA}/ships/terran/txtfragment/emitter.rules`;
const PROBE = `${DATA}/ships/terran/txtnotes/probe.rules`;
const BEACON = `${DATA}/ships/terran/txtstale/beacon.rules`;

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The texts the fixture's stand-in project holds for the cannon's keys. */
const TEXTS: Record<string, LocalizationText[]> = {
    'Parts/Cannon': [
        { language: 'English', text: 'Medium Cannon' },
        { language: 'Deutsch', text: 'Mittlere Kanone' },
    ],
    'Parts/CannonDesc': [{ language: 'English', text: 'Fires cannon shells.' }],
};

const context = (over: Partial<ClonePlanContext> = {}): ClonePlanContext => ({
    folderPaths: [MOD],
    dataRoot: DATA,
    declaredIds: async () => new Set<string>(),
    declaredKeys: async () => new Set<string>(),
    localizationTexts: async (key) => TEXTS[key] ?? [],
    modRootsUnder: () => [MOD],
    ...over,
});

/** Build a plan for the declaration at the first occurrence of `at` in a fixture file. */
const plan = async (
    path: string,
    at: string,
    newId: string,
    over: Partial<ClonePlanContext> = {},
    destinationDir?: string
): Promise<ClonePlanResult> => {
    const text = read(path);
    const document = parseText(text, path);
    const located = await locateCloneTarget(document, text.indexOf(at), path, `file:///${path}`, CancellationToken.None);
    if ('refusal' in located) throw new Error(`the fixture did not anchor: ${located.refusal}`);
    return await buildClonePlan(
        located.target,
        text,
        document,
        { newId, destinationDir },
        context(over),
        CancellationToken.None
    );
};

/** The built plan, asserting the build succeeded. */
const planOf = (result: ClonePlanResult): ClonePlan => {
    if ('failure' in result) throw new Error(`expected a plan, got the failure "${result.failure}"`);
    return result.plan;
};

/** The copy's text for one of the plan's files, found by the name it lands under. */
const copyOf = (built: ClonePlan, endsWith: string): string => {
    const file = built.files.find((entry) => entry.destination.endsWith(endsWith));
    if (!file?.text) throw new Error(`the plan writes no text for ${endsWith}`);
    return file.text;
};

let wasAllowed: boolean;

beforeEach(() => {
    clearModRootCache();
    wasAllowed = globalSettings.allowEditingVanillaFiles;
    globalSettings.allowEditingVanillaFiles = false;
});

afterEach(() => {
    globalSettings.allowEditingVanillaFiles = wasAllowed;
    clearModRootCache();
});

describe('cloning a part folder out of the game install', () => {
    it('lands under the same subpath in the one mod of the workspace', async () => {
        const built = planOf(await plan(CANNON, 'cosmoteer.cannon', 'me.big_cannon'));
        expect(built.destinationDir).toBe(`${MOD}/ships/terran/big_cannon`);
        expect(built.unit).toBe('directory');
        expect(built.files.map((file) => file.destination.slice(built.destinationDir.length + 1)).sort()).toEqual([
            'big_cannon.rules',
            'icon.png',
            'particles/smoke.rules',
            'upgrade.rules',
        ]);
        // The sprite comes along byte for byte, which is the whole reason the folder is the unit.
        expect(built.files.find((file) => file.destination.endsWith('icon.png'))?.text).toBeUndefined();
    });

    it('rewrites the id, drops the aliases, repoints the keys and re-expresses every path', async () => {
        const built = planOf(await plan(CANNON, 'cosmoteer.cannon', 'me.big_cannon'));
        const copy = copyOf(built, 'big_cannon.rules');
        expect(copy).toContain('ID = me.big_cannon // Part IDs must always be in the form of');
        expect(copy).not.toContain('OtherIDs');
        expect(built.droppedOtherIds).toEqual(['[old_cannon]']);
        expect(copy).toContain('NameKey = "Parts/BigCannon"');
        expect(copy).toContain('IconNameKey = "Parts/BigCannonIcon"');
        expect(copy).toContain('DescriptionKey = "Parts/BigCannonDesc"');
        expect(copy).toContain('Part : <./Data/ships/terran/base_part.rules>/Part');
        expect(copy).toContain('File = "./Data/ships/terran/shared/shared_icon.png"');
        expect(copy).toContain('File = "icon.png"');
        expect(copy).toContain('&<./Data/statuses/heat/heat.rules>/STATUS_TO_RESOURCE_RATIO');
        // Shared vocabularies many parts write on purpose are not ids and are copied unchanged.
        expect(copy).toContain('EditorGroup = "WeaponsProjectile"');
        expect(copy).toContain('SelectionTypeID = "cannons"');
        expect(copy).toContain('TypeCategories = [weapon, uses_ammo]');
    });

    it('rebases the references of a txt rules fragment the folder carries', async () => {
        const built = planOf(await plan(EMITTER, 'cosmoteer.emitter', 'me.big_emitter'));
        const copy = copyOf(built, 'effect.txt');
        expect(copy).toContain('&<./Data/ships/terran/base_part.rules>/Part/MaxHealth');
        expect(copy).toContain('File = "./Data/ships/terran/shared/shared_icon.png"');
    });

    it('carries a txt whose path names nothing on disk byte for byte, rather than refusing the clone', async () => {
        const built = planOf(await plan(BEACON, 'cosmoteer.beacon', 'me.big_beacon'));
        expect(built.files.find((file) => file.destination.endsWith('changes.txt'))?.text).toBeUndefined();
        expect(copyOf(built, 'big_beacon.rules')).toContain('ID = me.big_beacon');
    });

    it('carries prose the parser refuses byte for byte, so a note cannot block the clone', async () => {
        const built = planOf(await plan(PROBE, 'cosmoteer.probe', 'me.big_probe'));
        expect(built.unit).toBe('directory');
        expect(built.files.find((file) => file.destination.endsWith('notes.txt'))?.text).toBeUndefined();
    });

    it('rewrites a reference whose casing differs from the declaration, the way the game reads it', async () => {
        const built = planOf(await plan(CANNON, 'cosmoteer.cannon', 'me.big_cannon'));
        const upgrade = copyOf(built, 'upgrade.rules');
        expect(upgrade).toContain('EditorParentParts = [me.big_cannon]');
        // The declaring file is renamed with the folder, so the sibling that inherits it follows.
        expect(upgrade).toContain('Part : <big_cannon.rules>/Part');
    });

    it('never writes a path that climbs back into the install folder', async () => {
        const built = planOf(await plan(CANNON, 'cosmoteer.cannon', 'me.big_cannon'));
        for (const file of built.files) {
            if (!file.text) continue;
            expect(file.text).not.toMatch(/[A-Za-z]:[\\/]/);
            expect(file.text).not.toContain('../../..');
        }
    });
});

describe('what a clone must never touch', () => {
    it('leaves an id that merely starts with the cloned one exactly where it is', async () => {
        const built = planOf(await plan(CREW, 'cosmoteer.crew\n', 'me.crew_new'));
        const copy = copyOf(built, 'crew_new.rules');
        expect(copy).toContain('ID = me.crew_new');
        expect(copy).toContain('EditorParentParts = [cosmoteer.crew2]');
    });

    it('rewrites an id in an id slot and leaves the same text alone everywhere else', async () => {
        const built = planOf(await plan(LORE, 'cabal', 'me.cabal_two', {}, `${MOD}/codex/lore`));
        const copy = copyOf(built, 'cabal_two.rules');
        expect(copy).toContain('ID = me.cabal_two');
        // The id is written again inside a game-root asset path, which is not an id slot.
        expect(copy).toContain('File = "./Data/factions/cabal.png"');
    });
});

describe('cloning a collection element', () => {
    it('writes the copy back into the same list rather than into a file of its own', async () => {
        const built = planOf(await plan(MOD_FACTIONS, 'test.first', 'test.second'));
        expect(built.unit).toBe('listElement');
        expect(built.files).toHaveLength(1);
        expect(built.files[0].destination).toBe(built.files[0].source);
        const copy = built.files[0].text!;
        expect(copy).toContain('ID = test.first');
        expect(copy).toContain('ID = test.second');
        // The copy is the second element, and it is the copy that leaves the aliases behind.
        expect(copy.match(/OtherIDs/g)).toHaveLength(1);
        expect(built.droppedOtherIds).toEqual(['[old_first]']);
        expect(copy).toContain('NameKey = "Factions/Second"');
        // The copy sits in the same folder, so its own art needs no rewriting at all.
        expect(copy.match(/File = "first.png"/g)).toHaveLength(2);
    });
});

describe('the localization keys the copy declares', () => {
    it('derives a key per key field and writes the source text into every language file', async () => {
        const built = planOf(await plan(CANNON, 'cosmoteer.cannon', 'me.big_cannon'));
        expect(built.keys.map((key) => `${key.sourceKey} -> ${key.newKey}`)).toEqual([
            'Parts/Cannon -> Parts/BigCannon',
            'Parts/CannonIcon -> Parts/BigCannonIcon',
            'Parts/CannonDesc -> Parts/BigCannonDesc',
        ]);
        const byName = new Map(built.stringsFiles.map((file) => [file.fsPath.split('/').pop(), file]));
        expect([...byName.keys()].sort()).toEqual(['deutsch.rules', 'english.rules', 'french.rules']);
        // Three keys sharing one group become one edit per file, not three.
        for (const file of built.stringsFiles) expect(file.edits).toHaveLength(1);
        expect(byName.get('english.rules')!.edits[0].newText).toContain('BigCannon = "Medium Cannon"');
        expect(byName.get('deutsch.rules')!.edits[0].newText).toContain('BigCannon = "Mittlere Kanone"');
        // A language the source has no text for gets the English text, not an empty entry.
        expect(byName.get('french.rules')!.edits[0].newText).toContain('BigCannon = "Medium Cannon"');
        // A key nothing declares anywhere leaves a placeholder rather than an invented string.
        expect(byName.get('english.rules')!.edits[0].newText).toContain('BigCannonIcon = ""');
    });

    it('never takes a key path something already declares', async () => {
        const built = planOf(
            await plan(CANNON, 'cosmoteer.cannon', 'me.big_cannon', {
                declaredKeys: async () => new Set(['parts/bigcannon']),
            })
        );
        expect(built.keys[0].newKey).toBe('Parts/BigCannon2');
    });
});

describe('the refusals a destination decides', () => {
    it('refuses an id that is not spelled the way an id is', async () => {
        expect(await plan(CANNON, 'cosmoteer.cannon', 'me big cannon')).toEqual({ failure: 'invalidId' });
    });

    it('refuses an id that only differs from the source in case, which the game reads as the same id', async () => {
        expect(await plan(CANNON, 'cosmoteer.cannon', 'Cosmoteer.Cannon')).toEqual({ failure: 'idUnchanged' });
    });

    it('refuses an id something already declares, matched the way the game matches ids', async () => {
        expect(
            await plan(CANNON, 'cosmoteer.cannon', 'me.big_cannon', {
                declaredIds: async () => new Set(['ME.BIG_CANNON']),
            })
        ).toEqual({ failure: 'idTaken' });
    });

    it('refuses a destination that is not a mod the user may edit', async () => {
        expect(await plan(CANNON, 'cosmoteer.cannon', 'me.big_cannon', {}, `${DATA}/ships/terran/big_cannon`)).toEqual({
            failure: 'notEditable',
        });
    });

    it('asks which mod the copy joins when the workspace holds more than one', async () => {
        const result = await plan(CANNON, 'cosmoteer.cannon', 'me.big_cannon', {
            folderPaths: [MOD, OTHER_MOD],
            modRootsUnder: (folder) => [folder],
        });
        expect(result).toMatchObject({ failure: 'ambiguousDestination' });
        if ('failure' in result) expect(result.detail?.slice().sort()).toEqual([MOD, OTHER_MOD].sort());
    });

    it('refuses to write over something that is already there', async () => {
        expect(await plan(MINE, 'test.mine', 'test.taken')).toMatchObject({ failure: 'destinationExists' });
        expect(await plan(WALL, 'cosmoteer.wall', 'test.keep', {}, `${MOD}/parts/taken`)).toMatchObject({
            failure: 'destinationExists',
        });
    });

    it('refuses when a path in the copy resolves to nothing', async () => {
        const result = await plan(BROKEN, 'cosmoteer.broken', 'me.broken');
        expect(result).toMatchObject({ failure: 'unresolvablePath' });
        if ('failure' in result) expect(result.detail?.[0]).toBe('gone.png');
    });

    it('refuses when a path would have to climb out of the destination mod', async () => {
        expect(await plan(ESCAPE, 'cosmoteer.escape', 'me.escape')).toMatchObject({ failure: 'escapingPath' });
    });
});

describe('cloning inside the mod the user is already editing', () => {
    it('lands beside the source, where not one path has to be rewritten', async () => {
        const built = planOf(await plan(MINE, 'test.mine', 'test.mine_two'));
        expect(built.destinationDir).toBe(`${MOD}/parts/mine_two`);
        const copy = copyOf(built, 'mine_two.rules');
        expect(copy).toContain('ID = test.mine_two');
        expect(copy).toContain('File = "icon.png"');
        expect(copy).toContain('NameKey = "Parts/MineTwo"');
    });
});
