import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    invalidateLooseDeclarationCache,
    isValidatedIdReference,
    judgeIdReference,
    unresolvedIdError,
    validateCrossFileIdReferences,
} from '../../../src/features/diagnostics/validator.schema-id-reference';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { BUILTIN_SHIP_CLASS } from '../../../src/document/schema/entity-schema';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { ParserResultRegistrar } from '../../../src/registrar/parser-result-registrar';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { ActionRootingIndex } from '../../../src/mod/action-rooting.index';
import { globalSettings } from '../../../src/settings';

// End-to-end test of the opt-in cross-file id-reference validator. A temp folder holds the
// authoritative `PartToggles` declaration list (the same field-name harvest the real index
// uses); each part document is parsed in memory and validated against that folder. The index
// singleton is reset before every test so it rebuilds from the folder passed in. Parsed documents
// register like open buffers do in production, since the loose declaration probe reads them
// registrar-first. A second temp folder plays the game data root, giving the label-field
// derivation vanilla usage to derive from.
const parse = (src: string, uri = 'file:///part.rules') => {
    const document = parser(lexer(src), uri).value;
    ParserResultRegistrar.instance.setResult(uri, document);
    return document;
};
const token = CancellationToken.None;

/** A part with a single `UIToggle` component referencing `toggleId` via `ToggleID`. */
const partWithToggle = (toggleId: string, uri?: string) =>
    parse(
        `Part\n{\n\tID = my_part\n\tComponents\n\t[\n\t\tPowerToggle\n\t\t{\n\t\t\tType = UIToggle\n\t\t\tToggleID = "${toggleId}"\n\t\t}\n\t]\n}`,
        uri
    );

describe('validateCrossFileIdReferences', () => {
    let workspaceUri: string;
    let emptyUri: string;
    let shipsUri: string;
    let tmpRoot: string;
    let gameDir: string;
    let modDir: string;

    beforeAll(() => {
        tmpRoot = mkdtempSync(join(tmpdir(), 'idref-'));
        const declDir = join(tmpRoot, 'data', 'gui', 'game', 'parts');
        mkdirSync(declDir, { recursive: true });
        // Authoritative declaration list: two toggles harvested by the `PartToggles` field name.
        writeFileSync(
            join(declDir, 'part_toggles.rules'),
            'PartToggles\n[\n\t{\n\t\tToggleID = "on_off"\n\t}\n\t{\n\t\tToggleID = "fire_mode"\n\t}\n]\n'
        );
        // A part declaring its identity and a legacy alias, the targets of part-id references.
        const partsDir = join(tmpRoot, 'data', 'ships');
        mkdirSync(partsDir, { recursive: true });
        writeFileSync(
            join(partsDir, 'armor.rules'),
            'Part\n{\n\tID = test.armor\n\tOtherIDs = [old.armor]\n\tMaxHealth = 100\n}\n'
        );
        // The ship file whose `RenderLayers` keys declare the layers every part sprite draws on, in
        // the entry spelling the game ships (`[ { Key = "floors" Value { … } } ]`).
        writeFileSync(
            join(partsDir, 'terran.rules'),
            'RenderLayers\n[\n\t{\n\t\tKey = "floors"\n\t\tValue\n\t\t{\n\t\t\tRenderStage = Lowest\n\t\t}\n\t}\n\t{\n\t\tKey = "walls"\n\t\tValue\n\t\t{\n\t\t\tRenderStage = Lowest\n\t\t}\n\t}\n]\n'
        );
        workspaceUri = pathToFileURL(join(tmpRoot, 'data')).href;
        // A builtins workspace in the two shapes the game ships: a prefixed file (every id becomes
        // `IDPrefix + " " + filename`) and an unprefixed one (the id is the bare filename).
        const shipsDir = join(tmpRoot, 'ships', 'builtin_ships');
        mkdirSync(shipsDir, { recursive: true });
        writeFileSync(
            join(shipsDir, 'builtins_mod.rules'),
            'Faction = blackwolf\nIDPrefix = "Blackwolf"\nTags = [civilian]\n\nShips\n[\n\t:~{ File="Starstone.ship.png"; Tier=5 }\n]\n'
        );
        writeFileSync(
            join(shipsDir, 'builtins_vanilla.rules'),
            'Faction = fringe\nTags = [civilian]\n\nShips\n[\n\t:~{ File="Courier.ship.png"; Tier=3 }\n]\n'
        );
        shipsUri = pathToFileURL(join(tmpRoot, 'ships')).href;
        const emptyDir = join(tmpRoot, 'empty');
        mkdirSync(emptyDir, { recursive: true });
        emptyUri = pathToFileURL(emptyDir).href;
        // A miniature game data root (the service requires the `Data` suffix): its part declares a
        // real id while using the two label fields with values that resolve to nothing, the shape
        // the derivation reads off the real install.
        gameDir = join(tmpRoot, 'game', 'Data');
        mkdirSync(gameDir, { recursive: true });
        writeFileSync(
            join(gameDir, 'armor.rules'),
            'Part\n{\n\tID = cosmoteer.armor\n\tSelectionTypeID = "armor"\n\tFlipWhenLoadingIDs = [armor_wedge_R]\n}\n'
        );
        // The game root, carrying a self-keyed map whose one key declares a ship AI. `EffectBuckets`
        // is what roots the file as `Cosmoteer.Data.Rules`, which is what types the map.
        writeFileSync(
            join(gameDir, 'cosmoteer.rules'),
            'EffectBuckets\n{\n\tBuckets = []\n}\n\nShipAIs\n{\n\tbase_ai\n\t{\n\t\tUpdateInterval = 1\n\t}\n}\n'
        );
        // A mod that adds its own AI to that map from its manifest. The payload list is called
        // `ManyToAdd`, so only the action's target slot says these entries declare ship AIs.
        modDir = join(tmpRoot, 'ai_mod');
        mkdirSync(modDir, { recursive: true });
        writeFileSync(
            join(modDir, 'mod.rules'),
            'ID = test.aimod\nName = "t"\nActions\n[\n\t{\n\t\tAction = AddMany\n\t\tAddTo = "<cosmoteer.rules>/ShipAIs"\n\t\tManyToAdd\n\t\t[\n\t\t\t{\n\t\t\t\tKey = "mod_ai"\n\t\t\t\tValue\n\t\t\t\t{\n\t\t\t\t\tUpdateInterval = 1\n\t\t\t\t}\n\t\t\t}\n\t\t]\n\t}\n]\n'
        );
        globalSettings.cosmoteerPath = gameDir;
        const svc = CosmoteerWorkspaceService.instance;
        svc.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        return svc.initialize(gameDir, noop);
    });

    afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

    beforeEach(() => SchemaIdIndex.instance.reset());

    it('does not flag a toggle id that is declared in the project', async () => {
        const errors = await validateCrossFileIdReferences(partWithToggle('on_off'), [workspaceUri], token);
        expect(errors).toHaveLength(0);
    });

    it('flags a typo and suggests the closest declared toggle id', async () => {
        const errors = await validateCrossFileIdReferences(partWithToggle('on_of'), [workspaceUri], token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain("'on_of'");
        expect(errors[0].severity).toBe('warning');
        expect(errors[0].data?.quickFix?.newText).toBe('on_off');
    });

    it('does not flag when the class has no declarations in the project (no coverage to judge)', async () => {
        const errors = await validateCrossFileIdReferences(partWithToggle('on_of'), [emptyUri], token);
        expect(errors).toHaveLength(0);
    });

    it('ignores an empty reference value', async () => {
        const errors = await validateCrossFileIdReferences(partWithToggle(''), [workspaceUri], token);
        expect(errors).toHaveLength(0);
    });

    it('does not validate a mod.rules document', async () => {
        const doc = partWithToggle('on_of', 'file:///mod.rules');
        const errors = await validateCrossFileIdReferences(doc, [workspaceUri], token);
        expect(errors).toHaveLength(0);
    });

    it('does not flag the part\'s own identity fields (e.g. its PartRules ID)', async () => {
        // The part's own `ID = my_part` is reference-typed but is the declaration itself: the open
        // buffer writes it in a declaration shape, which the loose probe accepts.
        const errors = await validateCrossFileIdReferences(partWithToggle('on_off'), [workspaceUri], token);
        expect(errors.map((e) => e.message)).toEqual([]);
    });

    it('flags a part-id reference nothing declares, with a did-you-mean fix', async () => {
        // The workspace declares `test.armor` (and the alias `old.armor`); a typo resolves nowhere,
        // and without a Steam install in this harness the dependency-mod consult stays silent too.
        const errors = await validateCrossFileIdReferences(
            parse('Part\n{\n\tEditorParentParts = ["test.armr"]\n}'),
            [workspaceUri],
            token
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain("'test.armr'");
        expect(errors[0].data?.quickFix?.newText).toBe('test.armor');
    });

    it('accepts part-id references to the declared id and its OtherIDs alias', async () => {
        for (const id of ['test.armor', 'old.armor']) {
            const doc = parse(`Part\n{\n\tEditorParentParts = ["${id}"]\n}`);
            expect(await validateCrossFileIdReferences(doc, [workspaceUri], token)).toHaveLength(0);
        }
    });

    // A trade ship references a built-in ship by an id nothing writes: the game composes it from the
    // ship's filename and the declaring file's `IDPrefix`. A mod that copies the prefixed
    // (defense-style) builtins header into its civilian file, then references its trade ships by the
    // bare filename, crashes the game with a KeyNotFoundException on the first trade-ship spawn.
    // Judged directly, since a `TradeShips` fragment roots through mod actions, not in this harness.
    const judgeShipId = (value: string) =>
        judgeIdReference(
            { node: parse(`X = "${value}"`), targetClass: BUILTIN_SHIP_CLASS, value, fieldName: 'ShipID' },
            [shipsUri],
            new Map(),
            token
        );

    it('judges a ShipID that omits the file\'s IDPrefix as unresolved', async () => {
        expect(await judgeShipId('Starstone')).toBe('unresolved');
    });

    it('resolves the composed id, and an unprefixed file\'s bare filename', async () => {
        expect(await judgeShipId('Blackwolf Starstone')).toBe('resolved');
        expect(await judgeShipId('Courier')).toBe('resolved');
    });

    // The bare "no such ship" message sends the author hunting for a missing file; the prefix is far
    // outside the did-you-mean band, so without this the diagnostic names no cause and offers no fix.
    it('explains the IDPrefix composition and offers the prefixed id as the fix', () => {
        const node = parse('X = "Starstone"');
        const declared = new Set(['Blackwolf Starstone', 'Blackwolf Bonsai', 'Courier']);
        const error = unresolvedIdError({ node, targetClass: BUILTIN_SHIP_CLASS, value: 'Starstone', fieldName: 'ShipID' }, declared);
        expect(error.message).toContain("declares it as 'Blackwolf Starstone'");
        expect(error.message).toContain('IDPrefix');
        expect(error.data?.quickFix?.newText).toBe('Blackwolf Starstone');
    });

    it('keeps the plain message (and edit-distance fix) for an ordinary typo', () => {
        const node = parse('X = "Courie"');
        const error = unresolvedIdError(
            { node, targetClass: BUILTIN_SHIP_CLASS, value: 'Courie', fieldName: 'ShipID' },
            new Set(['Courier', 'Blackwolf Starstone'])
        );
        expect(error.message).not.toContain('IDPrefix');
        expect(error.data?.quickFix?.newText).toBe('Courier');
    });

    it('does not offer a prefix match to a non-ship class (a `battery` typo is not `big battery`)', () => {
        const node = parse('X = "battery"');
        const error = unresolvedIdError(
            { node, targetClass: 'Cosmoteer.Resources.ResourceRules', value: 'battery' },
            new Set(['big battery'])
        );
        expect(error.message).not.toContain('IDPrefix');
        expect(error.data?.quickFix).toBeUndefined();
    });

    it('never flags a SelectionTypeID label despite its PartRules type', async () => {
        // Derived from the game root's own usage: every vanilla SelectionTypeID value fails to
        // resolve, so the field is a label the engine never dereferences.
        const doc = parse('Part\n{\n\tSelectionTypeID = "cannons"\n}');
        expect(await validateCrossFileIdReferences(doc, [workspaceUri], token)).toHaveLength(0);
    });

    it('never flags a FlipWhenLoadingIDs legacy id despite its PartRules type', async () => {
        const doc = parse('Part\n{\n\tFlipWhenLoadingIDs = [my_old_part_R]\n}');
        expect(await validateCrossFileIdReferences(doc, [workspaceUri], token)).toHaveLength(0);
    });

    // A self-keyed map (`RenderLayers`, `ShipAIs`, …) declares its instances through its keys, so a key
    // is never a finding. The values written for the same class elsewhere (`Layer = "floors"` on every
    // part sprite, `AI = trader` on a trade ship) are ordinary references into the pool those keys fill,
    // and a typo there renders on a dead layer or spawns a ship with no AI, silently.
    describe('self-keyed map classes: keys declare, values reference', () => {
        /** A part sprite naming the ship render layer it draws on. */
        const partOnLayer = (layer: string) =>
            parse(
                `Part\n{\n\tComponents\n\t{\n\t\tGraphics\n\t\t{\n\t\t\tType = Graphics\n\t\t\tFloor\n\t\t\t{\n\t\t\t\tLayer = "${layer}"\n\t\t\t}\n\t\t}\n\t}\n}`
            );

        it('accepts a layer the ship file declares as a key', async () => {
            expect(await validateCrossFileIdReferences(partOnLayer('floors'), [workspaceUri], token)).toHaveLength(0);
        });

        it('flags a layer no key declares, with a did-you-mean fix', async () => {
            const errors = await validateCrossFileIdReferences(partOnLayer('flors'), [workspaceUri], token);
            expect(errors).toHaveLength(1);
            expect(errors[0].message).toContain("'flors'");
            expect(errors[0].data?.quickFix?.newText).toBe('floors');
        });

        // A mod declares its own instances by adding entries to the map from its manifest, where the
        // payload list carries the action's name (`ManyToAdd`) instead of the map's. Nothing roots
        // that list, so without the action's target slot every reference to an id the mod adds this
        // way would be flagged as unknown (the render layers of a real workshop mod, 287 references).
        describe('a manifest action that adds map entries declares them', () => {
            const SHIP_AI_CLASS = 'Cosmoteer.Ships.AI.ShipAIRules';
            const judgeAi = async (value: string) => {
                ActionRootingIndex.instance.reset();
                await ActionRootingIndex.instance.ensureBuilt([gameDir, modDir], token);
                return judgeIdReference(
                    { node: parse(`AI = "${value}"`), targetClass: SHIP_AI_CLASS, value, fieldName: 'AI' },
                    [pathToFileURL(gameDir).href, pathToFileURL(modDir).href],
                    new Map(),
                    token
                );
            };

            it('resolves the AI the game root declares as a key', async () => {
                expect(await judgeAi('base_ai')).toBe('resolved');
            });

            it('does not flag the AI the manifest adds to the map', async () => {
                expect(await judgeAi('mod_ai')).toBe('declared-loosely');
            });

            it('still flags an AI nothing declares', async () => {
                expect(await judgeAi('mod_ia')).toBe('unresolved');
            });
        });

        // The game's loader ignores the extension, so a mod can keep rules in a file the project walk
        // never visits and inherit them in (`RenderLayers : &<mineables/2.d>/d`). No index sees such a
        // file, so its layers looked undeclared and every part drawing on them was flagged.
        it('does not flag a layer declared in an unwalked file an indexed file inherits', async () => {
            const layerDir = join(tmpRoot, 'data', 'mineables');
            mkdirSync(layerDir, { recursive: true });
            writeFileSync(
                join(layerDir, '2.d'),
                'd\n[\n\t{\n\t\tKey = "sr"\n\t\tValue\n\t\t{\n\t\t\tRenderStage = Lowest\n\t\t}\n\t}\n]\n'
            );
            writeFileSync(
                join(tmpRoot, 'data', 'ships', 'hyper.rules'),
                'RenderLayers : &<../mineables/2.d>/d\n[\n]\n'
            );
            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([join(tmpRoot, 'data')], token);
            invalidateLooseDeclarationCache();

            expect(await validateCrossFileIdReferences(partOnLayer('sr'), [workspaceUri], token)).toHaveLength(0);
            // A layer no file declares, walked or not, still flags.
            expect(await validateCrossFileIdReferences(partOnLayer('srr'), [workspaceUri], token)).toHaveLength(1);
            ReverseIncludeIndex.instance.reset();
        });

        it('judges the value position but never the declaring key position', () => {
            const node = parse('X = "my_new_layer"');
            const layerClass = 'Cosmoteer.Ships.ShipRenderLayerRules';
            const key = { node, targetClass: layerClass, value: 'my_new_layer', fieldName: 'RenderLayers', isMapKey: true };
            const value = { node, targetClass: layerClass, value: 'my_new_layer', fieldName: 'Layer' };
            expect(isValidatedIdReference(key)).toBe(false);
            expect(isValidatedIdReference(value)).toBe(true);
        });
    });
});
