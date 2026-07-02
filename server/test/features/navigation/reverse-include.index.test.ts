import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { findEnclosingGroup, resolveGroupClass } from '../../../src/document/schema/schema-context';
import { documentRootClass } from '../../../src/document/schema/document-root';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';
import { clearShaderCache } from '../../../src/features/shader/shader-index';
import { buildShaderPreview } from '../../../src/features/shader/shader-preview.service';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';

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

    // The always-on reverse rooting must not introduce false positives. Built over the whole game tree it
    // roots a set of fragments that were previously unvalidated (particle defs and the like), and every
    // one of those must still validate cleanly, since the game ships and loads all of it. The floor guards
    // against a silent regression (a path-resolution break) that would root nothing and pass vacuously.
    it.runIf(HAVE_DATA)('roots vanilla fragments in reverse without any new validation warnings', async () => {
        try {
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
        } finally {
            ReverseIncludeIndex.instance.reset();
        }
    }, 120000);
});
