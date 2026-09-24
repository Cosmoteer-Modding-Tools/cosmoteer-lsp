import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/document/reference-path';
import { messageFor, validateNumericDomains } from '../../../src/features/diagnostics/validator.numeric-domain';
import { NUMERIC_DOMAIN_RULES } from '../../../src/document/schema/numeric-domains';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);

/** The findings a written document produces, at a path the fixture workspace holds. */
const messages = async (source: string, file = 'parts/probe/probe.rules'): Promise<string[]> => {
    const document = parseText(source, filePathToUri(workspaceFile(file)));
    return (await validateNumericDomains(document, token)).map((error) => error.message);
};

/** A part carrying one component, in the shape vanilla parts use. */
const withComponent = (...members: string[]): string =>
    [
        'Part',
        '{',
        `${TAB}ID = probe.part`,
        `${TAB}Components`,
        `${TAB}{`,
        `${TAB}${TAB}Probe`,
        `${TAB}${TAB}{`,
        ...members.map((member) => `${TAB}${TAB}${TAB}${member}`),
        `${TAB}${TAB}}`,
        `${TAB}}`,
        '}',
        '',
    ].join(NEWLINE);

// Each of these is a number the schema accepts and the reading class does not. None of them is
// visible to the generic division check, because the value is well formed where it stands.
describe('validateNumericDomains', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    describe('a continuous beam with no hit interval', () => {
        it('flags a beam whose duration is above zero and whose interval is not written', async () => {
            const found = await messages(withComponent('Type = BeamEmitter', 'Duration = 1'));
            expect(found).toHaveLength(1);
            expect(found[0]).toContain('stops responding');
        });

        it('flags a beam that writes the interval as zero', async () => {
            expect(await messages(withComponent('Type = BeamEmitter', 'Duration = 1', 'HitInterval = 0'))).toHaveLength(
                1
            );
        });

        it('accepts a beam that writes a positive interval', async () => {
            expect(await messages(withComponent('Type = BeamEmitter', 'Duration = 1', 'HitInterval = .1'))).toEqual([]);
        });

        // The instant branch never reads the interval, so a hitscan beam is not the same shape.
        it('accepts a hitscan beam, which never reaches the loop', async () => {
            expect(await messages(withComponent('Type = BeamEmitter', 'Duration = 0'))).toEqual([]);
        });

        it('accepts a beam whose duration is not written at all', async () => {
            expect(await messages(withComponent('Type = BeamEmitter'))).toEqual([]);
        });
    });

    describe('an inline converter that divides by zero', () => {
        it('flags a from quantity of zero', async () => {
            const found = await messages(
                withComponent('Type = InlineResourceConverter', 'FromStorage = Battery', 'FromQuantity = 0')
            );
            expect(found).toHaveLength(1);
            expect(found[0]).toContain('FromQuantity');
        });

        it('flags a to quantity of zero, which also refuses the save', async () => {
            expect(
                await messages(
                    withComponent('Type = InlineResourceConverter', 'FromStorage = Battery', 'ToQuantity = 0')
                )
            ).toHaveLength(1);
        });

        it('accepts the quantities vanilla writes', async () => {
            expect(
                await messages(
                    withComponent(
                        'Type = InlineResourceConverter',
                        'FromStorage = Battery',
                        'FromQuantity = 2',
                        'ToQuantity = 1'
                    )
                )
            ).toEqual([]);
        });

        // The ordinary converter carries the same two field names as modifiable values and never
        // divides by them, so the check has to key on the class rather than on the name.
        it('says nothing about the same names on the ordinary converter', async () => {
            expect(
                await messages(withComponent('Type = ResourceConverter', 'FromQuantity = 0', 'ToQuantity = 0'))
            ).toEqual([]);
        });
    });

    describe('nugget art with more tiers than the stack holds', () => {
        // A resource is a whole-file root: its members sit at document level with no group round
        // them, and the top-level `ID` is what roots the file as one.
        const resource = (maxPerNugget: string, tiers: number): string =>
            [
                'ID = probe_resource',
                `MaxPerNugget = ${maxPerNugget}`,
                'NestedNuggetSprites',
                '[',
                ...Array.from({ length: tiers }, () => `${TAB}[ "a.png" ]`),
                ']',
                '',
            ].join(NEWLINE);

        it('accepts a stack that covers every tier', async () => {
            expect(await messages(resource('4000', 4), 'resources/probe/probe.rules')).toEqual([]);
        });

        it('flags three tiers against a stack of two', async () => {
            const found = await messages(resource('2', 3), 'resources/probe/probe.rules');
            expect(found).toHaveLength(1);
            expect(found[0]).toContain('sliced into 3 tiers');
        });
    });

    // A rule whose floor is the smallest number the format holds asks for any positive value. The
    // game ships .75 for `ShipIconGlowShipScale` itself, so a sentence naming 1 as the floor tells
    // the author to raise a legal value.
    describe('the floor the sentence names', () => {
        const ruleFor = (field: string) => {
            const rule = NUMERIC_DOMAIN_RULES.find((entry) => entry.field === field);
            if (!rule) throw new Error(`no rule for ${field}`);
            return rule;
        };

        it('is zero for a rule that only asks for a positive number', () => {
            const message = messageFor(ruleFor('ShipIconGlowShipScale'), 0);
            expect(message).toContain('has to be above zero');
            expect(message).not.toContain('at least');
        });

        it("is the rule's own number where the rule names one", () => {
            const message = messageFor(ruleFor('FromQuantity'), 0);
            expect(message).toContain('has to be at least 1');
        });
    });
});

// The check is default-on, so its false-positive surface is the whole game. Vanilla must be silent.
const VANILLA = 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';

const rulesUnder = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) rulesUnder(full, out);
        else if (entry.toLowerCase().endsWith('.rules')) out.push(full);
    }
    return out;
};

describe.skipIf(!existsSync(VANILLA))('validateNumericDomains over the whole vanilla tree', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('reports nothing the game itself ships', async () => {
        const files = rulesUnder(VANILLA);
        expect(files.length).toBeGreaterThan(500);
        const findings: string[] = [];
        for (const file of files) {
            const text = await readFile(file, 'utf-8').catch(() => null);
            if (text === null) continue;
            for (const error of await validateNumericDomains(parseText(text, filePathToUri(file)), token)) {
                findings.push(`${file}: ${error.message}`);
            }
        }
        expect(findings).toEqual([]);
    }, 600_000);
});
