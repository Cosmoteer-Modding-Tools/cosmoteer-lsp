import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { clearShaderCache } from '../../../src/features/shader/shader-index';
import { buildShaderPreview } from '../../../src/features/shader/shader-preview.service';

// The preview service resolves a material to its translated shader, constants, and textures, so it
// needs the game install and self-skips without it. The documents are placed in real game directories
// so the relative shader and texture paths resolve like the game loads them.
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
				TargetBlendMode = Add
				Texture
				{
					File = "explode_spark.png"
				}
			}
		}
	}
}`;

describe('shader preview service', () => {
    it.runIf(HAVE_DATA)('builds a payload with translated GLSL, constants, textures and blend mode', async () => {
        clearShaderCache();
        const doc = parser(lexer(SRC), DOC_URI).value;
        const data = await buildShaderPreview(doc, SRC, offsetOf(SRC, 'Shader ='), token);
        expect(data).not.toBeNull();
        expect(data!.shaderName).toBe('particle_light_emissive.shader');
        expect(data!.translationOk).toBe(true);
        expect(data!.glsl).toContain('void main');

        // The engine's Add mode is (One, One, Add) on both channels.
        expect(data!.blend.label).toBe('Add');
        expect(data!.blend.srcRgb).toBe('One');
        expect(data!.blend.dstRgb).toBe('One');

        // The tint is surfaced raw and normalized with the game's colour parse rules (bytes / 255).
        expect(data!.tint).toContain('255');
        expect(data!.tintComponents).toEqual([1, 128 / 255, 0, 1]);

        // The material's written constants are surfaced with their values, including the numeric
        // components read structurally from the AST (the offset-free path the webview prefers).
        const z = data!.constants.find((c) => c.name === '_z');
        expect(z?.value).toBe('0.2');
        expect(z?.components).toEqual([0.2]);
        const emissive = data!.constants.find((c) => c.name === '_emissiveStrength');
        expect(emissive?.value).toBe('4');

        // The base texture resolved on disk (explode_spark.png exists in the particle directory) with
        // the engine's default sampler state, since the group sets no sampler fields.
        const base = data!.textures.find((t) => t.name === '_texture');
        expect(base?.uri).toMatch(/explode_spark\.png$/i);
        expect(base?.sampler).toEqual({ sampleMode: 'Point', uMode: 'Clamp', vMode: 'Clamp', mips: false });
    });

    // A real mod writes the shader and blend mode as groups (`Shader { File = … }`,
    // `TargetBlendMode { DestRgbFactor = One … }`) and the colour constants as groups (`_x { Rf = … }`)
    // rather than assignments. The preview must resolve all of those forms too. The particle system's
    // Updaters list (a sibling of the material inside a particle def) supplies the colour ramp.
    const GROUP_FORM = `Part
{
	Components
	{
		T
		{
			Type = TurretWeapon
			Initializers
			[
				{
					Type = UvSprites
					SpriteIndexIn = sprite_index
					TextureSize
					{
						X = 256
						Y = 512
					}
					SpriteSize
					{
						X = 128
						Y = 128
					}
					SpriteCount = 7
					SpritesPerRow = 2
					PixelOffset
					{
						X = 0
						Y = 0
					}
					Looping = false
				}
			]
			Renderer
			{
				Type = StandardQuadRenderer
				BaseSize
				{
					X = 1.5
					Y = 1
				}
			}
			Updaters
			[
				{
					Type = Lifetime
					LifeInOut = life
					Lifetime = 2
				}
				{
					Type = ColorRamp
					LerpIn = life
					ColorOut = color
					Invert = false
					Colors
					[
						{
							Rf = 1
							Gf = 0.5
							Bf = 0
							Af = 0
						}
						[255, 255, 255, 255]
					]
				}
			]
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
					SourceAlphaFactor = One
					DestAlphaFactor = One
					AlphaOperator = Add
				}
			}
		}
	}
}`;

    it.runIf(HAVE_DATA)('resolves the group form of Shader, constants, blend mode and the colour ramp', async () => {
        clearShaderCache();
        const doc = parser(lexer(GROUP_FORM), DOC_URI).value;
        const data = await buildShaderPreview(doc, GROUP_FORM, offsetOf(GROUP_FORM, 'Shader'), token);
        expect(data).not.toBeNull();
        expect(data!.shaderName).toBe('particle_light_emissive.shader');
        expect(data!.translationOk).toBe(true);
        // The factor group matches the engine's named Add mode exactly.
        expect(data!.blend.label).toBe('Add');
        expect(data!.constants.find((c) => c.name === '_z')?.value).toBe('0.2');
        // particle_light_emissive includes base_particle, so its per-vertex colour drives the effect.
        expect(data!.isParticle).toBe(true);
        // The colour ramp is read from the enclosing Updaters, each colour normalized to 0–1 floats
        // (a float channel group passes through, a byte list divides by 255).
        expect(data!.particleColor).not.toBeNull();
        expect(data!.particleColor!.lifetime).toBe(2);
        expect(data!.particleColor!.invert).toBe(false);
        expect(data!.particleColor!.colors).toEqual([
            [1, 0.5, 0, 0],
            [1, 1, 1, 1],
        ]);
        // The sprite sheet (a UvSprites initializer), the lifetime, and the renderer's base size are
        // read from the def so the preview shows one cell at the right shape.
        expect(data!.spriteSheet).toEqual({
            textureSize: [256, 512],
            spriteSize: [128, 128],
            count: 7,
            perRow: 2,
            offset: [0, 0],
            animated: false,
        });
        expect(data!.particleLifetime).toBe(2);
        expect(data!.baseSize).toEqual([1.5, 1]);
    });

    // A beam material, modeled on the real thruster def: colour-typed constants written as byte lists,
    // a noise texture constant with wrap sampling, and a custom blend factor group.
    const BEAM_URI = pathToFileURL(join(DATA_DIR, 'ships/terran/thruster_small/particles/__test__.rules')).href;
    const BEAM = `Type = Beam
Sprite
{
	Texture
	{
		File = "thruster_plume.png"
		SampleMode = Linear
		MipLevels = max
		UVMode = Clamp
	}
	_hotColor = [255, 144, 0, 255]
	_noiseTexture
	{
		File = ../../../../common_effects/particles/noise_gradient.png
		MipLevels = 1
		SampleMode = Linear
		UVMode = Wrap
	}
	Shader = "thruster_plume.shader"
	Size = [2.5/1.5, 1]
	TargetBlendMode
	{
		SourceRgbFactor = SourceAlpha
		DestRgbFactor = One
		RgbOperator = Add
		SourceAlphaFactor = Zero
		DestAlphaFactor = One
		AlphaOperator = Add
	}
}`;

    it.runIf(HAVE_DATA)('resolves a beam material: colour constants, texture constants, custom blend', async () => {
        clearShaderCache();
        const doc = parser(lexer(BEAM), BEAM_URI).value;
        const data = await buildShaderPreview(doc, BEAM, offsetOf(BEAM, 'Shader ='), token);
        expect(data).not.toBeNull();
        expect(data!.translationOk).toBe(true);
        expect(data!.isBeam).toBe(true);
        expect(data!.isParticle).toBe(false);

        // The beam vertex-stage stand-ins reach the generated main as preview uniforms the webview
        // animates (beam time) and exposes as controls (intensity, fade).
        expect(data!.glsl).toContain('vsIn.beamTime = uPvBeamTime');
        expect(data!.glsl).toContain('vsIn.intensity = uPvIntensity');

        // The written world size is surfaced verbatim (the webview evaluates the math for the aspect).
        expect(data!.size).toBe('[2.5/1.5, 1]');

        // _hotColor is declared `float4 _hotColor = 255`, which the engine classifies as a colour, so
        // its written byte list divides by 255.
        const hot = data!.constants.find((c) => c.name === '_hotColor');
        expect(hot?.isColor).toBe(true);
        expect(hot?.components).toEqual([1, 144 / 255, 0, 1]);

        // Both the base texture and the noise texture constant resolve, each with its sampler state.
        const base = data!.textures.find((t) => t.name === '_texture');
        expect(base?.uri).toMatch(/thruster_plume\.png$/i);
        expect(base?.sampler).toEqual({ sampleMode: 'Linear', uMode: 'Clamp', vMode: 'Clamp', mips: true });
        const noise = data!.textures.find((t) => t.name === '_noiseTexture');
        expect(noise?.uri).toMatch(/noise_gradient\.png$/i);
        expect(noise?.sampler).toEqual({ sampleMode: 'Linear', uMode: 'Wrap', vMode: 'Wrap', mips: false });

        // The factor group matches no named engine mode, so it is surfaced as written.
        expect(data!.blend.label).toBe('Custom');
        expect(data!.blend.srcRgb).toBe('SourceAlpha');
        expect(data!.blend.dstRgb).toBe('One');
        expect(data!.blend.srcAlpha).toBe('Zero');
        expect(data!.blend.dstAlpha).toBe('One');
    });

    // planets.rules (and asteroids.rules) hold their materials in top-level groups the schema does not
    // classify as shader-constant carriers, so material detection must fall back to the structural
    // rule: the nearest group that directly references a Shader.
    const PLANETS_URI = pathToFileURL(join(DATA_DIR, 'planets/__test__.rules')).href;
    const PLANETS = `DefaultPlanetMaterial
{
	Shader = "planet.shader"
}
`;

    it.runIf(HAVE_DATA)('previews a material whose group has no schema material class (planets.rules)', async () => {
        clearShaderCache();
        const doc = parser(lexer(PLANETS), PLANETS_URI).value;
        const data = await buildShaderPreview(doc, PLANETS, offsetOf(PLANETS, 'Shader ='), token);
        expect(data).not.toBeNull();
        expect(data!.shaderName).toBe('planet.shader');
        expect(data!.translationOk).toBe(true);
    });

    it('returns null when the cursor is not in a shader material', async () => {
        const plain = 'Part\n{\n\tName = "x"\n}';
        const doc = parser(lexer(plain), DOC_URI).value;
        const data = await buildShaderPreview(doc, plain, plain.indexOf('Name'), token);
        expect(data).toBeNull();
    });
});
