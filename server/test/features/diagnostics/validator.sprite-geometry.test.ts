import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { validateSpriteGeometry } from '../../../src/features/diagnostics/validator.sprite-geometry';
import { clearPngDimensionsCache } from '../../../src/utils/png-dimensions';
import { clearFsCaches } from '../../../src/workspace/fs-cache';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

const token = CancellationToken.None;

// The art the check reads is written next to the probe file rather than checked in, so the tests
// need no binary fixtures and no game install. Only the header is ever read, so a signature, an
// IHDR and an end marker are the whole file.
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable = Array.from({ length: 256 }, (_unused, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});

const crc32 = (bytes: Buffer): number => {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
    return Buffer.concat([header, data, crc]);
};

/** Writes a header-only PNG of the given pixel size. */
const writePng = (file: string, width: number, height: number): void => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // truecolour with alpha
    writeFileSync(file, Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]));
};

let probeDir = '';
let probeUri = '';

/** The findings a part document written next to the fixture art produces. */
const check = (source: string) => validateSpriteGeometry(parseText(source, probeUri), token);

const messages = async (source: string) => (await check(source)).map((error) => error.message);

/** A part whose graphics carry one sprite list, which is the shape the game data writes. */
const part = (levels: string): string =>
    `Part\n{\n\tID = probe.part\n\tComponents\n\t{\n\t\tGraphics\n\t\t{\n\t\t\tType = Graphics\n` +
    `\t\t\tFloor\n\t\t\t{\n\t\t\t\tLayer = "floors"\n\t\t\t\tDamageLevels\n\t\t\t\t[\n${levels}\n\t\t\t\t]\n` +
    `\t\t\t}\n\t\t}\n\t}\n}\n`;

/** A sprite entry, written the way the game data writes one. */
const level = (body: string): string => `\t\t\t\t\t{\n\t\t\t\t\t\t${body}\n\t\t\t\t\t}`;

// The game fills the quad a sprite names with the whole of its art, so nothing fixes how many
// pixels a tile holds. What one list of sprites keeps constant is how far that fill pulls the art,
// and an entry out of step with the rest is the one drawn distorted.
describe('validateSpriteGeometry', () => {
    beforeAll(() => {
        probeDir = mkdtempSync(join(tmpdir(), 'sprite-geometry-'));
        mkdirSync(join(probeDir, 'parts', 'probe'), { recursive: true });
        probeDir = join(probeDir, 'parts', 'probe');
        probeUri = filePathToUri(join(probeDir, 'probe.rules'));
        writePng(join(probeDir, 'square.png'), 64, 64);
        writePng(join(probeDir, 'wide.png'), 128, 64);
        writePng(join(probeDir, 'tall.png'), 64, 128);
        writePng(join(probeDir, 'big_square.png'), 256, 256);
        writePng(join(probeDir, 'square_double.png'), 128, 128);
        writePng(join(probeDir, 'tall_double.png'), 128, 256);
        writePng(join(probeDir, 'odd_tall.png'), 128, 255);
        clearFsCaches();
        clearPngDimensionsCache();
    });

    afterAll(() => {
        rmSync(join(probeDir, '..', '..'), { recursive: true, force: true });
    });

    it('flags a level whose art is stretched differently from the first one', async () => {
        // The XWing thruster shape: the same wide art drawn upright once the part takes damage.
        const found = await check(
            part(
                [
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [1, 2]'),
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [1, 2]'),
                ].join('\n')
            )
        );
        expect(found).toHaveLength(2);
        expect(found[0].severity).toBe('hint');
        expect(found[0].message).toContain('128 by 64 pixels');
        expect(found[0].message).toContain('[2, 1]');
        expect(found.map((error) => error.data?.quickFix?.newText)).toEqual(['[2, 1]', '[2, 1]']);
    });

    it('covers the written size with the finding, so the fix replaces it', async () => {
        const source = part(
            [
                level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                level('File = "wide.png"\n\t\t\t\t\t\tSize = [1, 2]'),
            ].join('\n')
        );
        const found = await validateSpriteGeometry(parseText(source, probeUri), token);
        expect(found).toHaveLength(1);
        expect(source.slice(found[0].node.position.start, found[0].node.position.end)).toBe('[1, 2]');
    });

    it('says nothing about the damaged art vanilla draws wider on purpose', async () => {
        // The chaingun shape: two upright levels and a square one, all at 64 pixels per tile.
        expect(
            await messages(
                part(
                    [
                        level('File = "tall.png"\n\t\t\t\t\t\tSize = [1, 2]'),
                        level('File = "tall.png"\n\t\t\t\t\t\tSize = [1, 2]'),
                        level('File = "square_double.png"\n\t\t\t\t\t\tSize = [2, 2]'),
                    ].join('\n')
                )
            )
        ).toEqual([]);
    });

    it('says nothing about a level drawn from larger art at the same proportions', async () => {
        // The sensor-array shape: a small glow and a large one, both filling four tiles by four.
        expect(
            await messages(
                part(
                    [
                        level('File = "square.png"\n\t\t\t\t\t\tSize = [4, 4]'),
                        level('File = "square.png"\n\t\t\t\t\t\tSize = [4, 4]'),
                        level('File = "big_square.png"\n\t\t\t\t\t\tSize = [4, 4]'),
                    ].join('\n')
                )
            )
        ).toEqual([]);
    });

    it('passes over a level that draws nothing', async () => {
        expect(
            await messages(
                part(
                    [
                        level('// None.'),
                        level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                        level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                    ].join('\n')
                )
            )
        ).toEqual([]);
    });

    it('reads a level that writes no size as one tile by one', async () => {
        expect(
            await messages(
                part([level('File = "square.png"\n\t\t\t\t\t\tSize = [1, 1]'), level('File = "square.png"')].join('\n'))
            )
        ).toEqual([]);
        const found = await check(
            part([level('File = "square.png"\n\t\t\t\t\t\tSize = [1, 1]'), level('File = "wide.png"')].join('\n'))
        );
        expect(found).toHaveLength(1);
        // Nothing is written to replace, so the finding covers the entry and carries no fix.
        expect(found[0].data).toBeUndefined();
    });

    it('reads an animation as the pixel size of its first frame', async () => {
        const found = await check(
            part(
                [
                    level('File = "square.png"\n\t\t\t\t\t\tSize = [1, 1]'),
                    level(
                        'AnimationFiles\n\t\t\t\t\t\t[\n\t\t\t\t\t\t\t"wide.png"\n\t\t\t\t\t\t\t"wide.png"\n\t\t\t\t\t\t]\n\t\t\t\t\t\tSize = [1, 1]'
                    ),
                ].join('\n')
            )
        );
        expect(found).toHaveLength(1);
        expect(found[0].message).toContain('128 by 64 pixels');
    });

    it('folds a quarter turn of the texture into the comparison', async () => {
        expect(
            await messages(
                part(
                    [
                        level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                        level('File = "wide.png"\n\t\t\t\t\t\tSize = [1, 2]\n\t\t\t\t\t\tUVRotation = 1'),
                    ].join('\n')
                )
            )
        ).toEqual([]);
    });

    it('names the art at the size the file itself has, turned or not', async () => {
        const found = await check(
            part(
                [
                    level('File = "square.png"\n\t\t\t\t\t\tSize = [1, 1]'),
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [1, 1]\n\t\t\t\t\t\tUVRotation = 1'),
                ].join('\n')
            )
        );
        expect(found).toHaveLength(1);
        expect(found[0].message).toContain('128 by 64 pixels');
        expect(found[0].data?.quickFix?.newText).toBe('[1, 2]');
    });

    it('tolerates art exported a pixel or two off', async () => {
        // The railgun-launcher shape: art one pixel short of its siblings, drawn at the same size.
        expect(
            await messages(
                part(
                    [
                        level('File = "tall_double.png"\n\t\t\t\t\t\tSize = [1, 2]'),
                        level('File = "odd_tall.png"\n\t\t\t\t\t\tSize = [1, 2]'),
                    ].join('\n')
                )
            )
        ).toEqual([]);
    });

    it('reads a size written as math', async () => {
        const found = await check(
            part(
                [
                    level('File = "square.png"\n\t\t\t\t\t\tSize = [64/64, 64/64]'),
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [64/64, 64/64]'),
                ].join('\n')
            )
        );
        expect(found).toHaveLength(1);
        expect(found[0].data?.quickFix?.newText).toBe('[2, 1]');
    });

    it('passes over a size the evaluator cannot finish', async () => {
        expect(
            await messages(
                part(
                    [
                        level('File = "square.png"\n\t\t\t\t\t\tSize = [1, 1]'),
                        level('File = "wide.png"\n\t\t\t\t\t\tSize = &MISSING_SIZE'),
                    ].join('\n')
                )
            )
        ).toEqual([]);
    });

    it('passes over an image named by a reference', async () => {
        expect(
            await messages(
                part(
                    [
                        level('File = "square.png"\n\t\t\t\t\t\tSize = [1, 1]'),
                        level('File = &SOME_TEXTURE\n\t\t\t\t\t\tSize = [4, 1]'),
                    ].join('\n')
                )
            )
        ).toEqual([]);
    });

    it('passes over an image that is not on disk, which the asset check reports already', async () => {
        expect(
            await messages(
                part(
                    [
                        level('File = "square.png"\n\t\t\t\t\t\tSize = [1, 1]'),
                        level('File = "not_there.png"\n\t\t\t\t\t\tSize = [4, 1]'),
                    ].join('\n')
                )
            )
        ).toEqual([]);
    });

    it('says nothing about a whole list written as a reference', async () => {
        expect(
            await messages(
                'Part\n{\n\tID = probe.part\n\tComponents\n\t{\n\t\tGraphics\n\t\t{\n\t\t\tType = Graphics\n' +
                    '\t\t\tFloor\n\t\t\t{\n\t\t\t\tDamageLevels = &/COMMON/Floors\n\t\t\t}\n\t\t}\n\t}\n}\n'
            )
        ).toEqual([]);
    });

    it('says nothing about a list that derives from another list', async () => {
        expect(
            await messages(
                'Part\n{\n\tID = probe.part\n\tComponents\n\t{\n\t\tGraphics\n\t\t{\n\t\t\tType = Graphics\n' +
                    '\t\t\tFloor\n\t\t\t{\n\t\t\t\tDamageLevels : ~/Shared\n\t\t\t\t[\n' +
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [1, 2]') +
                    '\n\t\t\t\t]\n\t\t\t}\n\t\t}\n\t}\n}\n'
            )
        ).toEqual([]);
    });

    it('reads a level through the base it derives from', async () => {
        const found = await check(
            'BaseTexture\n{\n\tFile = "wide.png"\n\tSize = [2, 1]\n}\n' +
                part(
                    [
                        level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                        `\t\t\t\t\t: ~/BaseTexture\n\t\t\t\t\t{\n\t\t\t\t\t\tSize = [1, 2]\n\t\t\t\t\t}`,
                    ].join('\n')
                )
        );
        expect(found).toHaveLength(1);
        expect(found[0].data?.quickFix?.newText).toBe('[2, 1]');
    });

    it('says nothing when the base a level derives from cannot be read', async () => {
        expect(
            await messages(
                part(
                    [
                        level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                        `\t\t\t\t\t: ~/NoSuchTexture\n\t\t\t\t\t{\n\t\t\t\t\t\tSize = [1, 2]\n\t\t\t\t\t}`,
                    ].join('\n')
                )
            )
        ).toEqual([]);
    });

    it('reads a level whose size alone comes from its base', async () => {
        expect(
            await messages(
                'BaseTexture\n{\n\tSize = [2, 1]\n}\n' +
                    part(
                        [
                            level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                            `\t\t\t\t\t: ~/BaseTexture\n\t\t\t\t\t{\n\t\t\t\t\t\tFile = "wide.png"\n\t\t\t\t\t}`,
                        ].join('\n')
                    )
            )
        ).toEqual([]);
    });

    it('covers the assignment spelling of a sprite list', async () => {
        const found = await check(
            'Part\n{\n\tID = probe.part\n\tComponents\n\t{\n\t\tGraphics\n\t\t{\n\t\t\tType = Graphics\n' +
                '\t\t\tFloor\n\t\t\t{\n\t\t\t\tDamageLevels =\n\t\t\t\t[\n' +
                [
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [1, 2]'),
                ].join('\n') +
                '\n\t\t\t\t]\n\t\t\t}\n\t\t}\n\t}\n}\n'
        );
        expect(found).toHaveLength(1);
    });

    it('covers the inner lists of RandomDamageLevels', async () => {
        const found = await check(
            'Part\n{\n\tID = probe.part\n\tComponents\n\t{\n\t\tDeco\n\t\t{\n\t\t\tType = Sprite\n' +
                '\t\t\tLayer = "parts"\n\t\t\tRandomDamageLevels\n\t\t\t[\n\t\t\t\t[\n' +
                [
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [1, 2]'),
                ].join('\n') +
                '\n\t\t\t\t]\n\t\t\t]\n\t\t}\n\t}\n}\n'
        );
        expect(found).toHaveLength(1);
    });

    it('covers the open and closed lists of an open-close sprite', async () => {
        const found = await check(
            'Part\n{\n\tID = probe.part\n\tComponents\n\t{\n\t\tDoor\n\t\t{\n\t\t\tType = OpenCloseSprite\n' +
                '\t\t\tLayer = "parts"\n\t\t\tOpenDamageLevels\n\t\t\t[\n' +
                [
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [1, 2]'),
                ].join('\n') +
                '\n\t\t\t]\n\t\t\tClosedDamageLevels\n\t\t\t[\n' +
                [
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                    level('File = "wide.png"\n\t\t\t\t\t\tSize = [1, 2]'),
                ].join('\n') +
                '\n\t\t\t]\n\t\t}\n\t}\n}\n'
        );
        expect(found).toHaveLength(2);
    });

    it('covers a sprite list outside the part files', async () => {
        // A resource's stack sprites are the same list shape, reached through a different field.
        const uri = filePathToUri(join(probeDir, 'resources', 'probe.rules'));
        mkdirSync(join(probeDir, 'resources'), { recursive: true });
        writePng(join(probeDir, 'resources', 'wide.png'), 128, 64);
        const source =
            'ID = probe_ore\n\tStackSprites\n\t[\n' +
            [
                level('File = "wide.png"\n\t\t\t\t\t\tSize = [2, 1]'),
                level('File = "wide.png"\n\t\t\t\t\t\tSize = [1, 2]'),
            ].join('\n') +
            '\n\t]\n';
        expect(await validateSpriteGeometry(parseText(source, uri), token)).toHaveLength(1);
    });
});

// The check is default on, so its false-positive surface is the whole game. Vanilla must be silent.
const VANILLA = 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';

const rulesUnder = (dir: string, out: string[] = [], depth = 0): string[] => {
    if (depth > 8) return out;
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of entries) {
        const full = join(dir, name);
        let stats;
        try {
            stats = statSync(full);
        } catch {
            continue;
        }
        if (stats.isDirectory()) rulesUnder(full, out, depth + 1);
        else if (name.toLowerCase().endsWith('.rules')) out.push(full);
    }
    return out;
};

describe.skipIf(!existsSync(VANILLA))('validateSpriteGeometry over the whole vanilla tree', () => {
    beforeAll(async () => {
        // Sprites written as `./Data/…` are resolved from the game root, so the sweep would pass
        // over 350 of them without a game path to resolve against.
        globalSettings.cosmoteerPath = VANILLA;
        const noop: WorkDoneProgressReporter = {
            begin: () => undefined,
            report: () => undefined,
            done: () => undefined,
        };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(VANILLA, noop);
    }, 300_000);

    it('reports nothing the game itself ships', async () => {
        const files = rulesUnder(VANILLA);
        expect(files.length).toBeGreaterThan(500);
        const findings: string[] = [];
        for (const file of files) {
            const text = await readFile(file, 'utf-8').catch(() => null);
            if (text === null) continue;
            const errors = await validateSpriteGeometry(parseText(text, filePathToUri(file)), token);
            for (const error of errors) findings.push(`${file}:${error.node.position.line + 1}: ${error.message}`);
        }
        expect(findings).toEqual([]);
    }, 600_000);
});
