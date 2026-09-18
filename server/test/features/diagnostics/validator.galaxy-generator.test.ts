import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/document/reference-path';
import { validateGalaxyGenerators } from '../../../src/features/diagnostics/validator.galaxy-generator';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);

/** A generator file at the fixture workspace, with the findings its `Spawners` list produces. */
const messages = async (body: string): Promise<string[]> => {
    const uri = filePathToUri(workspaceFile('galaxy_map/map_generators/probe.rules'));
    const document = parseText(`Spawners${NEWLINE}[${NEWLINE}${body}${NEWLINE}]${NEWLINE}`, uri);
    return (await validateGalaxyGenerators(document, token)).map((error) => error.message);
};

/** One spawner group written inline, which is the form that needs no file to resolve. */
const spawner = (type: string, ...members: string[]): string =>
    [`${TAB}{`, `${TAB}${TAB}Type = ${type}`, ...members.map((member) => `${TAB}${TAB}${member}`), `${TAB}}`].join(
        NEWLINE
    );

// Everything here is the engine's own behaviour: the sector-type fallback, the queue array the
// progression spawner sizes from its own list, the connection radius against the node spacing, and
// the four picker filters that can empty the candidate set.
describe('validateGalaxyGenerators', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    describe('a career generator with no sector types', () => {
        it('flags a list carrying a career spawner and no RandomSectorTypes', async () => {
            const found = await messages(
                [spawner('MapNodes'), spawner('StartingNodePicker'), spawner('ProgressionNodeTiers')].join(NEWLINE)
            );
            expect(found).toHaveLength(1);
            expect(found[0]).toContain('RandomSectorTypes');
        });

        it('accepts the same list once the spawner is there', async () => {
            const found = await messages(
                [spawner('MapNodes'), spawner('StartingNodePicker'), spawner('RandomSectorTypes')].join(NEWLINE)
            );
            expect(found).toEqual([]);
        });

        // The five career spawners all return early outside career mode, so a generator offered
        // only to creative has nothing to say here.
        it('says nothing about a list with no career spawner at all', async () => {
            expect(await messages(spawner('MapNodes'))).toEqual([]);
        });
    });

    describe('a progression spawner whose priorities leave its own list', () => {
        const withDeltas = (...entries: string[]): string =>
            [
                `${TAB}{`,
                `${TAB}${TAB}Type = ProgressionNodeTiers`,
                `${TAB}${TAB}DesiredTierDeltas`,
                `${TAB}${TAB}[`,
                ...entries.map((entry) => `${TAB}${TAB}${TAB}{ ${entry} }`),
                `${TAB}${TAB}]`,
                `${TAB}}`,
                spawner('RandomSectorTypes'),
            ].join(NEWLINE);

        it('accepts priorities inside the list', async () => {
            expect(await messages(withDeltas('Priority = 0', 'Priority = 1', 'Priority = 2'))).toEqual([]);
        });

        it('flags a priority the list is too short for', async () => {
            const found = await messages(withDeltas('Priority = 0', 'Priority = 3'));
            expect(found).toHaveLength(1);
            expect(found[0]).toContain('index error');
        });

        it('flags a negative priority', async () => {
            expect(await messages(withDeltas('Priority = -1', 'Priority = 0'))).toHaveLength(1);
        });

        it('flags an empty list, which the spawner writes to before reading anything', async () => {
            const body = [
                `${TAB}{`,
                `${TAB}${TAB}Type = ProgressionNodeTiers`,
                `${TAB}${TAB}DesiredTierDeltas`,
                `${TAB}${TAB}[`,
                `${TAB}${TAB}]`,
                `${TAB}}`,
                spawner('RandomSectorTypes'),
            ].join(NEWLINE);
            expect(await messages(body)).toHaveLength(1);
        });
    });

    describe('a node spawner that can never connect anything', () => {
        it('accepts a radius above the spacing', async () => {
            const body = [spawner('MapNodes', 'Distance = [5, 10]', 'ConnectionRadius = 10')].join(NEWLINE);
            expect(await messages(body)).toEqual([]);
        });

        it('flags a radius at the spacing, where no pair is ever inside it', async () => {
            const body = [spawner('MapNodes', 'Distance = [10, 20]', 'ConnectionRadius = 10')].join(NEWLINE);
            const found = await messages(body);
            expect(found).toHaveLength(1);
            expect(found[0]).toContain('no routes at all');
        });
    });

    describe('a starting node picker that keeps nothing', () => {
        const picker = (...members: string[]): string =>
            [spawner('StartingNodePicker', ...members), spawner('RandomSectorTypes')].join(NEWLINE);

        it('accepts a window that holds', async () => {
            expect(await messages(picker('MinTier = 2', 'MaxTier = 8'))).toEqual([]);
        });

        it('flags an inverted tier window', async () => {
            expect(await messages(picker('MinTier = 9', 'MaxTier = 3'))).toHaveLength(1);
        });

        it('flags an inverted connection window', async () => {
            expect(await messages(picker('MinConnections = 4', 'MaxConnections = 2'))).toHaveLength(1);
        });

        // The two `Candidates*Center` members mean "off" at zero, the two faction counts do not.
        it('flags a faction candidate count of zero, which keeps no node', async () => {
            const found = await messages(picker('CandidatesClosestToFactions = [0, [monolith]]'));
            expect(found).toHaveLength(1);
            expect(found[0]).toContain('not a switch');
        });

        it('accepts a positive faction candidate count', async () => {
            expect(await messages(picker('CandidatesFarthestFromFactions = [5, [imperium]]'))).toEqual([]);
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

describe.skipIf(!existsSync(VANILLA))('validateGalaxyGenerators over the whole vanilla tree', () => {
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
            for (const error of await validateGalaxyGenerators(parseText(text, filePathToUri(file)), token)) {
                findings.push(`${file}: ${error.message}`);
            }
        }
        expect(findings).toEqual([]);
    }, 300_000);
});
