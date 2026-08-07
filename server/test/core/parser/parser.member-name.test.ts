import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';

// The game reads a member name and then requires `=`, `:`, `{`, `[`, a terminator or a line break, it
// never lets a number name a member, and it demands a body after an inheritance. Each of those makes
// Halfling.ObjectText throw so the whole file fails to load, and every positive case here is the shape
// of a workshop file the game refuses.
const parse = (src: string) => parser(lexer(src), 'file:///t.rules');

const errorsMatching = (src: string, message: string) =>
    parse(src).parserErrors.filter((e) => e.message === message);

const NAME_MESSAGE = 'A member name must be followed by "=", ":", "{", "[" or the end of the line';
const NUMBER_MESSAGE = 'A number cannot name a member';
const BODY_MESSAGE = 'Expected a "{" or "[" body after the inheritance';

describe('prose where a member name belongs', () => {
    const findings = (src: string) => errorsMatching(src, NAME_MESSAGE);

    it('flags a sentence at the top of a file (dpmhshield_gen_small.rules)', () => {
        expect(findings('THIS IS A DUMMY FILE TO PREVENT THE MOD FROM CRASHING\nPart\n{\n}\n')).toHaveLength(1);
    });

    it('flags a paragraph of prose (wookiepedia.rules)', () => {
        expect(findings('A baradium missile was a type of missile used by the Galactic Alliance Guard.\n')).toHaveLength(
            1
        );
    });

    it('flags a name followed by another word on the same line', () => {
        expect(findings('G\n{\n\tFoo Bar\n}\n')).toHaveLength(1);
    });

    it('flags a hand-written note table (origin_list.rules), once per name it leaves behind', () => {
        expect(findings('chaingun_bullet.shader\t<- ./Data/shots/chaingun_shot\n')).toHaveLength(2);
    });

    it('flags a name followed by a quoted string on the same line', () => {
        expect(findings('G\n{\n\tFoo "bar"\n}\n')).toHaveLength(1);
    });

    it('accepts a void node on its own line', () => {
        expect(findings('G\n{\n\tFoo\n\tBar = 1\n}\n')).toHaveLength(0);
    });

    it('accepts a void node terminated by a semicolon', () => {
        expect(findings('G\n{\n\tFoo;\n\tBar = 1\n}\n')).toHaveLength(0);
    });

    it('accepts a name followed by every legal continuation', () => {
        expect(findings('A = 1\nB : Base { }\nC { }\nD [ ]\n')).toHaveLength(0);
    });

    it('accepts a void node as the last member of a group', () => {
        expect(findings('G { Foo }\n')).toHaveLength(0);
    });

    it('accepts words in a list element, which is not a member', () => {
        expect(findings('L\n[\n\ta baradium missile\n]\n')).toHaveLength(0);
    });

    it('accepts an unquoted localization value full of words', () => {
        expect(findings('Key = Press X to continue\n')).toHaveLength(0);
    });
});

describe('a number where a member name belongs', () => {
    const findings = (src: string) => errorsMatching(src, NUMBER_MESSAGE);

    it('flags a numbered group member', () => {
        expect(findings('G\n{\n\t0\n\t{\n\t\tA = 1\n\t}\n}\n')).toHaveLength(1);
    });

    it('flags a numbered member at document level', () => {
        expect(findings('0\n{\n\tA = 1\n}\n')).toHaveLength(1);
    });

    it('accepts a number as a list element', () => {
        expect(findings('L\n[\n\t0\n\t1\n]\n')).toHaveLength(0);
        expect(findings('L = [0, 1]\n')).toHaveLength(0);
    });

    it('accepts a number as a list-form index field', () => {
        expect(findings('G\n{\n\t0 = 5\n\t1 = 6\n}\n')).toHaveLength(0);
    });

    it('accepts a number as a field value', () => {
        expect(findings('G\n{\n\tA = 0\n\tB = 1.5\n}\n')).toHaveLength(0);
    });

    it('accepts a number inside a math expression', () => {
        expect(findings('G\n{\n\tA = (&~/SIZE/0)/2 + 3\n}\n')).toHaveLength(0);
    });
});

describe('an inheritance with no body', () => {
    const findings = (src: string) => errorsMatching(src, BODY_MESSAGE);

    it('flags a named inheritance the file ends on', () => {
        expect(findings('Part : &<base.rules>/Part\n')).toHaveLength(1);
    });

    it('flags a named inheritance a group closer follows', () => {
        expect(findings('G\n{\n\tChild : Base\n}\n')).toHaveLength(1);
    });

    it('accepts an inheritance with a group body', () => {
        expect(findings('Child : Base { A = 1 }\n')).toHaveLength(0);
    });

    it('accepts an inheritance whose body opens on the next line', () => {
        expect(findings('Child : Base\n{\n\tA = 1\n}\n')).toHaveLength(0);
    });

    it('accepts an inheritance with a list body', () => {
        expect(findings('Categories : ^/0/Categories [ command ]\n')).toHaveLength(0);
    });

    it('accepts a line-leading inheritance in a list', () => {
        expect(findings('L\n[\n\t: ~/Base; { A = 1 }\n]\n')).toHaveLength(0);
    });

    it('accepts several inherited references before the body', () => {
        expect(findings('Components : ^/0/Components, &<doodads.rules> { A = 1 }\n')).toHaveLength(0);
    });
});
