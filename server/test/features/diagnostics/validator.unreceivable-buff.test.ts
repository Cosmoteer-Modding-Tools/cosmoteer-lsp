import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateUnreceivableBuffs } from '../../../src/features/diagnostics/validator.unreceivable-buff';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;

const parse = (source: string): AbstractNodeDocument => parser(lexer(source), 'file:///inline.rules').value;

/** A part group with the given body lines, written one member per line. */
const part = (...lines: string[]): string => ['Part', '{', '\tID = test.part', ...lines.map((l) => `\t${l}`), '}', ''].join('\n');

/** A `Modifiers` list holding one modifier group. */
const modifier = (...members: string[]): string[] => [
    'ThrusterForce',
    '{',
    '\tBaseValue = 10',
    '\tModifiers',
    '\t[',
    '\t\t{',
    ...members.map((m) => `\t\t\t${m}`),
    '\t\t}',
    '\t]',
    '}',
];

/** A `Components` block holding one buff toggle. */
const toggle = (...members: string[]): string[] => [
    'Components',
    '{',
    '\tOverclockToggle',
    '\t{',
    '\t\tType = BuffToggle',
    ...members.map((m) => `\t\t${m}`),
    '\t}',
    '}',
];

const messages = async (source: string): Promise<string[]> =>
    (await validateUnreceivableBuffs(parse(source), token)).map((error) => error.message);

// The rule under test is the game's: Part.OnAttaching registers the part with one buff manager per
// ReceivableBuffs entry and with nothing else, so a buff outside that set never reaches the part.
describe('unreceivable buff validator', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('flags a modifier whose buff the part does not list', async () => {
        const found = await messages(
            part('ReceivableBuffs = [ Engine ]', ...modifier('Type = Buff', 'BuffType = Overclock'))
        );
        expect(found).toHaveLength(1);
        expect(found[0]).toContain("never receives 'Overclock'");
    });

    it('says nothing when the part lists the buff', async () => {
        expect(
            await messages(part('ReceivableBuffs = [ Engine, Overclock ]', ...modifier('Type = Buff', 'BuffType = Overclock')))
        ).toEqual([]);
    });

    it('reads the buff set through the inheritance chain', async () => {
        const source = [
            'Base',
            '{',
            '\tReceivableBuffs = [ Overclock ]',
            '}',
            'Part : &Base',
            '{',
            '\tID = test.part',
            ...modifier('Type = Buff', 'BuffType = Overclock').map((l) => `\t${l}`),
            '}',
            '',
        ].join('\n');
        expect(await messages(source)).toEqual([]);
    });

    it('folds an inheriting list, the form vanilla writes the set in', async () => {
        // `ReceivableBuffs : ^/0/ReceivableBuffs [ … ]` prepends the base entries, which is how a
        // vanilla part picks up Overclock from a shared base without naming it again.
        const source = [
            'Base',
            '{',
            '\tReceivableBuffs = [ Overclock ]',
            '}',
            'Part : &Base',
            '{',
            '\tID = test.part',
            '\tReceivableBuffs : ^/0/ReceivableBuffs [ Engine ]',
            ...modifier('Type = Buff', 'BuffType = Overclock').map((l) => `\t${l}`),
            '}',
            '',
        ].join('\n');
        expect(await messages(source)).toEqual([]);
    });

    it('flags a buff the deriving part dropped by replacing the list instead of extending it', async () => {
        // Without an inheritance reference the list replaces the base's outright, so the base's
        // Overclock is gone. That distinction is the whole reason the check is decidable.
        const source = [
            'Base',
            '{',
            '\tReceivableBuffs = [ Overclock ]',
            '}',
            'Part : &Base',
            '{',
            '\tID = test.part',
            '\tReceivableBuffs = [ Engine ]',
            ...modifier('Type = Buff', 'BuffType = Overclock').map((l) => `\t${l}`),
            '}',
            '',
        ].join('\n');
        expect(await messages(source)).toHaveLength(1);
    });

    it('says nothing when a hop of the chain cannot be read', async () => {
        const source = [
            'Part : &NoSuchBase',
            '{',
            '\tID = test.part',
            ...modifier('Type = Buff', 'BuffType = Overclock').map((l) => `\t${l}`),
            '}',
            '',
        ].join('\n');
        expect(await messages(source)).toEqual([]);
    });

    it('says nothing about a part that declares no ID of its own', async () => {
        // A template completed by deriving files declares the modifier while the derivers declare
        // the buff set, so judging it in isolation would blame it for what they supply.
        const source = ['Part', '{', '\tReceivableBuffs = [ Engine ]', ...modifier('Type = Buff', 'BuffType = Overclock').map((l) => `\t${l}`), '}', ''].join('\n');
        expect(await messages(source)).toEqual([]);
    });

    it('leaves a buff a provider supplies to other parts alone', async () => {
        // A provider names the buff it hands out, which has nothing to do with what it receives.
        const source = part(
            'ReceivableBuffs = [ Engine ]',
            'Components',
            '{',
            '\tGiver',
            '\t{',
            '\t\tType = AreaBuffProvider',
            '\t\tBuffType = Overclock',
            '\t}',
            '}'
        );
        expect(await messages(source)).toEqual([]);
    });

    it('flags a self-provided buff the part is not registered to receive', async () => {
        // BuffManager only ever hands a buff to parts in its receiver table, so a part providing a
        // buff to itself without listing it receives nothing.
        const source = part(
            'ReceivableBuffs = [ Engine ]',
            'Components',
            '{',
            '\tGiver',
            '\t{',
            '\t\tType = SelfBuffProvider',
            '\t\tBuffType = Overclock',
            '\t}',
            '}',
            ...modifier('Type = Buff', 'BuffType = Overclock')
        );
        expect(await messages(source)).toHaveLength(1);
    });

    it('flags a clamp keyed by a buff the part never receives', async () => {
        const found = await messages(part('ReceivableBuffs = [ Engine ]', 'MaxBuffValues = { Overclock=100% }'));
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('never applied');
    });

    it('reports a stuck toggle without fading it or offering to remove it', async () => {
        const errors = await validateUnreceivableBuffs(
            parse(part('ReceivableBuffs = [ Engine ]', ...toggle('BuffType = Overclock', 'Invert = true'))),
            token
        );
        expect(errors).toHaveLength(1);
        // The toggle holds a state other components read, and it latches on rather than doing
        // nothing, so it is neither dead weight nor safe to delete.
        expect(errors[0].message).toContain('stays on for good');
        expect(errors[0].unnecessary).toBe(false);
        expect(errors[0].data?.remove).toBeUndefined();
    });

    it('offers to remove a whole modifier, whose span leaves nothing dangling', async () => {
        const errors = await validateUnreceivableBuffs(
            parse(part('ReceivableBuffs = [ Engine ]', ...modifier('Type = Buff', 'BuffType = Overclock'))),
            token
        );
        expect(errors[0].unnecessary).toBe(true);
        expect(errors[0].data?.remove).toBeDefined();
    });

    it('reports the inline shortcut without a removal, since its siblings would be left inert', async () => {
        const errors = await validateUnreceivableBuffs(
            parse(
                part(
                    'ReceivableBuffs = [ Engine ]',
                    'ThrusterForce',
                    '{',
                    '\tBaseValue = 10',
                    '\tBuffType = Overclock',
                    '\tBuffMode = Multiply',
                    '}'
                )
            ),
            token
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].data?.remove).toBeUndefined();
    });

    it('says nothing when an entry of the set cannot be read as a name', async () => {
        // An unreadable entry could be the very buff in question, so it disqualifies the whole set.
        expect(
            await messages(
                part('ReceivableBuffs = [ &SOME_CONSTANT ]', ...modifier('Type = Buff', 'BuffType = Overclock'))
            )
        ).toEqual([]);
    });
});
