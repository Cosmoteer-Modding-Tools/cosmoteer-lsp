import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, GroupNode, isDocumentNode, isGroupNode, isListNode } from '../../../src/core/ast/ast';
import { resolveGroupClass } from '../../../src/document/schema/schema-context';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';

const token = CancellationToken.None;
const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;

const childrenOf = (node: AbstractNode): AbstractNode[] =>
    isDocumentNode(node) || isGroupNode(node) || isListNode(node) ? node.elements : [];

const findGroup = (node: AbstractNode, id: string): GroupNode | undefined => {
    if (isGroupNode(node) && node.identifier?.name === id) return node;
    for (const k of childrenOf(node)) {
        const f = findGroup(k, id);
        if (f) return f;
    }
    return undefined;
};

/** The Nth anonymous group element of the list named `id`. */
const listEntry = (node: AbstractNode, id: string, index: number): GroupNode => {
    const walk = (n: AbstractNode): GroupNode | undefined => {
        if (isListNode(n) && n.identifier?.name === id) {
            return n.elements.filter(isGroupNode)[index];
        }
        for (const k of childrenOf(n)) {
            const f = walk(k);
            if (f) return f;
        }
        return undefined;
    };
    const entry = walk(node);
    expect(entry).toBeDefined();
    return entry!;
};

// The user's real-world shape: an ArcShield component whose Arc is written in the ModifiableValue
// group form carrying a Modifiers list of Type-discriminated ValueModifier entries.
const SHIELD = `Part
{
\tComponents
\t{
\t\tArcShield
\t\t{
\t\t\tType = ArcShield
\t\t\tRadius = 13
\t\t\tArc
\t\t\t{
\t\t\t\tBaseValue = 160d
\t\t\t\tModifiers
\t\t\t\t[
\t\t\t\t\t{
\t\t\t\t\t\tType = BuffRemap
\t\t\t\t\t\tBuffType = ShieldOverclockExtended
\t\t\t\t\t\tModificationMode = Multiply
\t\t\t\t\t\tRemapFrom = [0, 1]
\t\t\t\t\t\tRemapTo = [1, 1.6]
\t\t\t\t\t}
\t\t\t\t\t{
\t\t\t\t\t\tType = StatusRemap
\t\t\t\t\t\tStatusType = SomeStatus
\t\t\t\t\t\tModificationMode = Multiply
\t\t\t\t\t\tRemapFrom = [0, 1]
\t\t\t\t\t\tRemapTo = [1, 2]
\t\t\t\t\t}
\t\t\t\t]
\t\t\t}
\t\t}
\t}
}`;

describe('ValueModifier registry — schema modeling of Modifiers entries', () => {
    it('resolves the ModifiableValue group form of a Modifiable slot', () => {
        const arc = findGroup(parse(SHIELD), 'Arc');
        expect(arc).toBeDefined();
        expect(resolveGroupClass(arc!)).toBe('Cosmoteer.Ships.ModifiableValue');
    });

    it('resolves a Modifiers entry to its Type-discriminated modifier class', () => {
        const doc = parse(SHIELD);
        expect(resolveGroupClass(listEntry(doc, 'Modifiers', 0))).toBe('Cosmoteer.Ships.BuffRemapModifier');
        expect(resolveGroupClass(listEntry(doc, 'Modifiers', 1))).toBe('Cosmoteer.Ships.StatusRemapModifier');
    });

    it('completes the unwritten fields of a BuffRemap entry, base fields included', async () => {
        const doc = parse(SHIELD);
        const offset = SHIELD.indexOf('RemapFrom');
        const labels = (await schemaFieldNameCompletions(doc, offset, token)).map((c) =>
            typeof c === 'string' ? c : c.label
        );
        // Completion omits the fields the entry already writes (RemapFrom, RemapTo, BuffType,
        // ModificationMode), so the offer is exactly the remaining BuffRemap surface.
        for (const expected of ['Clamp', 'MinValue', 'MaxValue']) {
            expect(labels).toContain(expected);
        }
        // Fields of the outer ModifiableValue scope must not leak into the entry.
        expect(labels).not.toContain('BaseValue');
        expect(labels).not.toContain('Modifiers');
    });

    it('completes the full field surface of an empty modifier entry', async () => {
        const src = SHIELD.replace(
            'Type = StatusRemap',
            'Type = NamedValueRemap'
        ).replace('StatusType = SomeStatus', 'ValueID = SomeValue');
        const doc = parse(src);
        // The cursor sits right after the entry's Type line; the entry writes ModificationMode etc.
        // below, so only they are omitted.
        const offset = src.indexOf('ValueID');
        const labels = (await schemaFieldNameCompletions(doc, offset, token)).map((c) =>
            typeof c === 'string' ? c : c.label
        );
        for (const expected of ['Clamp', 'MinValue', 'MaxValue']) {
            expect(labels).toContain(expected);
        }
    });

    it('accepts the valid modifier entries without diagnostics', async () => {
        expect(await validateSchema(parse(SHIELD), token)).toHaveLength(0);
    });

    it('flags an unknown modifier Type and a bad ModificationMode member', async () => {
        const bad = SHIELD.replace('Type = BuffRemap', 'Type = BuffRemapp');
        const typeErrors = await validateSchema(parse(bad), token);
        expect(typeErrors.some((e) => e.message.includes('BuffRemapp'))).toBe(true);

        const badMode = SHIELD.replace('ModificationMode = Multiply', 'ModificationMode = Multiplied');
        const modeErrors = await validateSchema(parse(badMode), token);
        expect(modeErrors.some((e) => e.message.includes('Multiplied'))).toBe(true);
    });
});

describe('DirectionalCrewSpeeds — dual-form crew speed factors', () => {
    const PART = `Part
{
\tCrewSpeedFactor
\t{
\t\tLeft = .75
\t\tRight = .75
\t\tUp = 2
\t\tDown = .25
\t}
}`;

    it('resolves the group form to the curated class and completes its directions', async () => {
        expect(resolveGroupClass(findGroup(parse(PART), 'CrewSpeedFactor')!)).toBe(
            'Cosmoteer.Ships.Parts.DirectionalCrewSpeeds'
        );
        // A partially written group offers the missing directions (completion omits written fields).
        const partial = 'Part\n{\n\tCrewSpeedFactor\n\t{\n\t\tLeft = .75\n\t\tRight = .75\n\t}\n}';
        const labels = (await schemaFieldNameCompletions(parse(partial), partial.indexOf('Left'), token)).map((c) =>
            typeof c === 'string' ? c : c.label
        );
        for (const direction of ['Up', 'Down']) expect(labels).toContain(direction);
    });

    it('accepts both written forms without diagnostics', async () => {
        expect(await validateSchema(parse(PART), token)).toHaveLength(0);
        expect(await validateSchema(parse('Part\n{\n\tCrewSpeedFactor = 0.5\n}'), token)).toHaveLength(0);
    });
});
