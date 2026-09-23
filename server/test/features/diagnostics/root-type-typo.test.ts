import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';

const token = CancellationToken.None;
const parse = (src: string, uri: string) => parser(lexer(src), uri).value;

const SPAWNER = 'file:///mod/modes/career/sectors/spawner.rules';
const DOODAD = 'file:///mod/doodads/rock.rules';

// A whole-file root dispatched by its top-level `Type=` is only as good as the registry the editor
// knows the folder means. `sectors/` names its registry in the path rules and was missing from the
// table the discriminator check reads, so a typo there unrooted the whole file and nothing said so.
// The game answers a name that dispatches to nothing with
// `DeserializeException: Type name '…' at path '…' is not a deserializable subclass of '…'`
// (BaseSerializer.DerivedTypeDeserializationMethod), and the mod does not load.
describe('a whole-file Type that names nothing', () => {
    it('is flagged in a sectors folder', async () => {
        const errors = await validateSchema(parse('Type = NotARealSpawnerType\nCount = 3\n', SPAWNER), token);
        expect(errors.some((error) => error.message.includes('NotARealSpawnerType'))).toBe(true);
        expect(errors.some((error) => error.message.includes('is not a valid'))).toBe(true);
    });

    it('is still flagged in the folders that were already covered', async () => {
        const errors = await validateSchema(parse('Type = NotARealEffectType\n', DOODAD), token);
        expect(errors.some((error) => error.message.includes('NotARealEffectType'))).toBe(true);
    });

    it('says nothing about a Type the registry knows', async () => {
        expect(await validateSchema(parse('Type = None\nCount = 3\n', SPAWNER), token)).toHaveLength(0);
        expect(await validateSchema(parse('Type = FtlGates\n', SPAWNER), token)).toHaveLength(0);
    });

    it('says nothing about a file in that folder that writes no Type at all', async () => {
        // A macro-constant fragment, which the folder's files include rather than dispatch.
        expect(await validateSchema(parse('SECTOR_RADIUS = 300\n', SPAWNER), token)).toHaveLength(0);
    });

    it('says nothing about a folder no path rule names', async () => {
        const errors = await validateSchema(parse('Type = Whatever\n', 'file:///mod/misc/thing.rules'), token);
        expect(errors).toHaveLength(0);
    });
});
