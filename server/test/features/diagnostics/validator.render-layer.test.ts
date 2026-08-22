import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { validateRenderLayers } from '../../../src/features/diagnostics/validator.render-layer';
import { ShipLayerContext, invalidateShipLayers } from '../../../src/features/ships/ship-layer.index';

// The check judges a layer against the ship that draws the part, so it needs the install's ship
// registry to have anything to judge against. Self-skips without it.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const parseFile = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;

/** Parses `text` as if it were the given file of the install, so the file decides the ship scope. */
const parseAs = (relativePath: string, text: string) =>
    parser(lexer(text), pathToFileURL(join(DATA_DIR, relativePath)).href).value;

/** A terran part file writing one sprite on `layer`. */
const terranPartWriting = (layer: string) =>
    parseAs(
        'ships/terran/airlock/airlock.rules',
        `Part\n{\n\tComponents\n\t{\n\t\tSprite\n\t\t{\n\t\t\tType = Sprite\n\t\t\tLayer = "${layer}"\n\t\t}\n\t}\n}\n`
    );

describe.skipIf(!HAVE_DATA)('the layer a sprite names has to be one its ship declares', () => {
    let context: ShipLayerContext;

    beforeAll(() => {
        globalSettings.cosmoteerPath = DATA_DIR;
        invalidateShipLayers();
        context = {
            gameRootDocument: parseFile(join(DATA_DIR, 'cosmoteer.rules')),
            gameRootPath: join(DATA_DIR, 'cosmoteer.rules'),
            folderPaths: [],
        };
    }, 120_000);

    it('says nothing about a layer the drawing ship declares', async () => {
        expect(await validateRenderLayers(terranPartWriting('roofs'), context, token)).toEqual([]);
    });

    it('reports a layer no ship declares at all', async () => {
        const errors = await validateRenderLayers(terranPartWriting('rofs'), context, token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain("No ship declares the render layer 'rofs'");
        expect(errors[0].severity).toBe('warning');
    });

    it('reports a real layer that belongs to another ship class', async () => {
        const errors = await validateRenderLayers(terranPartWriting('asteroid'), context, token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('Terran');
        expect(errors[0].message).toContain("'asteroid'");
    });

    // A base is reached by the parts that derive from it, so it is judged like them. Reaching it
    // means walking the install's own part files, which is slow enough to outlast the default
    // timeout when the whole suite runs in parallel.
    it('judges a base file by the ship of the parts that derive from it', { timeout: 60_000 }, async () => {
        const base = parseAs(
            'ships/terran/base_part_terran.rules',
            'Part\n{\n\tComponents\n\t{\n\t\tSprite\n\t\t{\n\t\t\tType = Sprite\n\t\t\tLayer = "asteroid"\n\t\t}\n\t}\n}\n'
        );
        const errors = await validateRenderLayers(base, context, token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('Terran');
    });

    it('leaves a file nothing reaches judged against the whole pool', async () => {
        const loose = parseAs(
            'gui/nothing_reaches_this.rules',
            'Part\n{\n\tComponents\n\t{\n\t\tSprite\n\t\t{\n\t\t\tType = Sprite\n\t\t\tLayer = "asteroid"\n\t\t}\n\t}\n}\n'
        );
        expect(await validateRenderLayers(loose, context, token)).toEqual([]);
    });

    // A mod declares a layer by adding an entry to a ship's own map. Those keys create the ids the
    // rest of the project references, so judging them against the pool they fill would report a
    // mod's new layer as unknown on the very line that declares it.
    it('never judges the key that declares a layer', async () => {
        const declaring = parseAs(
            'ships/terran/terran.rules',
            'Terran\n{\n\tRenderLayers\n\t[\n\t\t{\n\t\t\tKey = "mymod_new_layer"\n\t\t\tValue { }\n\t\t}\n\t]\n}\n'
        );
        expect(await validateRenderLayers(declaring, context, token)).toEqual([]);
    });

    // A blend-sprite fragment holds several top-level groups, each drawn by whatever pulls it in, so
    // the scope is answered per group rather than once for the file.
    it('scopes each top-level group of a fragment file on its own', async () => {
        // The game's own fragment, with one of its groups' layers replaced: reading the real file
        // keeps the group typing that makes those writes visible in the first place.
        const path = 'ships/terran/heat_pipe_adaptive/heat_pipe_blend_sprites.rules';
        const source = readFileSync(join(DATA_DIR, path), 'utf8');
        expect(source).toContain('Layer = "roofs"');
        const fragment = parseAs(path, source.replace('Layer = "roofs"', 'Layer = "definitely_not_a_layer"'));
        const errors = await validateRenderLayers(fragment, context, token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('definitely_not_a_layer');
    });

    it('passes over the dead Layer field of an indicator component', async () => {
        const indicators = parseAs(
            'ships/terran/airlock/airlock.rules',
            'Part\n{\n\tComponents\n\t{\n\t\tIndicators\n\t\t{\n\t\t\tType = IndicatorSprites\n\t\t\tLayer = "indicators"\n\t\t}\n\t}\n}\n'
        );
        expect(await validateRenderLayers(indicators, context, token)).toEqual([]);
    });
});
