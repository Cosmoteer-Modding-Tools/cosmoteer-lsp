import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { MentionIndex } from '../../../src/features/navigation/mention.index';
import {
    unreachableConstants,
    validateUnusedConstants,
} from '../../../src/features/diagnostics/validator.unused-constant';

const token = CancellationToken.None;
const parse = (text: string, uri = 'file:///mod/parts/turret.rules') => parser(lexer(text), uri).value;
const namesOf = (text: string): string[] =>
    unreachableConstants(parse(text)).map((entry) => entry.declaration.name);

describe('unused constants, in-document reachability', () => {
    it('says nothing about a constant a field reads', () => {
        expect(
            namesOf(`Part
{
    HEAT_MAX = 5
    Heat = (&HEAT_MAX)
}
`)
        ).toEqual([]);
    });

    it('reports a constant no reference reads', () => {
        expect(
            namesOf(`Part
{
    HEAT_MAX = 5
    Heat = 3
}
`)
        ).toEqual(['HEAT_MAX']);
    });

    it('reports a whole chain of constants that never reaches a field', () => {
        const entries = unreachableConstants(
            parse(`Part
{
    BASE_HEAT = 5
    SCALED_HEAT = (&BASE_HEAT) * 2
    Heat = 3
}
`)
        );
        expect(entries.map((entry) => entry.declaration.name)).toEqual(['BASE_HEAT', 'SCALED_HEAT']);
        // The tail of the chain is read by nobody, the head only by the dead tail.
        expect(entries.map((entry) => entry.read)).toEqual([true, false]);
    });

    it('says nothing about a chain whose last link a field reads', () => {
        expect(
            namesOf(`Part
{
    BASE_HEAT = 5
    SCALED_HEAT = (&BASE_HEAT) * 2
    Heat = (&SCALED_HEAT)
}
`)
        ).toEqual([]);
    });

    it('says nothing about a constant read from a quoted expression string', () => {
        expect(
            namesOf(`Part
{
    BASE_HEAT = 5
    Heat = ceil("(&BASE_HEAT) / 2")
}
`)
        ).toEqual([]);
    });

    it('says nothing about a constant read through an inheritance list', () => {
        expect(
            namesOf(`Part
{
    BASE_EFFECT
    {
        Size = 2
    }
    Effect : &~/Part/BASE_EFFECT
    {
    }
}
`)
        ).toEqual([]);
    });

    it('reports an unread constant group once, not its members', () => {
        const entries = unreachableConstants(
            parse(`Part
{
    BASE_EFFECT
    {
        INNER_SIZE = 2
        Size = (&INNER_SIZE)
    }
    Heat = 3
}
`)
        );
        expect(entries.map((entry) => entry.declaration.name)).toEqual(['BASE_EFFECT']);
        // The remove fix spans the group's whole body, so the members go with it.
        expect(entries[0].declaration.range.end).toBeGreaterThan(entries[0].declaration.range.start + 'BASE_EFFECT'.length);
    });

    it('says nothing about a group an id field names by plain value', () => {
        // A component group's name is its id, read back by a schema id field without any reference
        // syntax. Missing this made every id-declaring group in a mod look unread.
        expect(
            namesOf(`Part
{
    Components
    {
        CRAM_AMMOSTORAGE : ~/BaseAmmoStorage
        {
        }
    }
    Sounds
    {
        ComponentID = CRAM_AMMOSTORAGE
    }
}
`)
        ).toEqual([]);
    });

    it('treats a name the schema declares as a field, whatever its casing', () => {
        // The game looks members up case-insensitively, so `RANGE` really is read as `Range`.
        expect(
            namesOf(`Part
{
    RANGE = 5
}
`)
        ).toEqual([]);
    });

    it('leaves a SCREAMING member of an instantiating map alone', () => {
        // A `Components` entry runs because it is in the map, not because anything spells its name,
        // so `FTL_DRIVE`-style component ids are live parts of the game's data, never constants.
        expect(
            namesOf(`Part
{
    Components
    {
        LASER_GRAPHICS
        {
            Location = [0, 0]
        }
    }
}
`)
        ).toEqual([]);
    });

    it('keeps constants a component reads alive', () => {
        // A component is game data, so a read written inside it reaches the constant like any
        // field's read does.
        expect(
            namesOf(`Part
{
    LASER_COLOR = 5
    Components
    {
        GRAPHICS_THING
        {
            Color = (&~/Part/LASER_COLOR)
        }
    }
}
`)
        ).toEqual([]);
    });

    it('leaves a one-letter key alone', () => {
        expect(
            namesOf(`Part
{
    Offset
    {
        X = 1
        Y = 2
    }
}
`)
        ).toEqual([]);
    });
});

describe('unused constants, cross-file evidence', () => {
    let dir: string;

    const write = (name: string, source: string): void => writeFileSync(join(dir, name), source);
    const validate = async (name: string) => {
        const path = join(dir, name);
        const uri = pathToFileURL(path).href;
        const document = parser(lexer(readBack(name)), uri).value;
        return validateUnusedConstants(document, [dir], token);
    };
    const sources = new Map<string, string>();
    const readBack = (name: string): string => sources.get(name)!;
    const put = (name: string, source: string): void => {
        sources.set(name, source);
        write(name, source);
    };

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'unused-const-'));
    });
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
        MentionIndex.instance.reset();
    });

    it('reports a constant no file in the project spells', async () => {
        MentionIndex.instance.reset();
        put('turret.rules', 'Part\n{\n\tHEAT_MAX = 5\n\tHeat = 3\n}\n');
        const errors = await validate('turret.rules');
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain("'HEAT_MAX'");
        expect(errors[0].severity).toBe('hint');
        expect(errors[0].unnecessary).toBe(true);
        expect(errors[0].data?.remove?.title).toBe("Remove 'HEAT_MAX'");
    });

    it('stays silent when another file reads the constant', async () => {
        MentionIndex.instance.reset();
        put('base.rules', 'Part\n{\n\tHEAT_MAX = 5\n\tHeat = 3\n}\n');
        put('derived.rules', 'Part : <base.rules>/Part\n{\n\tHeat = (&~/Part/HEAT_MAX)\n}\n');
        expect(await validate('base.rules')).toHaveLength(0);
    });

    it('stays silent when another file spells a constant nested in the group', async () => {
        MentionIndex.instance.reset();
        put('effects.rules', 'Part\n{\n\tBASE_EFFECT\n\t{\n\t\tINNER_SIZE = 2\n\t}\n}\n');
        put('reader.rules', 'Part\n{\n\tSize = (&<effects.rules>/Part/BASE_EFFECT/INNER_SIZE)\n}\n');
        expect(await validate('effects.rules')).toHaveLength(0);
    });

    it('still reports when another file only declares the same name', async () => {
        // The copied-template idiom: two files declare `SHOT_DAMAGE` and neither reads it. A
        // declaration is not a read, so the copies do not vouch for each other.
        MentionIndex.instance.reset();
        put('shot_a.rules', 'Part\n{\n\tSHOT_DAMAGE = 5\n\tDamage = 3\n}\n');
        put('shot_b.rules', 'Part\n{\n\tSHOT_DAMAGE = 7\n\tDamage = 4\n}\n');
        const errors = await validate('shot_a.rules');
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain("'SHOT_DAMAGE'");
    });

    it('protects every copy of a name once any file reads it', async () => {
        // A read is matched by name, not resolved, so a file reading its own `SHOT_SPEED` keeps the
        // unread copy in the sibling file silent. Deliberate: a cross-file path could just as well
        // reach that copy, and no verdict is worth a false positive.
        MentionIndex.instance.reset();
        put('speed_a.rules', 'Part\n{\n\tSHOT_SPEED = 5\n\tSpeed = 3\n}\n');
        put('speed_b.rules', 'Part\n{\n\tSHOT_SPEED = 7\n\tSpeed = (&~/Part/SHOT_SPEED)\n}\n');
        expect(await validate('speed_a.rules')).toHaveLength(0);
    });

    it('keeps a whole chain silent when another file reads its last link', async () => {
        // The cross-file read of SHOT_SPEED must feed the in-file chain: SPEED_BASE lives through
        // it, and flagging SPEED_BASE would offer a remove fix that breaks SHOT_SPEED's value.
        MentionIndex.instance.reset();
        put('chain.rules', 'Part\n{\n\tSPEED_BASE = 5\n\tSHOT_SPEED = (&SPEED_BASE) * 2\n}\n');
        put('chain_reader.rules', 'Part\n{\n\tSpeed = (&<chain.rules>/Part/SHOT_SPEED)\n}\n');
        expect(await validate('chain.rules')).toHaveLength(0);
    });

    it('still reports when the only read of the name sits in a comment', async () => {
        MentionIndex.instance.reset();
        put('dead.rules', 'Part\n{\n\tLONE_SPEED = 5\n\tSpeed = 3\n}\n');
        put('mentions.rules', 'Part\n{\n\t// Speed = (&<dead.rules>/Part/LONE_SPEED)\n\tSpeed = 4\n}\n');
        const errors = await validate('dead.rules');
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain("'LONE_SPEED'");
    });

    it('sees a reader created on disk after the index was built', async () => {
        // The watcher only marks the new file dirty; judging against the un-synced table would
        // condemn a constant the new file reads.
        MentionIndex.instance.reset();
        put('const.rules', 'Part\n{\n\tLATE_HEAT = 5\n\tHeat = 3\n}\n');
        expect(await validate('const.rules')).toHaveLength(1);
        put('late_reader.rules', 'Part\n{\n\tHeat = (&<const.rules>/Part/LATE_HEAT)\n}\n');
        MentionIndex.instance.markDirty(join(dir, 'late_reader.rules'));
        expect(await validate('const.rules')).toHaveLength(0);
    });

    it('leaves a file outside the searched folders alone', async () => {
        MentionIndex.instance.reset();
        const outside = parse('Part\n{\n\tHEAT_MAX = 5\n\tHeat = 3\n}\n', 'file:///elsewhere/turret.rules');
        expect(await validateUnusedConstants(outside, [dir], token)).toHaveLength(0);
    });
});
