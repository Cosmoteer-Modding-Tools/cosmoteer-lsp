import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parseGameLog } from '../../../src/features/game-log/game-log';

/** The timestamp every log line carries, in the invariant format the logger always writes. */
const at = (time: string, text: string): string => `08/30/2025 ${time}  |  ${text}`;

const log = (...lines: string[]): string => lines.join('\r\n');

// The game reports what it refused to load only in its log, so a mod can be shipped broken while
// the editor shows nothing. What is read out of it has to be exactly what the game threw.
describe('reading a game log', () => {
    it('reports the innermost exception of a chain, not the files that were loading it', () => {
        // The stack frames between the parts of a chain are written in the user's own language, so
        // nothing may depend on recognizing them. These are the German ones this machine writes.
        const report = parseGameLog(
            log(
                at('00:15:22', 'Halfling.Serialization.DeserializeException: Deserialization from source "<C:\\Cosmoteer\\Data\\cosmoteer.rules>" failed.'),
                at('00:15:22', ' ---> Halfling.ObjectText.OTParseException: Unable to parse file "C:\\Mods\\My Mod\\mod.rules".'),
                at('00:15:22', '   bei Halfling.ObjectText.OTFile..ctor(FilePath path)'),
                at('00:15:22', ' ---> Halfling.ObjectText.OTParseException: Unexpected "120" at position Line=40,Char=95 in file "C:\\Mods\\My Mod\\mod.rules".'),
                at('00:15:22', '   bei Halfling.ObjectText.OTTokenizer.TokenizeFile()'),
                at('00:15:22', '   --- End of inner exception stack trace ---')
            ),
            'log.txt'
        );
        expect(report.findings).toHaveLength(1);
        expect(report.findings[0].file).toBe('C:\\Mods\\My Mod\\mod.rules');
        expect(report.findings[0].line).toBe(40);
        expect(report.findings[0].character).toBe(95);
    });

    it('quotes the offending token as the file wrote it', () => {
        const report = parseGameLog(
            log(at('00:15:22', 'Halfling.ObjectText.OTParseException: Unexpected "120" at position Line=1,Char=1 in file "C:\\a.rules".')),
            'log.txt'
        );
        // The game writes the token's own text through StringTools.FormatString, so a token of
        // digits is a token of digits and never a character code.
        expect(report.findings[0].message).toContain("'120'");
    });

    it('reads a token whose own text carries a quote', () => {
        const report = parseGameLog(
            log(
                at('00:15:22', 'Halfling.ObjectText.OTParseException: Unexpected "\\"<ships/terran/armor/armor.rules>/Part/NameKey\\"" at position Line=21,Char=4 in file "C:\\a.rules".')
            ),
            'log.txt'
        );
        expect(report.findings[0].line).toBe(21);
        expect(report.findings[0].character).toBe(4);
        expect(report.findings[0].message).toContain('"<ships/terran/armor/armor.rules>/Part/NameKey"');
    });

    it('takes the file from the wrapper when the tokenizer names none', () => {
        const report = parseGameLog(
            log(
                at('00:15:22', 'Halfling.ObjectText.OTParseException: Unable to parse file "C:\\Mods\\My Mod\\part.rules".'),
                at('00:15:22', ' ---> Halfling.ObjectText.OTParseException: Unexpected "\\n" at position Line=4,Char=12.')
            ),
            'log.txt'
        );
        expect(report.findings).toHaveLength(1);
        expect(report.findings[0].file).toBe('C:\\Mods\\My Mod\\part.rules');
        expect(report.findings[0].line).toBe(4);
        expect(report.findings[0].character).toBe(12);
        expect(report.findings[0].message).toContain("'\\n'");
    });

    it('reads the character the tokenizer writes for the end of the text as the end of the file', () => {
        const report = parseGameLog(
            log(
                at('00:15:22', 'Halfling.ObjectText.OTParseException: Unable to parse file "C:\\a.rules".'),
                at('00:15:22', ' ---> Halfling.ObjectText.OTParseException: Unexpected "\uffff" at position Line=3,Char=7.')
            ),
            'log.txt'
        );
        expect(report.findings[0].message).toBe(
            'The game reached the end of the file while it was still reading a value.'
        );
        expect(report.findings[0].line).toBe(3);
    });

    it('never takes the file from a chain above a line that opens one of its own', () => {
        const report = parseGameLog(
            log(
                at('00:15:22', 'Halfling.ObjectText.OTParseException: Unable to parse file "C:\\Mods\\My Mod\\part.rules".'),
                at('00:15:23', 'Halfling.ObjectText.OTParseException: Unexpected "x" at position Line=1,Char=9.')
            ),
            'log.txt'
        );
        // The second line is a chain of its own, and the tokenizer reaches it from a path walk that
        // has no file behind it, so it names one file and only one.
        expect(report.findings).toHaveLength(1);
        expect(report.findings[0].file).toBe('C:\\Mods\\My Mod\\part.rules');
    });

    it('reads a reference target the game refused as a path', () => {
        const report = parseGameLog(
            log(
                at('00:15:22', 'Halfling.ObjectText.OTParseException: The reference target at Line=4,Char=1 in file "C:\\a.rules" is not a valid path: }')
            ),
            'log.txt'
        );
        expect(report.findings[0].file).toBe('C:\\a.rules');
        expect(report.findings[0].line).toBe(4);
        expect(report.findings[0].character).toBe(1);
        expect(report.findings[0].message).toContain('"}"');
    });

    it('takes the file from the wrapper for a reference target the game could not name a file for', () => {
        const report = parseGameLog(
            log(
                at('00:15:22', 'Halfling.ObjectText.OTParseException: Unable to parse file "C:\\a.rules".'),
                at('00:15:22', ' ---> Halfling.ObjectText.OTParseException: The reference target at Line=1,Char=5 in file "" is not a valid path: b-c')
            ),
            'log.txt'
        );
        expect(report.findings).toHaveLength(1);
        expect(report.findings[0].file).toBe('C:\\a.rules');
        expect(report.findings[0].line).toBe(1);
    });

    it('reads an unresolved reference with the path inside the file', () => {
        const report = parseGameLog(
            log(
                at('17:04:53', 'Halfling.ObjectText.OTNavigateException: Unable to find final target "Left" of Reference at path "<C:\\Mods\\My Mod\\mod.rules>/Actions/0/Overrides/MaxBorders/Left".')
            ),
            'log.txt'
        );
        expect(report.findings[0].file).toBe('C:\\Mods\\My Mod\\mod.rules');
        expect(report.findings[0].otPath).toBe('/Actions/0/Overrides/MaxBorders/Left');
        expect(report.findings[0].message).toContain("'Left'");
    });

    it('reads a type name the game does not know', () => {
        const report = parseGameLog(
            log(
                at('18:00:45', "Halfling.Serialization.DeserializeException: Type name 'Override' at path '<C:\\Mods\\My Mod\\mod.rules>/Actions/0/Action' is not a deserializable subclass of 'Cosmoteer.Mods.ModAction'.")
            ),
            'log.txt'
        );
        expect(report.findings[0].message).toContain("'Override'");
        expect(report.findings[0].message).toContain('ModAction');
        expect(report.findings[0].otPath).toBe('/Actions/0/Action');
    });

    it('reads a shader diagnostic with its own severity', () => {
        const report = parseGameLog(
            log(at('00:15:22', './Data/base_shipquad.shader(103,5-40): warning X3206: implicit truncation of vector type')),
            'log.txt'
        );
        expect(report.findings[0].severity).toBe('warning');
        expect(report.findings[0].line).toBe(103);
        expect(report.findings[0].character).toBe(5);
        expect(report.findings[0].message).toContain('X3206');
    });

    it('reports one run of the same failure, however often the game re-reads it', () => {
        const line = at('00:15:22', 'Halfling.ObjectText.OTParseException: Unexpected "120" at position Line=40,Char=95 in file "C:\\a.rules".');
        expect(parseGameLog(log(line, line, line), 'log.txt').findings).toHaveLength(1);
    });

    it('reads which mods ran and which game version it was', () => {
        const report = parseGameLog(
            log(
                at('00:23:06', 'Cosmoteer version 0.30.4c build 0.30.4c_steam'),
                at('00:23:06', 'Enabled mods:'),
                at('00:23:06', '\t[Workshop ID 2946411143] - SirCampalot.extendedtechtree (1.6.5a)'),
                at('00:23:06', '\t[User Folder] - trust.extended_ship_grid (1.0.0)')
            ),
            'log.txt'
        );
        expect(report.gameVersion).toBe('0.30.4c');
        expect(report.modIds).toEqual(['SirCampalot.extendedtechtree', 'trust.extended_ship_grid']);
    });

    it('reads a mod the game ships with as one that ran', () => {
        // The third label the game writes, which every mod under Standard Mods carries.
        const report = parseGameLog(
            log(
                at('00:23:06', 'Enabled mods:'),
                at('00:23:06', '\t[Built-in] - cosmoteer.example_mod (1.0.0)')
            ),
            'log.txt'
        );
        expect(report.modIds).toEqual(['cosmoteer.example_mod']);
    });

    it('names the path a mod action pointed at nothing with', () => {
        const report = parseGameLog(
            log(
                at('00:23:06', 'Enabled mods:'),
                at('00:23:06', '\t[User Folder] - my.mod (1.0.0)'),
                at('00:23:07', 'System.Exception: Error loading mod: My Mod'),
                at('00:23:07', ' ---> Halfling.ObjectText.OTNavigateException: Unable to find node at path "<ships/terran/terran.rules>/Terran/NoSuchMember".')
            ),
            'log.txt'
        );
        expect(report.modLoadFailures).toHaveLength(1);
        expect(report.modLoadFailures[0].name).toBe('My Mod');
        expect(report.modLoadFailures[0].detail).toBe(
            'The game found nothing at "<ships/terran/terran.rules>/Terran/NoSuchMember", which something points at.'
        );
        // The target is a file of the game's own data, so nothing of this mod is marked for it.
        expect(report.findings).toEqual([]);
    });

    it('leaves a path with no file in it to be counted rather than read', () => {
        const report = parseGameLog(
            log(
                at('00:23:06', 'Enabled mods:'),
                at('00:23:07', 'Halfling.ObjectText.OTNavigateException: Unable to find node at path "Components".')
            ),
            'log.txt'
        );
        expect(report.findings).toEqual([]);
        expect(report.unplaced).toHaveLength(1);
    });

    it('ignores the translated mod-load line, which repeats an exception already logged', () => {
        const report = parseGameLog(
            log(
                at('00:15:22', 'Fehler beim Laden der Mod Extended Ship Grid: Halfling.ObjectText.OTParseException: Unable to parse file "C:\\a.rules".')
            ),
            'log.txt'
        );
        expect(report.findings).toEqual([]);
    });

    it('ignores a line that is not one of the shapes the game throws', () => {
        expect(parseGameLog(log(at('00:15:22', 'Loaded game data in 72,8 seconds.')), 'log.txt').findings).toEqual([]);
    });
});

// The real logs of this machine, which is where the shapes above were read from.
const LOGS = join(homedir(), 'Saved Games', 'Cosmoteer', '76561198104661155', 'Logs');

describe.skipIf(!existsSync(LOGS))('reading the real game logs', () => {
    it('reads every log without inventing findings', () => {
        let read = 0;
        let silent = 0;
        for (const name of readdirSync(LOGS).filter((entry) => entry.startsWith('log ') && entry.endsWith('.txt'))) {
            const report = parseGameLog(readFileSync(join(LOGS, name), 'utf8'), join(LOGS, name));
            read++;
            expect(report.gameVersion).toMatch(/^\d+\.\d+/);
            if (report.findings.length === 0 && report.unplaced.length === 0 && report.modLoadFailures.length === 0) {
                silent++;
            }
            for (const finding of report.findings) {
                // Everything reported names a file and carries the run it came from.
                expect(finding.file).not.toBe('');
                expect(finding.time).toMatch(/^\d\d\/\d\d\/\d{4}/);
                // A message quoting the game's own text reads it back rather than showing the
                // escapes the game wrote it with.
                expect(finding.message).not.toContain('\\"');
            }
        }
        expect(read).toBeGreaterThan(0);
        // Most runs on this machine loaded cleanly, and a reader that answered otherwise would be
        // the one failure nothing else here would catch.
        expect(silent).toBeGreaterThan(0);
    });
});
