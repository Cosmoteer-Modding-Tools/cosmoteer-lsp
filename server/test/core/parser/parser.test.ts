import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { readFixture, stripParents } from '../../helpers';

const parse = (source: string, uri = 'file:///test.rules') => {
    const result = parser(lexer(source), uri);
    return {
        value: stripParents(result.value),
        parserErrors: result.parserErrors.map((e) => ({ message: e.message, token: e.token })),
    };
};

describe('parser', () => {
    it('parses inheritance and assignments into an AST', () => {
        expect(parse(readFixture('inheritance.rules'))).toMatchSnapshot();
    });

    it('parses internal references (~/ and ../) and math expressions', () => {
        expect(parse(readFixture('colors.rules'))).toMatchSnapshot();
    });

    it('accepts a numeric inheritance target as an index reference (no parse error)', () => {
        // `: N` is valid Cosmoteer syntax (inherit from the sibling at index N), so it
        // must NOT produce a parse error and is normalized to a relative `&N` reference.
        const { value, parserErrors } = parse(readFixture('error-inheritance.rules'));
        expect(parserErrors).toEqual([]);
        const test = value.elements.find(
            (e) => 'identifier' in e && (e as { identifier?: { name?: string } }).identifier?.name === 'Test'
        ) as { inheritance?: { valueType: { value: string } }[] };
        expect(test.inheritance?.[0]?.valueType.value).toBe('&12356');
    });

    it('lexes a `MM:SS`/`HH:MM:SS` time literal as a single value (not an inheritance colon)', () => {
        // Regression: `TimeLimit = 30:00` made the `:` parse as inheritance, corrupting the
        // rest of the group (e.g. cosmoteer modes/career/sectors/sector_basic.rules).
        const { value, parserErrors } = parse('Mission\n{\n\tTimeLimit = 30:00\n\tRetries = 3:00:00\n\tNext = 2\n}\n');
        expect(parserErrors).toEqual([]);
        const mission = value.elements.find(
            (e) => 'identifier' in e && (e as { identifier?: { name?: string } }).identifier?.name === 'Mission'
        ) as { elements: { left?: { name: string }; right?: { valueType?: { value: unknown } } }[] };
        const timeLimit = mission.elements.find((e) => e.left?.name === 'TimeLimit');
        expect(timeLimit?.right?.valueType?.value).toBe('30:00');
        // `Child : Parent` inheritance must still work (the value there is not all digits).
        expect(parse('A { x = 1 }\nB : A\n{\n}\n').parserErrors).toEqual([]);
    });

    it('lexes scientific notation as a single Number value (incl. `E+38`)', () => {
        // Regression: `MaxEmissionZoom = 3.4028235E+38` split at `+`, becoming a math
        // expression whose operand `3.4028235E` is a String (flagged by the math validator).
        for (const [src, expected] of [
            ['X = 3.4028235E+38\n', 3.4028235e38],
            ['X = 3.4028235E-38\n', 3.4028235e-38],
            ['X = 1.5e10\n', 1.5e10],
        ] as const) {
            const { value, parserErrors } = parse(src);
            expect(parserErrors).toEqual([]);
            const right = (value.elements[0] as { right?: { type: string; valueType?: { type: string; value: unknown } } })
                .right;
            expect(right?.type).toBe('Value');
            expect(right?.valueType?.type).toBe('Number');
            expect(right?.valueType?.value).toBe(expected);
        }
        // `3 + 5` is still a math expression, not a number.
        expect((parse('X = 3 + 5\n').value.elements[0] as { right?: { type: string } }).right?.type).toBe(
            'MathExpression'
        );
    });

    it('consumes a trailing math expression as the assignment value (not orphaned)', () => {
        // Regression: `XXLChance = 1/16` left `/16` orphaned, which then swallowed the next
        // identifier (`CommonAsteroidTypes` in cosmoteer sysgen_asteroids.rules became an
        // unnamed list). The value must be the whole `1/16` and the list must keep its name.
        const src = 'XXLChance = 1/16\nList\n[\n\t{ W=(&~/a)*(&~/b); }\n]\nAfter = 5\n';
        const { value, parserErrors } = parse(src);
        expect(parserErrors).toEqual([]);
        const kinds = value.elements.map((e) =>
            e.type === 'Assignment'
                ? 'Assign:' + (e as { left: { name: string } }).left.name
                : e.type === 'List'
                  ? 'List:' + (e as { identifier?: { name?: string } }).identifier?.name
                  : e.type
        );
        expect(kinds).toEqual(['Assign:XXLChance', 'List:List', 'Assign:After']);
        const xxl = value.elements[0] as { right?: { type: string; elements?: unknown[] } };
        expect(xxl.right?.type).toBe('MathExpression');
        expect(xxl.right?.elements).toHaveLength(3); // 1 / 16
    });

    it('parses a function-call argument with a parenthesized reference operand (no false "right paren")', () => {
        // Regression (cosmoteer Star Wars mod Ion thruster parts): `ceil((1 / (&X)))` — a `( VALUE op …)`
        // first argument — wrongly took the `( VALUE )` shortcut and reported "Expected right paren for
        // reference", which then desynced paren matching and corrupted the rest of the file. The real OT
        // parser (OTFieldNode) reads the value as plain text and never validates parens at parse time.
        for (const src of [
            'POWER_USAGE_FACTOR = (ceil((1 / (&THRUST_FACTOR) * (&MAX_POWER_USAGE_FACTOR))*100)/100)\n',
            'A = ceil((1 / (&X)))\n',
            'A = ceil((1 / (&X) * (&Y)))\n',
            'A = floor((2 * (&X)) / (&Y))\n',
        ]) {
            expect(parse(src).parserErrors).toEqual([]);
        }
        // A member declared AFTER such a value is still reachable (parse did not desync).
        const { value, parserErrors } = parse('A = ceil((1 / (&X)))\nNext = 5\n');
        expect(parserErrors).toEqual([]);
        expect(
            value.elements.find(
                (e) => e.type === 'Assignment' && (e as { left?: { name?: string } }).left?.name === 'Next'
            )
        ).toBeTruthy();
    });

    it('reads a bare `(` value as a literal without crashing (cosmoteer strings/ja.rules)', () => {
        // Regression: `LeftBracket = (` (a keyboard-key glossary mapping a name to the literal `(`)
        // made the parser treat `(` as the start of an expression group, run across the following
        // fields, build an `Assignment` operand with no position, then THROW on `node.position`.
        // OT reads a bare `(` as the string "(". Must not throw, must not error, and the following
        // fields must still parse.
        const src = 'Keys\n{\n\tLeftBracket = (\n\tM = "x"\n\tN = "y"\n}\n';
        let result!: ReturnType<typeof parse>;
        expect(() => {
            result = parse(src);
        }).not.toThrow();
        expect(result.parserErrors).toEqual([]);
        const keys = result.value.elements.find(
            (e) => 'identifier' in e && (e as { identifier?: { name?: string } }).identifier?.name === 'Keys'
        ) as { elements: { left?: { name: string } }[] };
        // All three fields survived (the `(` did not swallow `M` and `N`).
        expect(keys.elements.map((e) => e.left?.name)).toEqual(['LeftBracket', 'M', 'N']);
    });

    it('reads a bare/embedded `)` as literal value text, not a paren error (cosmoteer strings)', () => {
        // `RightBracket = )` and values ending in `)` such as `AsteroidGold_S = Gold（S)` appear in
        // cosmoteer string files. A `)` reaching the top level is unmatched (paren groups consume
        // their own close), and OT reads it as value text — it must not be "Not expected paren".
        expect(parse('Keys\n{\n\tRightBracket = )\n\tNext = "x"\n}\n').parserErrors).toEqual([]);
        expect(parse('AsteroidGold_S = Gold（S)\nNext = 5\n').parserErrors).toEqual([]);
    });

    it('treats a bare `/` value as a literal, not a cross-line super-path reference (cosmoteer strings)', () => {
        // Regression: `SlashQuestion = /` (value is the literal `/`) made `/` consume the NEXT line's
        // identifier as a super-path reference segment (`/Space`), orphaning that field and cascading
        // brace errors. A `/X` reference is always contiguous, so the segment must be on the SAME line.
        const { value, parserErrors } = parse('Keys\n{\n\tSlashQuestion = /\n\tSpace = "spc"\n}\n');
        expect(parserErrors).toEqual([]);
        const keys = value.elements.find(
            (e) => 'identifier' in e && (e as { identifier?: { name?: string } }).identifier?.name === 'Keys'
        ) as { elements: { left?: { name: string } }[] };
        expect(keys.elements.map((e) => e.left?.name)).toEqual(['SlashQuestion', 'Space']);
        // A genuine same-line super-path reference still parses as a Reference.
        const refDoc = parse('X = /SW_SOUNDS/Click\n');
        expect(refDoc.parserErrors).toEqual([]);
        const right = (refDoc.value.elements[0] as { right?: { valueType?: { type: string; value: unknown } } }).right;
        expect(right?.valueType?.type).toBe('Reference');
        expect(right?.valueType?.value).toBe('/SW_SOUNDS/Click');
    });

    it('parses `<number>-(...)` as subtraction, not a function call named "1-"', () => {
        // Regression (cosmoteer `control_room_large.rules`, `flak_cannon_large.rules`):
        // `1-(&X)` / `2.625-(12/64)` lexed `1-` as one value, so the parser built a FunctionCall
        // named "1-". A `-`/`/` immediately before `(` is a binary operator.
        for (const [src, opCount] of [
            ['X = 1-(&Y)\n', 1],
            ['X = 2.625-(12/64)\n', 1],
        ] as const) {
            const right = (parse(src).value.elements[0] as { right?: { type: string } }).right;
            expect(right?.type).toBe('MathExpression');
            void opCount;
        }
        // A hyphenated value (`a-b`) and a reference path (`&~/SIZE/0`) are NOT split.
        expect((parse('X = a-b\n').value.elements[0] as { right?: { valueType?: { value: unknown } } }).right?.valueType?.value).toBe('a-b');
    });

    it('keeps a trailing "!" in a non-numeric value (localized text like "KÄMPFEN!")', () => {
        // Regression (cosmoteer `strings/de.rules`: `Go = LOS!`): `!` is the factorial operator only
        // after a number; after letters it is a literal exclamation belonging to the value.
        expect((parse('Go = LOS!\n').value.elements[0] as { right?: { valueType?: { value: unknown } } }).right?.valueType?.value).toBe('LOS!');
        // A numeric factorial `5!` still splits into a math expression.
        expect((parse('X = 5!\n').value.elements[0] as { right?: { type: string } }).right?.type).toBe('MathExpression');
    });

    it('types a leading-dot decimal (.5, .75) as a Number, not a String', () => {
        // Regression (cosmoteer `gui/game/game_gui.rules`: `Bleed = .75 * .5`): the IS_NUMBER regex
        // anchored `^` mid-pattern, so `.5`/`.75` were typed as String — breaking value typing and
        // making the math validator report "expected Number … Got String".
        for (const [src, expected] of [
            ['X = .5\n', 0.5],
            ['X = .75\n', 0.75],
            ['X = .5e3\n', 500],
        ] as const) {
            const { value, parserErrors } = parse(src);
            expect(parserErrors).toEqual([]);
            const right = (value.elements[0] as { right?: { valueType?: { type: string; value: unknown } } }).right;
            expect(right?.valueType?.type).toBe('Number');
            expect(right?.valueType?.value).toBe(expected);
        }
        // `.75 * .5` is a MathExpression whose operands are both Numbers.
        const math = (parse('X = .75 * .5\n').value.elements[0] as { right?: { type: string; elements?: { valueType?: { type: string } }[] } }).right;
        expect(math?.type).toBe('MathExpression');
        expect(math?.elements?.filter((e) => e.valueType).every((e) => e.valueType?.type === 'Number')).toBe(true);
        // A time literal `30:00` and a version `1.2.3` are still NOT numbers.
        expect((parse('X = 1.2.3\n').value.elements[0] as { right?: { valueType?: { type: string } } }).right?.valueType?.type).toBe('String');
    });

    it('terminates a value at an unsuppressed newline so a broken expression keeps the next field', () => {
        // ObjectText ends a field value at an unsuppressed newline. An unclosed paren/call therefore
        // must NOT swallow the following line's field (it would in a newline-agnostic parser).
        const elementNames = (src: string) =>
            parse(src).value.elements.map(
                (e) => (e as { left?: { name?: string } }).left?.name ?? e.type
            );
        for (const src of ['X = ceil((&A + 3\nNext = 5\n', 'X = (5 + 3\nNext = 5\n', 'X = (&A\nNext = 5\n']) {
            // The following `Next = 5` survives as its own assignment (not consumed by the broken value).
            expect(elementNames(src)).toContain('Next');
        }
        // `X = 1\n+ 2` is `X = 1` plus an orphan — the `+ 2` is NOT folded into the value across the newline.
        const orphan = parse('X = 1\nY = 2\n');
        expect(orphan.parserErrors).toEqual([]);
        expect(orphan.value.elements.map((e) => (e as { left?: { name?: string } }).left?.name)).toEqual(['X', 'Y']);

        // A `\` line-continuation SUPPRESSES the newline, so a value may still span lines that way.
        const cont = parse('A = (1 + \\\n 2)\nNext = 5\n');
        expect(cont.parserErrors).toEqual([]);
        expect(cont.value.elements.map((e) => (e as { left?: { name?: string } }).left?.name)).toEqual(['A', 'Next']);
    });

    it('does not crash when a value is the last token in the file (EOF robustness)', () => {
        // Regression: building the position of a negative number / `/`-reference read `tokens[current]`
        // AFTER consuming the value, which is undefined when the value ends the file (`X = -5`,
        // `X = /Ref` with no trailing newline). Real files always have a following token, but a
        // truncated/being-typed buffer does not — the parser must never throw.
        for (const src of ['X = -99997', 'X = -5\n', 'X = /SW_SOUNDS/Click', 'G\n{\n\tSortOrder = -99997\n', 'A : B']) {
            expect(() => parse(src)).not.toThrow();
        }
        // `X = -5` (no newline) still yields the negative Number value.
        const right = (parse('X = -5').value.elements[0] as { right?: { valueType?: { type: string; value: unknown } } })
            .right;
        expect(right?.valueType?.type).toBe('Number');
        expect(right?.valueType?.value).toBe(-5);
    });

    it('parses a function call whose argument is a nested parenthesized math expression', () => {
        // Regression: `ceil(((&a)*4+(&b))/3)` used to make inferValueType throw on a
        // LEFT_PAREN, aborting the whole file's parse (and breaking every cross-file
        // reference INTO that file). It must parse without throwing and without errors.
        const src = 'BuyPrice = ceil(((&<./Data/a.rules>/A)*4+(&<./Data/b.rules>/B))/3)\nMaxStackSize = 40\n';
        const { value, parserErrors } = parse(src);
        expect(parserErrors).toEqual([]);
        // A member declared AFTER the function call is still reachable (parse continued).
        const maxStack = value.elements.find(
            (e) => e.type === 'Assignment' && (e as { left?: { name?: string } }).left?.name === 'MaxStackSize'
        );
        expect(maxStack).toBeTruthy();
    });
});
