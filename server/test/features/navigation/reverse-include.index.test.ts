import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { findEnclosingGroup, resolveGroupClass } from '../../../src/document/schema/schema-context';
import { fieldOf } from '../../../src/document/schema/schema';
import { documentRootClass } from '../../../src/document/schema/document-root';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';
import { clearShaderCache } from '../../../src/features/shader/shader-index';
import { buildShaderPreview } from '../../../src/features/shader/shader-preview.service';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { MemberInjectionIndex } from '../../../src/mod/member-injection.index';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { invalidateModContext } from '../../../src/mod/mod-context';

const token = CancellationToken.None;

const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);

/** Every `.rules` file under `root`, recursively. */
const rulesFiles = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            if (statSync(p).isDirectory()) walk(p);
            else if (entry.endsWith('.rules')) out.push(p);
        }
    };
    walk(root);
    return out;
};

describe('reverse-include rooting', () => {
    // A particle `_def.rules` is the body of an effect's `Def` group, included as `Def = &<…>`. Opened on
    // its own it has no root class, so before this index its `Material` group did not resolve and the
    // shader preview refused it. The index roots the fragment from the including `Def` field instead.
    it('roots a fragment from the field that includes it, so its material resolves', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'revinc-'));
        try {
            writeFileSync(join(dir, 'effect.rules'), 'Type = Particles\nDef = &<frag_def.rules>\n');
            const fragText = 'EmitPerSecond = 0\nMaterial\n{\n\tShader = "particle_light_emissive.shader"\n\t_z = 0.2\n}\n';
            const fragPath = join(dir, 'frag_def.rules');
            writeFileSync(fragPath, fragText);

            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);

            const doc = parser(lexer(fragText), pathToFileURL(fragPath).href).value;
            const material = findEnclosingGroup(doc, fragText.indexOf('Shader'));
            expect(material?.identifier?.name).toBe('Material');
            // Rooted through `Def` (group<ParticleSystemDef>) whose `Material` field is a Halfling material.
            expect(resolveGroupClass(material!)).toBe('Halfling.Graphics.Material');
        } finally {
            // Leave the fallback registered (the singleton stays the registered source in production too),
            // just empty its data so a later test starts clean.
            ReverseIncludeIndex.instance.reset();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // A mod includes a vanilla fragment through the merged game tree, `Def = &<./data/…>`, not by a path
    // relative to the mod file. The cheap relative join misses (a mod folder has no Data subtree), so the
    // slow navigation path resolves it against the workspace Data root and the fragment still roots.
    it('roots a fragment reached through a mod-overlay `&<./data/…>` include', async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        const modDir = mkdtempSync(join(tmpdir(), 'revinc-slow-'));
        try {
            writeFileSync(join(modDir, 'effect.rules'), 'Type = Particles\nDef = &<./data/effects/particle_frag_def.rules>\n');
            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([modDir], token);

            const fragPath = workspaceFile('effects', 'particle_frag_def.rules');
            const fragText = readFileSync(fragPath, 'utf8');
            const doc = parser(lexer(fragText), pathToFileURL(fragPath).href).value;
            // The overlay fragment is rooted through the including `Def` field, as the relative case is.
            expect(ReverseIncludeIndex.instance.rootType(doc.uri)?.kind).toBe('group');
            const material = findEnclosingGroup(doc, fragText.indexOf('Shader'));
            expect(resolveGroupClass(material!)).toBe('Halfling.Graphics.Material');
        } finally {
            ReverseIncludeIndex.instance.reset();
            rmSync(modDir, { recursive: true, force: true });
        }
    });

    // A fragment is often included from a field nested inside a group, not at the file's top level. Here
    // the effect's `Def { Material = &<…> }` pulls the fragment in one level down. The index walks the
    // whole document, so the nested include roots the fragment through the declaring field's type just
    // like a top-level one.
    it('roots a fragment included from a nested group field', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'revinc-nested-'));
        try {
            // Type=Particles roots the effect as ParticleEffectRules; its `Def` group is a ParticleSystemDef,
            // whose nested `Material` field pulls in the fragment.
            writeFileSync(join(dir, 'effect.rules'), 'Type = Particles\nDef\n{\n\tMaterial = &<mat_frag.rules>\n}\n');
            const fragText = 'Shader = "particle_light_emissive.shader"\n';
            const fragPath = join(dir, 'mat_frag.rules');
            writeFileSync(fragPath, fragText);

            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);

            const doc = parser(lexer(fragText), pathToFileURL(fragPath).href).value;
            // Rooted from the nested `Material` field as a Halfling material.
            expect(ReverseIncludeIndex.instance.rootType(doc.uri)).toMatchObject({ ref: 'Halfling.Graphics.Material' });
        } finally {
            ReverseIncludeIndex.instance.reset();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // A fragment can be pulled in as a bare `&<frag>` element of a list, not a `Field = &<…>` assignment
    // (a codex `CodexPages [ &<page> ]` in the real data). The index roots each such element as the list's
    // element type. Here the effect's `Def.Updaters` list is a `list<IParticleDataUpdater>`, so the
    // element fragment roots as that updater type.
    it('roots a fragment included as a bare list element', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'revinc-list-'));
        try {
            // Type=Particles roots the effect; `Def` is a ParticleSystemDef whose `Updaters` list holds the
            // fragment as an element.
            writeFileSync(
                join(dir, 'effect.rules'),
                'Type = Particles\nDef\n{\n\tUpdaters\n\t[\n\t\t&<updater_frag.rules>\n\t]\n}\n'
            );
            const fragText = 'Type = Velocity\n';
            const fragPath = join(dir, 'updater_frag.rules');
            writeFileSync(fragPath, fragText);

            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);

            const doc = parser(lexer(fragText), pathToFileURL(fragPath).href).value;
            // Rooted from the list's element type (an IParticleDataUpdater), so its own `Type=` resolves.
            expect(ReverseIncludeIndex.instance.rootType(doc.uri)).toMatchObject({
                ref: 'Halfling.Particles.IParticleDataUpdater',
            });
        } finally {
            ReverseIncludeIndex.instance.reset();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // A chain: the rooted effect includes a middle def, and the middle def includes a leaf material. The
    // middle can only type its own include once it is itself rooted, which (for this scan order) happens
    // on a later pass, so the fixpoint build roots the leaf that a single pass would miss.
    it('roots a fragment through a chain of includes (fixpoint)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'revinc-chain-'));
        try {
            // effect.rules (rooted by Type) --Def--> mid_def.rules (ParticleSystemDef) --Material--> leaf.
            writeFileSync(join(dir, 'effect.rules'), 'Type = Particles\nDef = &<mid_def.rules>\n');
            writeFileSync(join(dir, 'mid_def.rules'), 'Material = &<leaf_mat.rules>\n');
            const leafText = 'Shader = "particle_light_emissive.shader"\n';
            const leafPath = join(dir, 'leaf_mat.rules');
            writeFileSync(leafPath, leafText);

            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);

            const doc = parser(lexer(leafText), pathToFileURL(leafPath).href).value;
            // The leaf roots as a Halfling material reached two includes deep (effect → def → material).
            expect(ReverseIncludeIndex.instance.rootType(doc.uri)).toMatchObject({ ref: 'Halfling.Graphics.Material' });
            expect(ReverseIncludeIndex.instance.passesUsed).toBeGreaterThan(1);
        } finally {
            ReverseIncludeIndex.instance.reset();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // A fragment can be pulled into a map-typed group, where the member name is a key, not a field (the
    // real planet styles: `Styles { alien = &<planet_alien.rules> }`). The index types such an include as
    // the map's value type, so the fragment roots as the map element class. The container itself roots
    // through the forward alias walk, so this exercises the forward → reverse hand-off too.
    it('roots a fragment included as a map value', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'revinc-map-'));
        const uriOf = (name: string) => pathToFileURL(join(dir, name)).href;
        try {
            // A stand-in cosmoteer.rules roots planets.rules as PlanetRules (whose `Styles` is a map).
            writeFileSync(join(dir, 'cosmoteer.rules'), 'Planets = &<planets.rules>\n');
            writeFileSync(join(dir, 'planets.rules'), 'Styles\n{\n\talien = &<planet_frag.rules>\n}\n');
            const fragText = 'HeightMaps []\n';
            writeFileSync(join(dir, 'planet_frag.rules'), fragText);

            // Forward alias index first (production order), so planets.rules roots as PlanetRules.
            aliasRootIndex.invalidate();
            const parsed = (name: string) => parser(lexer(readFileSync(join(dir, name), 'utf8')), uriOf(name)).value;
            await aliasRootIndex.build(parsed('cosmoteer.rules'), async (fileRef) => {
                const m = /<([^>]+)>/.exec(fileRef);
                return m ? parsed(m[1]) : undefined;
            });
            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);

            const doc = parser(lexer(fragText), uriOf('planet_frag.rules')).value;
            // Rooted from the `Styles` map's value type — the `alien` member is a key, not a field.
            expect(ReverseIncludeIndex.instance.rootType(doc.uri)).toMatchObject({
                ref: 'Cosmoteer.Generators.Planets.PlanetStyleRules',
            });
        } finally {
            ReverseIncludeIndex.instance.reset();
            aliasRootIndex.invalidate();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // A pure inheritance base — a fragment reached only through `Derived : <base.rules>/Base`, never as a
    // field value — is rooted to the deriver class that best fits its OWN fields. Mirrors the real
    // `commands/` layout: `MoveCommand` (MoveCommandRules) and `DirectControlCommand` (BaseCommandRules)
    // both inherit `base_cmd.rules`'s `BaseCommand`; since MoveCommandRules owns the base's field(s) and is
    // the most-derived (most fields) candidate that does, the base roots there so all its fields resolve.
    it('roots a pure inheritance base to the best-fitting deriver class', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'revinc-inherit-'));
        const uriOf = (name: string) => pathToFileURL(join(dir, name)).href;
        try {
            // A stand-in cosmoteer.rules aliases commands.rules (Commands is group<CommandRules>), which in
            // turn member-aliases each concrete command, so they root via the forward walk.
            writeFileSync(join(dir, 'cosmoteer.rules'), 'Commands = &<commands.rules>\n');
            writeFileSync(
                join(dir, 'commands.rules'),
                'Move = &<cmd_move.rules>/MoveCommand\nDirectControl = &<cmd_dc.rules>/DirectControlCommand\n'
            );
            writeFileSync(join(dir, 'cmd_move.rules'), 'MoveCommand : <base_cmd.rules>/BaseCommand\n{\n\tCircleDuration = 1\n}\n');
            writeFileSync(join(dir, 'cmd_dc.rules'), 'DirectControlCommand : <base_cmd.rules>/BaseCommand\n{\n}\n');
            const baseText = 'BaseCommand\n{\n\tAvoidRadiusBuffer = 5\n}\n';
            writeFileSync(join(dir, 'base_cmd.rules'), baseText);

            aliasRootIndex.invalidate();
            const parsed = (name: string) => parser(lexer(readFileSync(join(dir, name), 'utf8')), uriOf(name)).value;
            await aliasRootIndex.build(parsed('cosmoteer.rules'), async (fileRef) => {
                const m = /<([^>]+)>/.exec(fileRef);
                return m ? parsed(m[1]) : undefined;
            });
            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);

            const doc = parser(lexer(baseText), uriOf('base_cmd.rules')).value;
            const base = findEnclosingGroup(doc, baseText.indexOf('AvoidRadiusBuffer'));
            expect(base?.identifier?.name).toBe('BaseCommand');
            // MoveCommandRules is the most-derived deriver that owns the base's fields, so it wins the fit.
            expect(resolveGroupClass(base!)).toBe('Cosmoteer.Ships.Commands.MoveCommandRules');
        } finally {
            ReverseIncludeIndex.instance.reset();
            aliasRootIndex.invalidate();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // A mod that defines shared munitions in a fragment file and inherits them into components through
    // its cosmoteer.rules convenience globals (`BeamEmitter : &/SHOTS/Alias/Group`). The base carries
    // no `<file>` ref, so only the full navigator finds where it lands. The base group then roots to
    // the deriver's class, even though its own legacy `Type = Beam` matches a different registry.
    it('roots an inheritance base reached through a mod convenience-global super-path', async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        const modDir = mkdtempSync(join(tmpdir(), 'revinc-superbase-'));
        try {
            // The real-mod shape: the manifest adds the global onto the game root, the global aliases
            // the shots fragment file, and a part component inherits a shot through the global.
            writeFileSync(
                join(modDir, 'mod.rules'),
                'ID = test.superbase\nActions\n[\n\t{\n\t\tAction = Add\n\t\tAddTo = "<cosmoteer.rules>"\n\t\tName = SW_SHOTS\n\t\tToAdd = &<mod-shots.rules>\n\t}\n]\n'
            );
            writeFileSync(join(modDir, 'mod-shots.rules'), 'MyBeam = &<shots/beam.rules>\n');
            mkdirSync(join(modDir, 'shots'));
            const beamText = 'Siege_Beam\n{\n\tType = Beam\n\tDuration = 5\n\tHitInterval = .1\n}\n';
            writeFileSync(join(modDir, 'shots', 'beam.rules'), beamText);
            writeFileSync(
                join(modDir, 'part.rules'),
                'Part\n{\n\tComponents\n\t{\n\t\tBeamEmitter : &/SW_SHOTS/MyBeam/Siege_Beam\n\t\t{\n\t\t\tType = BeamEmitter\n\t\t}\n\t}\n}\n'
            );

            clearModRootCache();
            invalidateModContext();
            MemberInjectionIndex.instance.reset();
            await MemberInjectionIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, modDir], token);
            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([modDir], token);

            const beamPath = join(modDir, 'shots', 'beam.rules');
            const beamUri = pathToFileURL(beamPath).href;
            expect(ReverseIncludeIndex.instance.inheritanceBaseMembers(beamUri)).toContain('Siege_Beam');
            expect(ReverseIncludeIndex.instance.inheritanceDeriverClasses(beamUri, 'Siege_Beam')).toContain(
                'Cosmoteer.Ships.Parts.Weapons.BeamEmitterRules'
            );
            const doc = parser(lexer(beamText), beamUri).value;
            const group = findEnclosingGroup(doc, beamText.indexOf('Duration'));
            expect(group?.identifier?.name).toBe('Siege_Beam');
            expect(resolveGroupClass(group!)).toBe('Cosmoteer.Ships.Parts.Weapons.BeamEmitterRules');
        } finally {
            ReverseIncludeIndex.instance.reset();
            MemberInjectionIndex.instance.reset();
            clearModRootCache();
            invalidateModContext();
            rmSync(modDir, { recursive: true, force: true });
        }
    });

    // The inverse of inheritance-base rooting. A top-level group inheriting a whole-file base roots to
    // that base's class, since inheritance preserves type. Roots the overclock shot fragments like
    // `Beam : <ion_beam.rules>`. Here the base self-roots via its own `Type=` dispatch.
    it('roots a top-level group from the whole-file base it inherits (`Group : <base>`)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'revinc-ownbase-'));
        try {
            const baseText = 'Type = Particles\nEmitPerSecond = 0\n';
            writeFileSync(join(dir, 'base_shot.rules'), baseText);
            const ocText = 'MACRO = &<base_shot.rules>\nOverclock : <base_shot.rules>\n{\n\tEmitPerSecond = 5\n}\n';
            writeFileSync(join(dir, 'oc.rules'), ocText);

            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);

            const baseDoc = parser(lexer(baseText), pathToFileURL(join(dir, 'base_shot.rules')).href).value;
            const expected = documentRootClass(baseDoc);
            expect(expected).toBeTruthy();
            const doc = parser(lexer(ocText), pathToFileURL(join(dir, 'oc.rules')).href).value;
            const oc = findEnclosingGroup(doc, ocText.indexOf('EmitPerSecond = 5'));
            expect(oc?.identifier?.name).toBe('Overclock');
            expect(resolveGroupClass(oc!)).toBe(expected);
        } finally {
            ReverseIncludeIndex.instance.reset();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // The real overclock case, exercising the `&BASE` same-file alias to `&<file>` indirection. The
    // `disruptor_bolt_overclock.rules` `Bullet : &BASE` group roots to BulletRules, the class its sibling
    // base shot roots to. Uses only dir-relative includes, so it needs no workspace init.
    it.runIf(HAVE_DATA)('roots the real disruptor_bolt_overclock `Bullet : &BASE` group', async () => {
        const dir = join(DATA_DIR, 'shots/disruptor_bolt');
        const ocPath = join(dir, 'disruptor_bolt_overclock.rules');
        if (!existsSync(ocPath)) return;
        try {
            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);

            const text = readFileSync(ocPath, 'utf8');
            const doc = parser(lexer(text), pathToFileURL(ocPath).href).value;
            const bullet = findEnclosingGroup(doc, text.indexOf('{', text.indexOf('Bullet')) + 2);
            expect(bullet?.identifier?.name).toBe('Bullet');
            expect(resolveGroupClass(bullet!)).toBe('Cosmoteer.Bullets.BulletRules');
        } finally {
            ReverseIncludeIndex.instance.reset();
        }
    });

    // End to end on the real game file the bug was reported against: with the effect files scanned, the
    // preview builds a payload instead of returning null (which is what showed the "place the cursor in a
    // material" message).
    it.runIf(HAVE_DATA)('lets the preview build for the real explode_sparks_def.rules fragment', async () => {
        const particlesDir = join(DATA_DIR, 'common_effects/particles');
        const fragPath = join(particlesDir, 'explode_sparks_def.rules');
        if (!existsSync(fragPath)) return;
        try {
            clearShaderCache();
            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([particlesDir], token);

            // Parse the real file so the material and its offsets match the on-disk content.
            const real = readFileSync(fragPath, 'utf-8');
            const doc = parser(lexer(real), pathToFileURL(fragPath).href).value;
            const data = await buildShaderPreview(doc, real, real.indexOf('Shader ='), token);
            expect(data).not.toBeNull();
            expect(data!.shaderName).toBe('particle_light_emissive.shader');
        } finally {
            ReverseIncludeIndex.instance.reset();
        }
    });

    // The real bug this feature fixes: `base_command.rules` gets no schema features because its
    // `BaseCommand` group is pulled in only as an inheritance base, never as a field value. With the real
    // command files (which root via the forward walk) scanned, the base roots to BaseCommandRules and the
    // intermediate `base_follow_command.rules` (reached only through the chain) roots to BaseFollowCommandRules.
    it.runIf(HAVE_DATA)('roots the real commands/ inheritance bases (base_command, base_follow_command)', async () => {
        const commandsDir = join(DATA_DIR, 'commands');
        if (!existsSync(join(commandsDir, 'base_command.rules'))) return;
        try {
            // Build the real forward alias index over just the commands subtree: a synthetic root aliases the
            // real commands.rules (Commands is group<CommandRules>), whose member aliases root each command.
            aliasRootIndex.invalidate();
            const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;
            const rootDoc = parser(lexer('Commands = &<commands/commands.rules>\n'), pathToFileURL(join(DATA_DIR, 'cosmoteer.rules')).href).value;
            await aliasRootIndex.build(rootDoc, async (fileRef, fromUri) => {
                const rel = fileRef.replace(/[<>]/g, '').trim();
                const abs = join(dirname(fileURLToPath(fromUri)), rel);
                try {
                    return existsSync(abs) ? parseReal(abs) : undefined;
                } catch {
                    return undefined;
                }
            });
            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([commandsDir], token);

            const baseCmdText = readFileSync(join(commandsDir, 'base_command.rules'), 'utf8');
            const baseCmdDoc = parser(lexer(baseCmdText), pathToFileURL(join(commandsDir, 'base_command.rules')).href).value;
            const baseCmd = findEnclosingGroup(baseCmdDoc, baseCmdText.indexOf('AvoidRadiusBuffer'));
            expect(baseCmd?.identifier?.name).toBe('BaseCommand');
            // Roots to a deriver class that owns EVERY field the base declares — including the move-widget
            // groups (MoverWidget/RotatorWidget/DeleterWidget) that the shallow BaseCommandRules lacks. The
            // exact winner among owns-all candidates is an arbitrary tiebreak; the guarantee is that the
            // widget field resolves (`fieldOf` non-undefined) so nested completion works and it validates clean.
            const baseClass = resolveGroupClass(baseCmd!);
            expect(baseClass && fieldOf(baseClass, 'MoverWidget')).toBeTruthy();
            expect(await validateSchema(baseCmdDoc, token)).toEqual([]);
            // A nested widget group inside the base now resolves too (it did not under the common ancestor).
            const mover = findEnclosingGroup(baseCmdDoc, baseCmdText.indexOf('MoverWidget'));
            expect(resolveGroupClass(mover!)).toBeTruthy();

            const followPath = join(commandsDir, 'base_follow_command.rules');
            if (existsSync(followPath)) {
                const followText = readFileSync(followPath, 'utf8');
                const followDoc = parser(lexer(followText), pathToFileURL(followPath).href).value;
                // base_follow_command is reached only through the chain — its own derivers (the follow
                // commands) root it, and it in turn roots base_command — so this is what the fixpoint buys.
                expect(ReverseIncludeIndex.instance.inheritanceBaseMembers(followDoc.uri)).toContain('BaseFollowCommand');
                expect(ReverseIncludeIndex.instance.passesUsed).toBeGreaterThan(1);
                // It roots for real (completion/validation), and validates clean.
                const followGroup = findEnclosingGroup(followDoc, followText.indexOf('{') + 2);
                expect(resolveGroupClass(followGroup!)).toBeTruthy();
                expect(await validateSchema(followDoc, token)).toEqual([]);
            }
        } finally {
            ReverseIncludeIndex.instance.reset();
            aliasRootIndex.invalidate();
        }
    });

    // The always-on reverse rooting must not introduce false positives. Built over the whole game tree it
    // roots a set of fragments that were previously unvalidated (particle defs, inheritance bases and the
    // like), and every one of those must still validate cleanly, since the game ships and loads all of it.
    // The forward alias index is built first, exactly as production does, so forward-rooted derivers (the
    // commands) root and their inheritance bases are exercised too. The floors guard against a silent
    // regression (a path-resolution break) that would root nothing and pass vacuously.
    it.runIf(HAVE_DATA)('roots vanilla fragments in reverse without any new validation warnings', async () => {
        try {
            // Production order: real forward alias index first, then reverse-include (see server.ts startup).
            // Built directly from the real cosmoteer.rules with a real-file resolver (dir-relative first,
            // then game-root anchored), so it is independent of any workspace-service state other tests set.
            const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;
            const resolveRef = async (fileRef: string, fromUri: string) => {
                const rel = fileRef.replace(/[<>]/g, '').trim();
                if (!rel) return undefined;
                const withExt = /\.[^/\\.]+$/.test(rel) ? rel : `${rel}.rules`;
                for (const abs of [
                    join(dirname(fileURLToPath(fromUri)), withExt),
                    join(DATA_DIR, withExt),
                    join(dirname(DATA_DIR), withExt),
                ]) {
                    if (!existsSync(abs)) continue;
                    try {
                        return parseReal(abs);
                    } catch {
                        return undefined;
                    }
                }
                return undefined;
            };
            aliasRootIndex.invalidate();
            await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);
            await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR], token);

            let newlyRooted = 0;
            const offenders: string[] = [];
            for (const file of rulesFiles(DATA_DIR)) {
                let doc;
                try {
                    doc = parser(lexer(readFileSync(file, 'utf8')), pathToFileURL(file).href).value;
                } catch {
                    continue;
                }
                const rootedInReverse =
                    ReverseIncludeIndex.instance.rootType(doc.uri) !== undefined && documentRootClass(doc) === undefined;
                if (rootedInReverse) newlyRooted++;
                const errors = await validateSchema(doc, token);
                if (errors.length) offenders.push(`${file}: ${errors.map((e) => e.message).join(' | ')}`);
            }
            expect(offenders.slice(0, 40)).toEqual([]);
            expect(newlyRooted).toBeGreaterThanOrEqual(10);

            // The reported file specifically: its inheritance-only `BaseCommand` group now roots and its
            // fields validate, proving forward + reverse + inheritance rooting compose in production order.
            const baseCmdPath = join(DATA_DIR, 'commands', 'base_command.rules');
            if (existsSync(baseCmdPath)) {
                const text = readFileSync(baseCmdPath, 'utf8');
                const doc = parser(lexer(text), pathToFileURL(baseCmdPath).href).value;
                const base = findEnclosingGroup(doc, text.indexOf('AvoidRadiusBuffer'));
                const cls = resolveGroupClass(base!);
                expect(cls && fieldOf(cls, 'MoverWidget')).toBeTruthy();
            }
        } finally {
            ReverseIncludeIndex.instance.reset();
            aliasRootIndex.invalidate();
        }
    }, 120000);
});
