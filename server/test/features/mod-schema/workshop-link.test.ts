import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { workshopLinkFor, workshopModOf } from '../../../src/features/mod-schema/workshop-link';

// A subscribed mod's published file id is the folder Steam unpacked it into, which is the only place
// the id is recorded on disk. The hover footer for a mod class is built from it, so the path parse
// and the manifest read are pinned here.

describe('workshopModOf', () => {
    it('reads the published id and the mod root out of an unpacked path', () => {
        const result = workshopModOf(
            'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600/3768401176/CosmoteerDrone.dll'
        );
        expect(result?.id).toBe('3768401176');
        expect(result?.root).toBe('C:/Program Files (x86)/Steam/steamapps/workshop/content/799600/3768401176');
    });

    it('reads it through backslashes and a nested assembly folder', () => {
        const result = workshopModOf(
            'D:\\SteamLibrary\\steamapps\\workshop\\content\\799600\\123\\bin\\Release\\Mod.dll'
        );
        expect(result?.id).toBe('123');
        expect(result?.root).toBe('D:/SteamLibrary/steamapps/workshop/content/799600/123');
    });

    it('does not confuse the app id for the published id', () => {
        expect(workshopModOf('/steam/workshop/content/799600/799600/Mod.dll')?.root).toBe(
            '/steam/workshop/content/799600/799600'
        );
    });

    it('yields nothing for a mod being developed locally', () => {
        expect(workshopModOf('C:/Users/me/Projects/MyMod/bin/Release/MyMod.dll')).toBeUndefined();
        expect(workshopModOf('C:/steamapps/workshop/content/12345/9/Other.dll')).toBeUndefined();
    });
});

describe('workshopLinkFor', () => {
    /** An unpacked workshop mod with a manifest, under a temp Steam-shaped path. */
    const stageMod = (id: string, manifest?: string): string => {
        const root = join(tmpdir(), 'cosmoteer-workshop-link', 'steamapps', 'workshop', 'content', '799600', id);
        mkdirSync(root, { recursive: true });
        if (manifest !== undefined) writeFileSync(join(root, 'mod.rules'), manifest, 'utf8');
        return join(root, 'Mod.dll');
    };

    it("builds the mod's workshop url and takes its name from the manifest", async () => {
        const dll = stageMod('4001', 'ID = "XCeled.DroneTender"\nName = "Drone Tender"\nVersion = "0.30.2"\n');
        expect(await workshopLinkFor(dll)).toEqual({
            url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=4001',
            name: 'Drone Tender',
        });
    });

    it('unescapes a quoted name', async () => {
        const dll = stageMod('4002', 'Name = "The \\"Big\\" Mod"\n');
        expect((await workshopLinkFor(dll))?.name).toBe('The "Big" Mod');
    });

    it('still links the page when the manifest has no name, or none is readable', async () => {
        const noName = stageMod('4003', 'ID = "x"\n');
        expect(await workshopLinkFor(noName)).toEqual({
            url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=4003',
        });
        const noManifest = stageMod('4004');
        expect(await workshopLinkFor(noManifest)).toEqual({
            url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=4004',
        });
    });

    it('yields nothing outside the workshop tree', async () => {
        expect(await workshopLinkFor('C:/Users/me/Projects/MyMod/MyMod.dll')).toBeUndefined();
    });
});
