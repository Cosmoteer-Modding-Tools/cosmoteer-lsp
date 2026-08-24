import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { validateEffectBuckets } from '../../../src/features/diagnostics/validator.effect-bucket';
import { workspaceFile } from '../../workspace-helper';

const BUCKETS_PATH = workspaceFile('common_effects', 'effect_buckets.rules');
const ROOT_PATH = workspaceFile('cosmoteer.rules');
const token = CancellationToken.None;

const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const VANILLA_BUCKETS = join(DATA_DIR, 'common_effects', 'effect_buckets.rules');

const parse = (text: string, path = BUCKETS_PATH): AbstractNodeDocument => parser(lexer(text), path).value;

const findings = async (text: string): Promise<string[]> =>
    (await validateEffectBuckets(parse(text), token)).map((error) => error.message);

/**
 * Type the bucket file as the whole registry, the way the game root's `EffectBuckets = &<…>` does.
 * The alias index is what the check asks whether a file is the registry or a fragment added to it.
 */
const rootAsRegistry = async (text: string): Promise<void> => {
    aliasRootIndex.invalidate();
    const root = parse('EffectBuckets = &<common_effects/effect_buckets.rules>\n', ROOT_PATH);
    await aliasRootIndex.build(root, async () => parse(text));
};

afterAll(() => aliasRootIndex.invalidate());

// The engine reads the five bucket lists into one dictionary, so a name repeated anywhere across
// them is a load failure rather than a shadowed entry, and each list is capped by the band of
// render orders it is given.
describe('the media effect bucket registry', () => {
    it('says nothing about a registry written the way the game writes its own', async () => {
        expect(
            await findings(['LowerBuckets [ BulletLower1, BulletLower2 ]', 'MiddleBuckets [ default_bullet ]', ''].join('\n'))
        ).toEqual([]);
    });

    it('flags a bucket a second entry of the same list repeats', async () => {
        expect(await findings('MiddleBuckets [ BulletMiddle1, BulletMiddle1 ]\n')).toEqual([
            "The effect bucket 'BulletMiddle1' is already declared in MiddleBuckets. The game refuses to load a registry that names one bucket twice.",
        ]);
    });

    it('flags a bucket a second list repeats, since all five share one dictionary', async () => {
        expect(await findings('LowerBuckets [ Smoke ]\nUpperBuckets [ Smoke ]\n')).toEqual([
            "The effect bucket 'Smoke' is already declared in LowerBuckets. The game refuses to load a registry that names one bucket twice.",
        ]);
    });

    it('matches bucket names the way the engine interns them, ignoring case', async () => {
        expect(await findings('LowerBuckets [ Smoke ]\nUpperBuckets [ smoke ]\n')).toHaveLength(1);
    });

    it('reads the assigned spelling of a list like the named one', async () => {
        expect(await findings('MiddleBuckets = [ Smoke, Smoke ]\n')).toHaveLength(1);
    });

    it('flags the interior surface entry past the band the engine gives that list', async () => {
        const entries = Array.from({ length: 98 }, (_, index) => `Surface${index}`).join(', ');
        expect(await findings(`InteriorSurfaceBuckets [ ${entries} ]\n`)).toEqual([
            'The game reads at most 97 buckets from InteriorSurfaceBuckets and throws on the one after them.',
        ]);
    });

    it('leaves a list at its cap alone', async () => {
        const entries = Array.from({ length: 97 }, (_, index) => `Surface${index}`).join(', ');
        expect(await findings(`InteriorSurfaceBuckets [ ${entries} ]\n`)).toEqual([]);
    });

    it('says nothing about a file that declares no bucket list at all', async () => {
        expect(await findings('Prerequisites [ some_tech ]\n')).toEqual([]);
    });
});

describe('the default bullet bucket', () => {
    it('is reported missing when the file is the whole registry', async () => {
        const text = 'MiddleBuckets [ BulletMiddle1 ]\n';
        await rootAsRegistry(text);
        expect(await findings(text)).toEqual([
            "This registry declares no 'default_bullet' bucket. A bullet sprite that names no render bucket of its own falls back to it, and the game throws the first time such a bullet is drawn.",
        ]);
    });

    it('is not reported once the registry declares it', async () => {
        const text = 'MiddleBuckets [ BulletMiddle1, default_bullet ]\n';
        await rootAsRegistry(text);
        expect(await findings(text)).toEqual([]);
    });

    it('is not reported on a fragment, which carries only the buckets it adds', async () => {
        aliasRootIndex.invalidate();
        expect(await findings('MiddleBuckets [ BulletMiddle1 ]\n')).toEqual([]);
    });
});

// The game's own registry is the one file that has to stay silent: it declares 96 buckets across
// the five lists and loads every time the game starts.
describe.skipIf(!existsSync(VANILLA_BUCKETS))('the registry the game ships', () => {
    it('is reported clean, default bullet bucket included', async () => {
        const text = readFileSync(VANILLA_BUCKETS, 'utf8');
        await rootAsRegistry(text);
        expect((await validateEffectBuckets(parse(text), token)).map((error) => error.message)).toEqual([]);
    });
});
