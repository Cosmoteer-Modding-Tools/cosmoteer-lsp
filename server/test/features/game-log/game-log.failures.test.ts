import { describe, expect, it } from 'vitest';
import { ENGINE_MESSAGES, parseGameLog } from '../../../src/features/game-log/game-log';
import { verdictOnARunThatPlacedNothing } from '../../../src/features/game-log/import-game-log.command';

// Silence from a run is only an all clear when the run really was silent. The game raises most of
// its load failures as a DeserializeException, and the two wrappers that name a file catch only
// what is not one, so a whole family of them reaches the log with no wrapper round it. What the
// reader still cannot place has to lower the answer rather than disappear out of it.

/** The timestamp every log line carries, in the invariant format the logger always writes. */
const at = (text: string): string => `09/22/2026 21:30:00  |  ${text}`;

const log = (...lines: string[]): string => lines.join('\r\n');

/** The roster line the game writes for one enabled mod before it applies that mod's actions. */
const ROSTER_LINE = at('\t[User Folder] - probe.mod (1.0.0)');

const MOD_FILE = "[user's home folder]\\Saved Games\\Cosmoteer\\1\\Mods\\probe_mod\\parts\\thing.rules";

describe('the failures the engine raises without a wrapper naming the file', () => {
    it('reads the fields of a type the game could not fill', () => {
        const report = parseGameLog(
            log(at(`Halfling.Serialization.DeserializeException: Reflecting from source "<${MOD_FILE}>/Part" failed.`)),
            'log.txt'
        );
        expect(report.findings).toHaveLength(1);
        expect(report.findings[0].file).toBe(MOD_FILE);
        expect(report.findings[0].otPath).toBe('/Part');
    });

    it('reads a field the game needs and did not find', () => {
        const report = parseGameLog(
            log(
                at(
                    `Halfling.Serialization.DeserializeException: Unable to find source for non-optional field "NameKey" in source "<${MOD_FILE}>/Part".`
                )
            ),
            'log.txt'
        );
        expect(report.findings[0].file).toBe(MOD_FILE);
        expect(report.findings[0].message).toContain('"NameKey"');
    });

    it('reads a node the game looked for under a name of its own', () => {
        const report = parseGameLog(
            log(
                at(
                    `Halfling.Serialization.DeserializeException: Unable to find node at path "Cost" relative to "<${MOD_FILE}>/Part".`
                )
            ),
            'log.txt'
        );
        expect(report.findings[0].otPath).toBe('/Part');
        expect(report.findings[0].message).toContain('"Cost"');
    });

    it('reads a value left empty that the game reads as a type it cannot leave empty', () => {
        const report = parseGameLog(
            log(
                at(
                    `Halfling.Serialization.DeserializeException: Deserializing from null source '<${MOD_FILE}>/Part/Cost' but the requested type 'Cosmoteer.Resources.ResourceAmounts' isn't nullable.`
                )
            ),
            'log.txt'
        );
        expect(report.findings[0].otPath).toBe('/Part/Cost');
        expect(report.findings[0].message).toContain('ResourceAmounts');
    });

    it('reads a name written twice, which the game refuses the whole file for', () => {
        const report = parseGameLog(
            log(
                at(
                    `Halfling.ObjectText.OTParseException: Group at path '<${MOD_FILE}>/Part' already contains a node named 'MaxHealth'.`
                )
            ),
            'log.txt'
        );
        expect(report.findings[0].file).toBe(MOD_FILE);
        expect(report.findings[0].message).toContain('MaxHealth');
    });

    it('reads the sentence one of the value deserializers writes for itself', () => {
        const report = parseGameLog(
            log(
                at(
                    `Halfling.Serialization.DeserializeException: Unable to read a Color from node at path '<${MOD_FILE}>/Part/Colour'.`
                )
            ),
            'log.txt'
        );
        expect(report.findings[0].otPath).toBe('/Part/Colour');
        expect(report.findings[0].message).toContain('Color');
    });

    it('reaches every message in the table through the reader', () => {
        // Each entry is rendered back out of its own format string and read again, so an entry the
        // reader can never match cannot be added without this failing.
        for (const message of ENGINE_MESSAGES) {
            const line = message.format.replace(/\{(\w+)\}/g, (_whole, name: string) => {
                if (name.startsWith('source')) return `<C:\\Mods\\M\\${name}.rules>/Part`;
                if (name.startsWith('int')) return '7';
                return 'Some.Name.Space.Alpha';
            });
            const written = `${message.exception}: ${line}`;
            const report = parseGameLog(
                log(at('Enabled mods:'), ROSTER_LINE, at('System.Exception: Error loading mod: M'), at(` ---> ${written}`)),
                'log.txt'
            );
            // A chain reports the reader's own sentence once a shape matched it, so an entry the
            // reader can never match leaves the engine's raw line standing here.
            const detail = report.modLoadFailures[0]?.detail;
            expect(detail, `${message.engine}: ${message.format}`).not.toBe(written);
            expect(detail, message.format).toBeTruthy();
        }
    });
});

describe('what the run reported that the reader could not place', () => {
    it('counts a failure the run wrote while it was loading its mods', () => {
        // Three of the game's duplicate-id checks name only an id, so nothing says which file they
        // are about. Passing over them is what turned a crashed run into an all clear.
        const report = parseGameLog(
            log(
                at('Enabled mods:'),
                ROSTER_LINE,
                at("Halfling.Serialization.DeserializeException: Duplicate bullet ID 'probe.my_bullet'."),
                at('   at Cosmoteer.Bullets.BulletRules..ctor()')
            ),
            'log.txt'
        );
        expect(report.findings).toEqual([]);
        expect(report.unplaced).toHaveLength(1);
        expect(report.unplaced[0].text).toContain('Duplicate bullet ID');
        expect(report.unplaced[0].logLine).toBe(3);
    });

    it('leaves a failure out once the game data is loaded, which is the rest of the session', () => {
        // A log is a whole session. An exception from the running game says nothing about a mod,
        // and counting one would cost every run its all clear over a file lock on a texture cache.
        const report = parseGameLog(
            log(
                at('Enabled mods:'),
                ROSTER_LINE,
                at('Loaded game data in 11,7 seconds.'),
                at("System.IO.IOException: The process cannot access the file 'C:\\Caches\\a.cache'.")
            ),
            'log.txt'
        );
        expect(report.unplaced).toEqual([]);
    });

    it('leaves a chain it did place out of the count, however many lines of it it could not read', () => {
        const report = parseGameLog(
            log(
                at('Enabled mods:'),
                ROSTER_LINE,
                at(
                    'Halfling.Serialization.DeserializeException: Deserialization from source "<C:\\Cosmoteer\\Data\\cosmoteer.rules>" failed.'
                ),
                at(' ---> System.Reflection.TargetInvocationException: Exception has been thrown by the target.'),
                at(
                    `   ---> Halfling.Serialization.DeserializeException: Unable to find source for non-optional field "NameKey" in source "<${MOD_FILE}>/Part".`
                )
            ),
            'log.txt'
        );
        expect(report.findings).toHaveLength(1);
        expect(report.unplaced).toEqual([]);
    });

    it('names the mod a run died on while its actions were applied', () => {
        const report = parseGameLog(
            log(
                at('Enabled mods:'),
                ROSTER_LINE,
                at('System.Exception: Error loading mod: Probe Mod'),
                at(
                    ' ---> Halfling.ObjectText.OTNavigateException: Unable to find node at path "ships/terran/terran.rules/Terran/Parts".'
                )
            ),
            'log.txt'
        );
        expect(report.modLoadFailures).toHaveLength(1);
        expect(report.modLoadFailures[0].name).toBe('Probe Mod');
        expect(report.modLoadFailures[0].detail).toContain('Unable to find node at path');
        expect(report.modLoadFailures[0].logLine).toBe(3);
    });
});

describe('the answer for a run that gave none of the mod files a finding', () => {
    it('is not an all clear when the run died applying a mod', () => {
        const report = parseGameLog(
            log(
                at('Enabled mods:'),
                ROSTER_LINE,
                at('System.Exception: Error loading mod: Probe Mod'),
                at(
                    ' ---> Halfling.ObjectText.OTNavigateException: Unable to find node at path "ships/terran/terran.rules/Terran/Parts".'
                )
            ),
            'log.txt'
        );
        const verdict = verdictOnARunThatPlacedNothing(report);
        expect(verdict.kind).toBe('run-failed');
        expect(verdict.unplaced[0].text).toContain('Error loading mod: Probe Mod');
        expect(verdict.unplaced[0].logLine).toBe(3);
    });

    it('is not an all clear when the run reported a failure nothing here recognizes', () => {
        const report = parseGameLog(
            log(
                at('Enabled mods:'),
                ROSTER_LINE,
                at('System.InvalidOperationException: Duplicate part ID: probe.my_part')
            ),
            'log.txt'
        );
        expect(verdictOnARunThatPlacedNothing(report).kind).toBe('run-failed');
    });

    it('is an all clear for a run that loaded its data and said nothing', () => {
        // The negative control. Without it, an answer that always said the run failed would pass
        // every test above, and the affirmative answer is the whole point of the command.
        const report = parseGameLog(
            log(
                at('Cosmoteer version 0.30.4c build 0.30.4c_steam'),
                at('Enabled mods:'),
                ROSTER_LINE,
                at("Loaded language 'de'."),
                at('Loaded game data in 11,7 seconds.')
            ),
            'log.txt'
        );
        expect(report.modIds).toEqual(['probe.mod']);
        const verdict = verdictOnARunThatPlacedNothing(report);
        expect(verdict.kind).toBe('loaded-clean');
        expect(verdict.unplaced).toEqual([]);
    });
});
