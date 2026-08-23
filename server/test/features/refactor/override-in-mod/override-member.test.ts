import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { AbstractNode, AbstractNodeDocument } from '../../../../src/core/ast/ast';
import { isTypableTargetPath } from '../../../../src/mod/action-rooting.index';
import {
    OverrideMemberResult,
    overrideGroupName,
    overrideMemberAt,
} from '../../../../src/features/refactor/override-in-mod/override-member';
import { stepIntoNode } from '../../../../src/semantics/reference-resolver';
import { parseText } from '../../../../src/utils/ast.utils';
import { FIXTURES_DIR } from '../../../helpers';

// The half of the feature that decides what may be overridden and what the entry says. It reads a
// stand-in game install and writes nothing, so every refusal can be pinned without a mod in sight.
const FIXTURE = join(FIXTURES_DIR, 'override-in-mod-mod').replace(/\\/g, '/');
const DATA_DIR = `${FIXTURE}/Data`;
const CANNON = `${DATA_DIR}/parts/cannon/cannon.rules`;
const TERRAN = `${DATA_DIR}/ships/terran.rules`;
const ODD = `${DATA_DIR}/parts/odd.rules`;
const NUMBERED = `${DATA_DIR}/parts/numbered.rules`;

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The override for the member the needle names, read out of a real fixture file. */
const at = (fsPath: string, needle: string, skew = 1): OverrideMemberResult => {
    const text = read(fsPath);
    return overrideMemberAt(parseText(text, fsPath), text, text.indexOf(needle) + skew, fsPath, DATA_DIR);
};

/** The override for a member of a file written inline, for shapes a fixture cannot hold. */
const inText = (text: string, needle: string): OverrideMemberResult => {
    const fsPath = `${DATA_DIR}/parts/inline.rules`;
    return overrideMemberAt(parseText(text, fsPath), text, text.indexOf(needle) + 1, fsPath, DATA_DIR);
};

/** The member of a result, asserting it was not refused. */
const member = (result: OverrideMemberResult) => {
    if ('refusal' in result) throw new Error(`expected an override, got ${result.refusal}`);
    return result.member;
};

/** The refusal of a result, asserting nothing was emitted. */
const refusal = (result: OverrideMemberResult): string => {
    if (!('refusal' in result)) throw new Error(`expected a refusal, got ${result.member.name}`);
    return result.refusal;
};

/** The node a path reaches, walked with the same stepper a reference path is resolved by. */
const walk = (document: AbstractNodeDocument, path: string): AbstractNode | null | undefined => {
    let current: AbstractNode | null | undefined = document;
    for (const segment of path.split('/').filter((part) => part.length > 0)) {
        if (!current) return current;
        current = stepIntoNode(current, segment);
    }
    return current;
};

describe('the member an override is built for', () => {
    it('targets the group that holds the value, not the part around it', () => {
        const found = member(at(CANNON, 'Damage = 12'));
        expect(found.name).toBe('Damage');
        expect(found.target).toBe('<parts/cannon/cannon.rules>/Part/Components/Weapon');
        expect(found.body).toBe('\t\t\tDamage = 12');
        expect(found.replacesContainer).toBe(false);
    });

    it('targets the file itself for a member of its top level', () => {
        const found = member(at(TERRAN, 'Terran'));
        expect(found.name).toBe('Terran');
        expect(found.target).toBe('<ships/terran.rules>');
        expect(found.replacesContainer).toBe(true);
    });

    it('emits exactly one level, whatever the caret sits on', () => {
        // The game replaces the whole child per entry, so a body nested one step deeper than the
        // target would delete every sibling under the node it nests through.
        for (const needle of ['Density = 5', 'Damage = 12', 'Weapon', 'Sizes', 'Nested']) {
            const found = member(at(CANNON, needle));
            expect(found.body.startsWith(`\t\t\t${found.name}`)).toBe(true);
            const first = found.body.split('\n')[0].trim();
            expect(first.startsWith(found.name)).toBe(true);
        }
    });

    it('keeps a group member whole, bases and all, rather than copying half of it', () => {
        const found = member(at(CANNON, 'Weapon'));
        expect(found.name).toBe('Weapon');
        expect(found.body).toBe('\t\t\tWeapon\n\t\t\t{\n\t\t\t\tDamage = 12\n\t\t\t\tReload = 2\n\t\t\t}');
        expect(found.replacesContainer).toBe(true);
    });

    it('finds a bare void field and an assignment to an anonymous group alike', () => {
        expect(member(at(CANNON, 'v_Faction')).body).toBe('\t\t\tv_Faction');
        expect(member(at(CANNON, 'Nested')).body).toBe('\t\t\tNested = { A = 1 }');
    });

    it('names the whole list as the entry when the caret is on the list head', () => {
        const found = member(at(CANNON, 'Sizes'));
        expect(found.target).toBe('<parts/cannon/cannon.rules>/Part');
        expect(found.body).toBe('\t\t\tSizes\n\t\t\t[\n\t\t\t\t2\n\t\t\t\t1\n\t\t\t]');
        expect(found.replacesContainer).toBe(true);
    });
});

describe('the paths an override carries', () => {
    it('re-expresses a file-relative reference against the game folder', () => {
        expect(member(at(CANNON, 'BaseRef')).body).toBe('\t\t\tBaseRef = &<./Data/parts/base_part.rules>/Part');
    });

    it('re-expresses an asset path against the game folder', () => {
        expect(member(at(CANNON, 'Icon =')).body).toBe('\t\t\tIcon = "./Data/parts/cannon/sprites/icon.png"');
    });

    it('leaves a reference that already reads from the game folder alone', () => {
        expect(member(at(CANNON, 'RootRef')).body).toBe('\t\t\tRootRef = &<./Data/parts/base_part.rules>/Part');
    });

    it('never emits a target with a numeric or navigation segment', () => {
        for (const needle of ['Density = 5', 'Damage = 12', 'Icon =', 'BaseRef', 'Weapon', 'Sizes']) {
            const found = member(at(CANNON, needle));
            expect(isTypableTargetPath(found.target)).toBe(true);
            expect(/\/\d+(\/|$)/.test(found.target)).toBe(false);
        }
    });

    it('walks back to the very member it was built from', () => {
        const text = read(CANNON);
        const document = parseText(text, CANNON);
        for (const needle of ['ID =', 'Density = 5', 'Damage = 12', 'Reload', 'Icon =', 'Weapon', 'Sizes']) {
            const found = member(at(CANNON, needle));
            const path = [...found.targetPath, found.name].join('/');
            const landed = walk(document, path) as AbstractNode | null | undefined;
            expect(landed).toBeTruthy();
            // The node the path reaches is the member's own value, so it starts inside the span the
            // body was cut from. Comparing spans rather than object identity is what makes the same
            // check usable against a second parse of the same file.
            expect(landed!.position.start).toBeGreaterThanOrEqual(found.span.start);
            expect(landed!.position.start).toBeLessThan(found.span.end);
            expect(text.slice(found.span.start, found.span.end).startsWith(found.name)).toBe(true);
        }
    });
});

describe('what an override refuses', () => {
    it('refuses a caret inside a list, whose elements the game addresses by position', () => {
        const text = read(CANNON);
        const result = overrideMemberAt(parseText(text, CANNON), text, text.indexOf('\t\t2'), CANNON, DATA_DIR);
        expect(refusal(result)).toBe('insideList');
    });

    it('refuses a container hop written as a number', () => {
        expect(refusal(at(NUMBERED, 'Value'))).toBe('indexSegment');
    });

    it('refuses a container hop the game reads as navigation rather than as a name', () => {
        expect(refusal(at(ODD, 'Value'))).toBe('untypablePath');
    });

    it('refuses a later member whose name an earlier one already answers to', () => {
        expect(refusal(at(CANNON, 'Twice = 2'))).toBe('shadowedName');
    });

    it('refuses a member that declares bases of its own', () => {
        expect(refusal(at(CANNON, 'Inherited'))).toBe('inheritedMember');
    });

    it('refuses a value that reaches outside itself', () => {
        expect(refusal(at(CANNON, 'Scoped'))).toBe('scopeRelativeValue');
    });

    it('refuses a path that cannot be re-expressed, rather than writing one that names nothing', () => {
        expect(refusal(at(CANNON, 'Missing'))).toBe('unrebasablePath');
    });

    it('refuses a member with no value and one whose text runs across a line break', () => {
        expect(refusal(inText('G\n{\n\tA = 1\n\tEmpty =\n}\n', 'Empty'))).toBe('emptyMember');
        expect(refusal(inText('G\n{\n\tText = @"one\ntwo"\n\tB = 1\n}\n', 'Text'))).toBe('multiLineText');
    });

    it('refuses a member of a block written with no name in front of it', () => {
        expect(refusal(inText('{\n\tValue = 1\n}\n', 'Value'))).toBe('unnamedMember');
    });

    it('refuses an offset that names no member of the file', () => {
        const text = read(CANNON);
        expect(refusal(overrideMemberAt(parseText(text, CANNON), text, 0, CANNON, DATA_DIR))).toBe('stale');
    });
});

describe('the group name a fragment file uses', () => {
    it('is the last segment of the target path', () => {
        expect(overrideGroupName(['Part', 'Components'], CANNON)).toBe('Components');
    });

    it('falls back to the file name when the whole file is the target', () => {
        expect(overrideGroupName([], CANNON)).toBe('cannon');
        expect(overrideGroupName([], `${DATA_DIR}/parts/2x2.rules`)).toBe('Overrides_2x2');
    });
});
