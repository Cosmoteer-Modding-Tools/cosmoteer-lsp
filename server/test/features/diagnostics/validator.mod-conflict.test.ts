import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { parseModActions } from '../../../src/mod/action-parser';
import {
    ModClaims,
    claimsOf,
    manifestActionsWithFragments,
    otherMods,
} from '../../../src/features/diagnostics/validator.mod-conflict';

/** The claims one manifest's actions make, which is what two mods are compared by. */
const claims = (actions: string): string[] => {
    const manifest = ['ID = test.mod', 'Name = "t"', 'Actions', '[', actions, ']', ''].join('\n');
    const document = parser(lexer(manifest), 'file:///mod.rules').value;
    return parseModActions(document).flatMap((action) => claimsOf(action).map((claim) => claim.key));
};

// The game applies every enabled mod in ordinal order of its manifest id, and the last writer of a
// node is the one that stands. Which node that is depends on the verb: a replace takes the whole
// node, an override merges member by member.
describe('what an action takes for itself', () => {
    it('is the whole node for a replace', () => {
        expect(claims('\t{ Action = Replace; Replace = "<parts/armor.rules>/Part/MaxHealth"; With = 200 }')).toEqual([
            '<./data/parts/armor.rules>/part/maxhealth',
        ]);
    });

    it('is every named path for a removal of several nodes', () => {
        expect(
            claims('\t{ Action = RemoveMany; RemoveMany [ "<a.rules>/One", "<a.rules>/Two" ] }')
        ).toEqual(['<./data/a.rules>/one', '<./data/a.rules>/two']);
    });

    it('is the members an override writes, not the group it merges into', () => {
        expect(
            claims('\t{ Action = Overrides; OverrideIn = "<a.rules>/Part"; Overrides { MaxHealth = 5; Density = 2 } }')
        ).toEqual(['<./data/a.rules>/part/maxhealth', '<./data/a.rules>/part/density']);
    });

    it('reaches into a nested group, since the merge does too', () => {
        expect(
            claims('\t{ Action = Overrides; OverrideIn = "<a.rules>/Part"; Overrides { Components { engine { Thrust = 5 } } } }')
        ).toEqual(['<./data/a.rules>/part/components/engine/thrust']);
    });

    it('stops at a list, which an override replaces whole rather than merging into', () => {
        expect(
            claims('\t{ Action = Overrides; OverrideIn = "<a.rules>/Part"; Overrides { TypeCategories [ weapon ] } }')
        ).toEqual(['<./data/a.rules>/part/typecategories']);
    });

    it('is nothing for an override whose source is a reference, whose members cannot be read here', () => {
        expect(claims('\t{ Action = Overrides; OverrideIn = "<a.rules>/Part"; Overrides = &<mine.rules>/Part }')).toEqual(
            []
        );
    });

    it('is nothing for a verb that only adds', () => {
        expect(claims('\t{ Action = Add; AddTo = "<a.rules>/Parts"; Name = Mine; ToAdd { MaxHealth = 5 } }')).toEqual([]);
    });
});

/** An installed mod with one claim, which is all the comparison reads. */
const installedMod = (root: string, id: string): ModClaims => ({
    root,
    id,
    name: id,
    claims: new Map([['<./data/a.rules>/part/maxhealth', 'Overrides' as const]]),
});

// A mod is edited in one folder and loaded from another often enough that comparing an installed
// mod against the one being edited has to recognize the mod itself, or it reports the author's own
// work back at them as somebody else's.
describe('which installed mods a manifest is compared against', () => {
    it('leaves out the folder being edited, spelled either way', () => {
        const installed = [installedMod('C:\\Mods\\Mine', 'test.mine')];
        expect(otherMods(installed, 'c:/mods/mine', 'test.mine')).toEqual([]);
    });

    it('leaves out the subscribed copy of the same mod, which carries the same id', () => {
        const installed = [installedMod('C:/workshop/799600/123', 'test.mine')];
        expect(otherMods(installed, 'c:/mods/mine', 'test.mine')).toEqual([]);
    });

    it("keeps a mod that is somebody else's", () => {
        const installed = [installedMod('C:/workshop/799600/123', 'other.mod')];
        expect(otherMods(installed, 'c:/mods/mine', 'test.mine')).toHaveLength(1);
    });
});

// A manifest can keep its whole registration in an included fragment (`Actions : &<launcher.rules>/Actions`),
// which the game concatenates in front of the local entries. A reader of the manifest alone sees
// such a mod claim nothing, so it would silently never conflict with anybody.
describe('an Actions list that comes from an included fragment', () => {
    let root = '';

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'modconflict-')).split('\\').join('/');
    });

    afterEach(() => {
        if (root) rmSync(root, { recursive: true, force: true });
    });

    /** Parses the manifest written into the scratch mod and reads the actions the game would see. */
    const actionsOf = async (manifest: string, fragments: Record<string, string>): Promise<string[]> => {
        writeFileSync(join(root, 'mod.rules'), manifest, 'utf8');
        for (const [name, text] of Object.entries(fragments)) writeFileSync(join(root, name), text, 'utf8');
        const path = join(root, 'mod.rules');
        const document = parser(lexer(manifest), pathToFileURL(path).href).value;
        const actions = await manifestActionsWithFragments(path, document);
        return actions.flatMap((action) => claimsOf(action).map((claim) => claim.key));
    };

    it('reads the fragment the list inherits from', async () => {
        const manifest = ['ID = test.mod', 'Name = "t"', 'Actions : &<launcher.rules>/Actions', '[', ']', ''].join('\n');
        const fragment = [
            'Actions',
            '[',
            '\t{ Action = Replace; Replace = "<a.rules>/Part/MaxHealth"; With = 200 }',
            ']',
            '',
        ].join('\n');
        expect(await actionsOf(manifest, { 'launcher.rules': fragment })).toEqual(['<./data/a.rules>/part/maxhealth']);
    });

    it('keeps the entries the manifest writes itself beside the inherited ones', async () => {
        const manifest = [
            'ID = test.mod',
            'Name = "t"',
            'Actions : &<launcher.rules>/Actions',
            '[',
            '\t{ Action = Remove; Remove = "<b.rules>/Part" }',
            ']',
            '',
        ].join('\n');
        const fragment = [
            'Actions',
            '[',
            '\t{ Action = Replace; Replace = "<a.rules>/Part/MaxHealth"; With = 200 }',
            ']',
            '',
        ].join('\n');
        expect((await actionsOf(manifest, { 'launcher.rules': fragment })).sort()).toEqual([
            '<./data/a.rules>/part/maxhealth',
            '<./data/b.rules>/part',
        ]);
    });

    it('reads a list the reference names by something other than Actions', async () => {
        const manifest = ['ID = test.mod', 'Name = "t"', 'Actions : &<list.rules>/Extra', '[', ']', ''].join('\n');
        const fragment = ['Extra', '[', '\t{ Action = Remove; Remove = "<c.rules>/Part" }', ']', ''].join('\n');
        expect(await actionsOf(manifest, { 'list.rules': fragment })).toEqual(['<./data/c.rules>/part']);
    });

    it('answers with the local entries when the fragment is not on disk', async () => {
        const manifest = [
            'ID = test.mod',
            'Name = "t"',
            'Actions : &<missing.rules>/Actions',
            '[',
            '\t{ Action = Remove; Remove = "<b.rules>/Part" }',
            ']',
            '',
        ].join('\n');
        expect(await actionsOf(manifest, {})).toEqual(['<./data/b.rules>/part']);
    });
});
