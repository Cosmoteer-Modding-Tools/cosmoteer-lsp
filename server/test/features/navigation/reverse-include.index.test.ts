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
