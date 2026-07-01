import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { clearShaderCache } from '../../../src/features/shader/shader-index';
import { buildShaderPreview } from '../../../src/features/shader/shader-preview.service';

// The preview service resolves a material to its translated shader, constants, and texture, so it needs
// the game install and self-skips without it. The document is placed in the particle directory so the
// relative shader and texture paths resolve like the game loads them.
const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;
const DOC_URI = pathToFileURL(join(DATA_DIR, 'common_effects/particles/__test__.rules')).href;

/** The byte offset of a substring of the source. */
const offsetOf = (src: string, needle: string): number => src.indexOf(needle);

// A turret-arc sprite (resolves to the concrete Sprite, which accepts shader constants) that sets a
// real shader, one of its constants, a tint, a blend mode, and a texture that exists in this directory.
const SRC = `Part
{
	Components
	{
		T
		{
			Type = TurretWeapon
			BlueprintArcSprite
			{
				Shader = "particle_light_emissive.shader"
				_z = 0.2
				_emissiveStrength = 4
				Color = [255, 128, 0, 255]
				TargetBlendMode = Additive
				Texture
				{
					File = "explode_spark.png"
				}
			}
		}
	}
}`;

describe('shader preview service', () => {
    it.runIf(HAVE_DATA)('builds a payload with translated GLSL, constants, texture and blend mode', async () => {
        clearShaderCache();
        const doc = parser(lexer(SRC), DOC_URI).value;
        const data = await buildShaderPreview(doc, SRC, offsetOf(SRC, 'Shader ='), token);
        expect(data).not.toBeNull();
        expect(data!.shaderName).toBe('particle_light_emissive.shader');
        expect(data!.translationOk).toBe(true);
        expect(data!.glsl).toContain('void main');
        expect(data!.blendMode).toBe('Additive');
        expect(data!.tint).toContain('255');

        // The material's written constants are surfaced with their values, including the numeric
        // components read structurally from the AST (the offset-free path the webview prefers).
        const z = data!.constants.find((c) => c.name === '_z');
        expect(z?.value).toBe('0.2');
        expect(z?.components).toEqual([0.2]);
        const emissive = data!.constants.find((c) => c.name === '_emissiveStrength');
        expect(emissive?.value).toBe('4');

        // The texture resolved on disk (explode_spark.png exists in the particle directory).
        expect(data!.textureUri).toMatch(/explode_spark\.png$/i);
    });

    // A real mod writes the shader and blend mode as groups (`Shader { File = … }`,
    // `TargetBlendMode { DestRgbFactor = One … }`) and the colour constants as groups (`_x { Rf = … }`)
    // rather than assignments. The preview must resolve all of those forms too.
    const GROUP_FORM = `Part
{
	Components
	{
		T
		{
			Type = TurretWeapon
			BlueprintArcSprite
			{
				Shader
				{
					File = particle_light_emissive.shader
				}
				_z = 0.2
				TargetBlendMode
				{
					SourceRgbFactor = One
					DestRgbFactor = One
					RgbOperator = Add
				}
			}
		}
	}
}`;

    it.runIf(HAVE_DATA)('resolves the group form of Shader, constants and blend mode', async () => {
        clearShaderCache();
        const doc = parser(lexer(GROUP_FORM), DOC_URI).value;
        const data = await buildShaderPreview(doc, GROUP_FORM, offsetOf(GROUP_FORM, 'Shader'), token);
        expect(data).not.toBeNull();
        expect(data!.shaderName).toBe('particle_light_emissive.shader');
        expect(data!.translationOk).toBe(true);
        // Blend mode read from the factor group (DestRgbFactor = One, additive operator).
        expect(data!.blendMode).toBe('Additive');
        expect(data!.constants.find((c) => c.name === '_z')?.value).toBe('0.2');
        // particle_light_emissive includes base_particle, so its per-vertex colour drives the effect.
        expect(data!.isParticle).toBe(true);
    });

    it('returns null when the cursor is not in a shader material', async () => {
        const plain = 'Part\n{\n\tName = "x"\n}';
        const doc = parser(lexer(plain), DOC_URI).value;
        const data = await buildShaderPreview(doc, plain, plain.indexOf('Name'), token);
        expect(data).toBeNull();
    });
});
