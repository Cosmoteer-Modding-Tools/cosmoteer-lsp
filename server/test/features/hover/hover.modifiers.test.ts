import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Position } from 'vscode-languageserver';
import { HoverService } from '../../../src/features/hover/hover.service';
import { AbstractNodeDocument, isGroupNode } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { walkAst } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;

/** Position over the identifier of the named group, the "hover the member name" case. */
const groupPosition = (doc: AbstractNodeDocument, name: string): Position => {
    for (const node of walkAst(doc)) {
        if (isGroupNode(node) && node.identifier?.name === name) {
            const p = node.identifier.position;
            return Position.create(p.line, p.characterStart + 1);
        }
    }
    throw new Error(`group ${name} not found`);
};

/** Hovers the named group of an inline source, parsed under a throwaway uri. */
const hoverGroup = async (source: string, name: string): Promise<string> => {
    const doc = parser(lexer(source), 'file:///inline.rules').value;
    const hover = await HoverService.instance.getHover(doc, groupPosition(doc, name), token);
    if (!hover) return '';
    return (hover.contents as { value: string }).value;
};

/**
 * A part whose `ThrusterForce` is written in the group form. `ThrusterForce` is a ModifiableFloat on
 * PartRules, so its group form resolves to Cosmoteer.Ships.ModifiableValue, the shape this renders.
 * Members are written one per line: the game folds a member that follows a value on the same line
 * into that value, and the parser models it.
 */
const part = (...lines: string[]): string =>
    ['Part', '{', '\tID = test.thruster', '\tThrusterForce', '\t{', ...lines.map((line) => `\t\t${line}`), '\t}', '}', ''].join(
        '\n'
    );

/** A modifier written as its own list element, one member per line. */
const modifier = (...members: string[]): string[] => ['{', ...members.map((member) => `\t${member}`), '}'];

// A modifiable value shows one base number in the file while the value the game runs on is that
// number folded through its modifiers, driven by a buff some other part supplies.
describe('hover modifier trace', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    afterEach(() => {
        globalSettings.hover.showModifiers = true;
    });

    it('lists a modifier with what drives it, its mode and its clamp', async () => {
        const text = await hoverGroup(
            part(
                'BaseValue = 10',
                'Modifiers',
                '[',
                ...modifier('Type = Buff', 'BuffType = Overclock', 'ModificationMode = Lerp', 'MinValue = 1', 'MaxValue = 3'),
                ']'
            ),
            'ThrusterForce'
        );
        expect(text).toContain('base 10, 1 modifier');
        expect(text).toContain('**Buff**');
        expect(text).toContain('`Overclock`');
        expect(text).toContain('Lerp');
        expect(text).toContain('clamped to 1 … 3');
    });

    it('renders the clamp the whole value ends on', async () => {
        const text = await hoverGroup(
            part(
                'BaseValue = 10',
                'MinValue = 0.5',
                'MaxValue = 4',
                'Modifiers',
                '[',
                ...modifier('Type = Buff', 'BuffType = Overclock', 'ModificationMode = Multiply'),
                ']'
            ),
            'ThrusterForce'
        );
        expect(text).toContain('result clamped to 0.5 … 4');
    });

    it('says an inline shortcut is ignored when an explicit list is written', async () => {
        const text = await hoverGroup(
            part(
                'BaseValue = 10',
                'BuffType = Overclock',
                'Modifiers',
                '[',
                ...modifier('Type = Status', 'StatusType = Heat', 'ModificationMode = Multiply'),
                ']'
            ),
            'ThrusterForce'
        );
        expect(text).toContain('`BuffType` is ignored here');
    });

    it('reads the inline shortcut form when no list is written', async () => {
        const text = await hoverGroup(
            part('BaseValue = 10', 'BuffType = Overclock', 'BuffMode = Multiply'),
            'ThrusterForce'
        );
        expect(text).toContain('**Buff**');
        expect(text).toContain('`Overclock`');
        expect(text).toContain('Multiply');
    });

    it('defaults the mode of an inline shortcut the way the game does', async () => {
        const text = await hoverGroup(part('BaseValue = 10', 'BuffType = Overclock'), 'ThrusterForce');
        expect(text).toContain('Replace');
    });

    it('flags a modifier the game would throw on', async () => {
        const text = await hoverGroup(
            part('BaseValue = 10', 'Modifiers', '[', ...modifier('Type = Buff', 'BuffType = Overclock'), ']'),
            'ThrusterForce'
        );
        expect(text).toContain('no `ModificationMode`');
    });

    it('says the inherited modifiers run first rather than renumbering', async () => {
        const text = await hoverGroup(
            part(
                'BaseValue = 10',
                'Modifiers : ^/0/Modifiers',
                '[',
                ...modifier('Type = Buff', 'BuffType = Overclock', 'ModificationMode = Add'),
                ']'
            ),
            'ThrusterForce'
        );
        expect(text).toContain('inherited modifiers run first');
    });

    it('writes no number it cannot prove', async () => {
        const text = await hoverGroup(
            part(
                'BaseValue = 10',
                'Modifiers',
                '[',
                ...modifier('Type = EffectScale', 'Exponent = 2', 'ModificationMode = Multiply'),
                ']'
            ),
            'ThrusterForce'
        );
        expect(text).toContain('**EffectScale**');
        expect(text).toContain('Exponent 2');
        // Nothing in the file supplies a runtime effect scale, so no result is claimed.
        expect(text).not.toContain('= 20');
    });

    it('is silent when the setting is off', async () => {
        globalSettings.hover.showModifiers = false;
        const text = await hoverGroup(
            part('BaseValue = 10', 'Modifiers', '[', ...modifier('Type = Buff', 'BuffType = Overclock'), ']'),
            'ThrusterForce'
        );
        expect(text).not.toContain('**Buff**');
    });

    it('adds nothing to a modifiable value that carries no modifiers', async () => {
        const text = await hoverGroup(part('BaseValue = 10'), 'ThrusterForce');
        expect(text).not.toContain('**Modifiers**');
    });
});
