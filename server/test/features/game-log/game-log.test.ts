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

    it('renders the offending character, which the game reports as a number', () => {
        const report = parseGameLog(
            log(at('00:15:22', 'Halfling.ObjectText.OTParseException: Unexpected "120" at position Line=1,Char=1 in file "C:\\a.rules".')),
            'log.txt'
        );
        // 120 is the character code of `x`, not the text the file carries.
        expect(report.findings[0].message).toContain("'x'");
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
        for (const name of readdirSync(LOGS).filter((entry) => entry.startsWith('log ') && entry.endsWith('.txt'))) {
            const report = parseGameLog(readFileSync(join(LOGS, name), 'utf8'), join(LOGS, name));
            read++;
            expect(report.gameVersion).toMatch(/^\d+\.\d+/);
            for (const finding of report.findings) {
                // Everything reported names a file and carries the run it came from.
                expect(finding.file).not.toBe('');
                expect(finding.time).toMatch(/^\d\d\/\d\d\/\d{4}/);
            }
        }
        expect(read).toBeGreaterThan(0);
    });
});
