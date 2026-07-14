import { describe, expect, beforeAll, afterAll, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNodeDocument, GroupNode, isGroupNode } from '../../../src/core/ast/ast';
import { documentRootClass } from '../../../src/document/schema/document-root';
import { memberTypeIn, resolveGroupClass } from '../../../src/document/schema/schema-context';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

// The last vanilla rooting idioms: macro-alias containers typed by their usage sites, macro-anchored
// overclock fragments, and a component base file dispatched through the deriver's slot registry.
// Each case here was an unrooted vanilla file before the mechanism it pins existed, so a regression
// shows up as a null class or type. Needs the install, self-skips without it.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;
const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;
const parseData = (rel: string): AbstractNodeDocument => parseReal(join(DATA_DIR, rel));

describe.skipIf(!HAVE_DATA)('macro-alias and overclock rooting over vanilla Data', () => {
    beforeAll(async () => {
        const resolveRef = async (fileRef: string, fromUri: string) => {
            const rel = fileRef.replace(/[<>]/g, '').trim();
            if (!rel) return undefined;
            const withExt = /\.[^/\\.]+$/.test(rel) ? rel : `${rel}.rules`;
            for (const abs of [
                join(dirname(fileURLToPath(fromUri)), withExt),
                join(DATA_DIR, withExt),
                join(dirname(DATA_DIR), withExt),
            ]) {
                if (existsSync(abs)) {
                    try {
                        return parseReal(abs);
                    } catch {
                        return undefined;
                    }
                }
            }
            return undefined;
        };
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const svc = CosmoteerWorkspaceService.instance;
        svc.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await svc.initialize(DATA_DIR, noop);
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);
        ReverseIncludeIndex.instance.reset();
        await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR], token);
    }, 300_000);

    afterAll(() => {
        ReverseIncludeIndex.instance.reset();
        aliasRootIndex.invalidate();
    });

    it('types a macro-alias container member by the slots that read it (COMMON_EFFECTS)', () => {
        // `NuggetPickupMediaEffects = &/COMMON_EFFECTS/NuggetPickup` and friends read these members
        // from MultiMediaEffects slots, which is the only typing the pure macro container has.
        const doc = parseData('common_effects/common_effects.rules');
        const type = memberTypeIn(doc, 'NuggetPickup');
        expect(type?.kind).toBe('group');
        expect(type && 'ref' in type && type.ref).toContain('MultiMediaEffectRules');
    });

    it('types a scalar macro container member by its usage (PRIORITIES)', () => {
        // `DefaultPriority = &/PRIORITIES/Weapon_Supply` in the weapon parts.
        const doc = parseData('ships/priorities.rules');
        expect(memberTypeIn(doc, 'Weapon_Supply')).toBeDefined();
    });

    it('roots a bullet file whose macro constants outnumber its fields (flak overclock field)', () => {
        // ID/Range/Speed/Components against five ALL_CAPS anchors: the constants are excluded from
        // the root fit, so the /shots/ path rule applies.
        const doc = parseData('shots/flak_large/overclock/flak_large_overclock_field.rules');
        expect(documentRootClass(doc)).toBe('Cosmoteer.Bullets.BulletRules');
    });

    it('does not whole-file root a pure macro container (chaingun overclock)', () => {
        // Nothing but ALL_CAPS anchors and an inheriting Beam group: excluding the constants leaves
        // no declared member as evidence, so the /shots/ BulletRules rule must not claim the file.
        const doc = parseData('shots/chaingun_shot/overclock/chaingun_shot_overclock.rules');
        expect(documentRootClass(doc)).toBeUndefined();
    });

    it('roots the overclock Beam group from its part deriver through the member-qualified macro', () => {
        // chaingun.rules: `BEAM = &<…/chaingun_shot_overclock.rules>/Beam`, then a component derives
        // `BulletEmitter : ~/OVERCLOCK/BEAM, ~/EMITTER`, whose class comes from the EMITTER macro's
        // same-file dereference. The Beam group roots to that deriver class.
        const doc = parseData('shots/chaingun_shot/overclock/chaingun_shot_overclock.rules');
        const beam = doc.elements.find((e): e is GroupNode => isGroupNode(e) && e.identifier?.name === 'Beam');
        expect(beam).toBeDefined();
        expect(resolveGroupClass(beam!)).toBe('Cosmoteer.Ships.Parts.Weapons.BeamEmitterRules');
    });

    it('roots a component base file by dispatching its own Type in the deriver slot registry (blueprint walls)', () => {
        // Parts derive `BlueprintWalls : <blueprint_walls.rules>` inside their Components map. The
        // deriver has no class of its own (its Type comes through the inheritance), but the slot pins
        // the component registry, and the file's `Type = BlueprintBlendSprite` picks the class.
        const doc = parseData('ships/terran/walls/blueprint_walls.rules');
        expect(memberTypeIn(doc, 'AmbiguousSprites')).toBeDefined();
    });
});
