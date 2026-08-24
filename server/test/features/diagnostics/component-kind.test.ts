import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateSchemaSiblingReferences } from '../../../src/features/diagnostics/validator.schema-sibling';
import { componentSatisfiesKind } from '../../../src/document/schema/schema';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const PART_PATH = workspaceFile('parts', 'kind_part.rules');
const token = CancellationToken.None;

/**
 * A part whose components are written out in full, so the check has real declarations to resolve.
 * The wiring under test sits on the `oscillator` component, which reads its toggle through the same
 * lookup every operational component does.
 */
const part = (wiring: string, extra = ''): string =>
    [
        'Part',
        '{',
        '\tID = kind_part',
        '\tComponents',
        '\t{',
        '\t\tshots',
        '\t\t{',
        '\t\t\tType = BulletEmitter',
        '\t\t}',
        '\t\tswitch',
        '\t\t{',
        '\t\t\tType = UIToggle',
        '\t\t}',
        extra,
        '\t\toscillator',
        '\t\t{',
        '\t\t\tType = Oscillator',
        `\t\t\t${wiring}`,
        '\t\t}',
        '\t}',
        '}',
        '',
    ].join('\n');

const findings = async (text: string): Promise<string[]> => {
    const document = parser(lexer(text), PART_PATH).value;
    return (await validateSchemaSiblingReferences(document, token)).map((error) => error.message);
};

/** The quick fix a finding carries, which is the fitting component the part already has. */
const fix = async (text: string): Promise<string | undefined> => {
    const document = parser(lexer(text), PART_PATH).value;
    const [error] = await validateSchemaSiblingReferences(document, token);
    return error?.data?.quickFix?.newText;
};

// A component id resolves through a typed lookup at runtime, so a component of the wrong kind is not
// a matter of taste: `Part.GetComponent<T>` throws while the part is being built. The schema types
// every one of these fields as the registry base, which is why nothing said so until now.
describe('a component of the wrong kind for its slot', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('is reported, and the message says the part fails to load', async () => {
        const found = await findings(part('OperationalToggle = shots'));
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('PartComponentToggle');
        expect(found[0]).toContain('throws');
    });

    it('says nothing when the component is of the kind the field reads', async () => {
        expect(await findings(part('OperationalToggle = switch'))).toEqual([]);
    });

    it('offers the component of this part that would fit', async () => {
        expect(await fix(part('OperationalToggle = shots'))).toBe('switch');
    });

    it('reports the second kind the same component reads, with its own name', async () => {
        // `ChainedTo` reads a chainable component rather than a toggle, so the same wrong value is a
        // different finding here, which is what proves the kind comes from the field.
        const found = await findings(part('ChainedTo = switch'));
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('ChainablePartComponent');
    });

    it('says nothing when the component names a class the schema does not know', async () => {
        const unknown = part('OperationalToggle = mystery', ['\t\tmystery', '\t\t{', '\t\t\tType = NotAKind', '\t\t}'].join('\n'));
        expect(await findings(unknown)).toEqual([]);
    });
});

// The capability table is what replaces the C# type graph on this side, so what it answers, and what
// it refuses to answer, is the whole false-positive story.
describe('the component capability table', () => {
    it('knows a toggle satisfies the toggle kind', () => {
        expect(componentSatisfiesKind('Cosmoteer.Ships.Parts.UI.PartUIToggleRules', 0)).toBeTypeOf('boolean');
    });

    it('abstains on a class it has no entry for', () => {
        expect(componentSatisfiesKind('Some.Mod.CustomComponentRules', 0)).toBeUndefined();
    });
});
