import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { documentRootClass } from '../../../src/document/schema/document-root';
import { fieldOf } from '../../../src/document/schema/schema';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';

const token = CancellationToken.None;
const parse = (src: string, path: string) =>
    parser(lexer(src), `file:///c%3A/game/Data/builtin_ships/${path}`).value;
const rootOf = (src: string, path: string) => documentRootClass(parse(src, path));

const DB = 'Cosmoteer.Data.BuiltinShipsDatabase';

describe('builtin_ships file rooting', () => {
    // A leaf builtin-ships file carries file-level defaults (Faction/Tags) and a `Ships` list of ship
    // blueprints. It roots as BuiltinShipsDatabase (custom-deserialized; its members are supplied by the
    // schema overlay), so the ships list and its blueprints resolve for completion and validation.
    it('roots a leaf builtin-ships file as BuiltinShipsDatabase', () => {
        const src = `Faction = cabal
Tags = [civilian]

Ships
[
	:~{ File="Missionary.ship.png"; Tier=3 }
]`;
        expect(rootOf(src, 'Cabal/Civilian/builtins_cabal_civilian.rules')).toBe(DB);
    });

    // The concat index files carry only a `Ships` member (assembled from other files), and still root.
    it('roots a concat builtin-ships file that only declares Ships', () => {
        expect(rootOf('Ships\n[\n]\n', 'builtins.rules')).toBe(DB);
    });

    // The required-field guard keeps a stray file under the folder that has no `Ships` from mis-rooting.
    it('does not root a builtin_ships file without a top-level Ships field', () => {
        expect(rootOf('Faction = cabal\nTags = [civilian]\n', 'notes.rules')).toBeUndefined();
    });

    // The overlay supplies `Ships` as a list of BuiltinShipRules, so the blueprints inside it are typed
    // and validated. Here an integer `Tier` written as a fraction is flagged.
    it('types the ship blueprints so their fields validate', async () => {
        expect(fieldOf(DB, 'Ships')?.valueType).toMatchObject({ kind: 'list' });
        const doc = parse('Ships\n[\n\t:~{ File="x.ship.png"; Tier=3.5 }\n]\n', 'Cabal/Civilian/x.rules');
        const errors = await validateSchema(doc, token);
        expect(errors.some((e) => /whole number/i.test(e.message))).toBe(true);
    });
});
