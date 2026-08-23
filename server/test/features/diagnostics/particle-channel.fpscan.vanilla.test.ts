import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { ensureAliasRootIndex } from '../../../src/features/navigation/alias-root-builder';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { validateUnusedParticleChannels } from '../../../src/features/diagnostics/validator.particle-channel';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { globalSettings } from '../../../src/settings';

const token = CancellationToken.None;

/** Every `.rules` file under `root`, skipping the directories that hold no rules. */
const rulesFilesUnder = (root: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(root)) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const path = join(root, entry);
        if (statSync(path).isDirectory()) rulesFilesUnder(path, out);
        else if (entry.toLowerCase().endsWith('.rules')) out.push(path);
    }
    return out;
};
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);

/** Where a full listing of the findings is written when the run asks for one. */
const OUT = process.env.PARTICLE_SCAN_OUT;

/**
 * One reported dead write: the file it sits in, the channel it names, the line it points at and the
 * source text its range covers.
 */
type Finding = {
    file: string;
    channel: string;
    line: string;
    marked: string;
    severity?: string;
    unnecessary?: boolean;
};

/** The channel name a finding's message quotes. */
const channelOf = (message: string): string => /"([^"]+)"/.exec(message)?.[1] ?? message;

/** The comparable form of a finding, so the reported set and the pinned one line up. */
const keyOf = ([file, channel]: readonly [string, string]): string => `${file} ${channel}`;

/**
 * Every dead channel write the game's own files make. This is pinned rather than counted, so a
 * finding that turns up new has to be read before it is added here, and one that disappears names a
 * reader the cross-file fold stopped seeing.
 *
 * The `index` entries all share one story. Each of those files writes `index` from an `AssignIndex`
 * and looks like it hands the value back through an `IndexIn` on a `UvAnimation` or a
 * `RandomRotationByIndex`. Neither updater has such a property, so the engine reads past that line
 * and the channel really is computed for nobody.
 */
const EXPECTED: ReadonlyArray<readonly [string, string]> = [
    ['common_effects/particles/explosions/big_part_explode.rules', 'index'],
    ['common_effects/particles/explosions/med_part_explode.rules', 'index'],
    ['common_effects/particles/explosions/med_part_explode_dry.rules', 'index'],
    ['common_effects/particles/explosions/small_part_explode.rules', 'index'],
    ['common_effects/particles/explosions/small_part_explode_dry.rules', 'index'],
    ['ships/common/particles/salvage_progress_asteroid_dust.rules', 'intensity_alpha'],
    ['ships/terran/radiator/particles/heat_sink_radiation.rules', 'curve'],
    ['ships/terran/radiator/particles/radiator_steam_distortion.rules', 'light_normal'],
    ['ships/terran/reactor_large/particles/reactor_explode_large.rules', 'index'],
    ['ships/terran/reactor_med/particles/reactor_explode_med.rules', 'index'],
    ['ships/terran/reactor_small/particles/reactor_explode_small.rules', 'index'],
    ['shots/bullet_railgun/particles/bullet_trail_railgun_ring_distortion.rules', 'base_scale2'],
    ['shots/chaingun_shot/overclock/particles/chaingun_shot_overclock_hit.rules', 'index'],
    ['shots/chaingun_shot/particles/chaingun_hit.rules', 'curve'],
    ['shots/flak_large/overclock/particles/flak_large_overclock_field_left.rules', 'index'],
    ['shots/ion_beam/particles/ion_beam_hit_spikes.rules', 'base_color'],
    ['shots/ion_beam/particles/ion_beam_overclock_spikes.rules', 'base_color'],
    ['shots/laser_bolt_large/overclock/particles/laser_bolt_large_overclock_hit.rules', 'index'],
    ['shots/laser_bolt_large/particles/laser_bolt_large_spikes.rules', 'index'],
    ['shots/laser_bolt_small/particles/laser_bolt_small_spikes.rules', 'index'],
    ['shots/mine/particles/mine_arming.rules', 'curve'],
    ['shots/mine/particles/mine_arming.rules', 'index'],
    ['shots/missile_he/particles/missile_he_hit.rules', 'index'],
    ['shots/missile_nuke/particles/missile_nuke_hit.rules', 'index'],
    ['shots/missile_thermal/particles/missile_thermal_flash.rules', 'base_color'],
    ['shots/missile_thermal/particles/missile_thermal_hit_cone.rules', 'index'],
    ['shots/pd_shot/particles/pd_shot_spikes.rules', 'base_color'],
    ['shots/resonance_beam/resonance_beam_hit_fire.rules', 'life_scale'],
    ['shots/tractor_beam/tractor_beam_glints.rules', 'distantPoint'],
    ['statuses/fire/particles/fire_base.rules', 'flip'],
    ['statuses/fire/particles/fire_base.rules', 'time_offset'],
];

// A dead channel write is invisible in the file that makes it, and the reader that would have used
// it usually lives in the shared body the emitter pulls in, so the check is only worth anything if
// the fold across that seam holds. This walks the game's own files and pins what it finds.
describe.skipIf(!HAVE_DATA)('unused particle channels over the vanilla tree', () => {
    const findings: Finding[] = [];

    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
        await ensureAliasRootIndex(token);
        await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR], token);
        const dump: string[] = [];
        for (const file of rulesFilesUnder(DATA_DIR)) {
            const text = readFileSync(file, 'utf8');
            if (!text.includes('Out') && !text.includes('out')) continue;
            const lines = text.split(/\r?\n/);
            const document = parser(lexer(text), filePathToUri(file)).value;
            for (const error of await validateUnusedParticleChannels(document, token)) {
                const path = relative(DATA_DIR, file).replace(/\\/g, '/');
                findings.push({
                    file: path,
                    channel: channelOf(error.message),
                    line: (lines[error.node.position.line] ?? '').trim(),
                    marked: text.slice(error.node.position.start, error.node.position.end),
                    severity: error.severity,
                    unnecessary: error.unnecessary,
                });
                dump.push(`${path}\t${error.message}`);
            }
        }
        if (OUT) writeFileSync(OUT, dump.join('\n'), 'utf8');
    }, 600_000);

    it('reports the writes the game itself drops, and nothing besides', () => {
        const reported = findings.map((finding) => keyOf([finding.file, finding.channel])).sort();
        expect(reported).toEqual(EXPECTED.map(keyOf).sort());
    });

    it('reports each dead write once', () => {
        const keys = findings.map((finding) => keyOf([finding.file, finding.channel]));
        expect(new Set(keys).size).toBe(keys.length);
    });

    // Only the write direction is judged. Reading a channel nothing writes is a live idiom, because
    // the engine hands out a zeroed buffer the first time a channel is touched, so every finding has
    // to sit on the `Out` binding that fills the channel and never on a reader.
    it('anchors every finding on the write it calls dead', () => {
        const misplaced = findings.filter(
            (finding) => !new RegExp(`Out\\s*=\\s*"?${finding.channel}"?`).test(finding.line)
        );
        expect(misplaced).toEqual([]);
    });

    // The faded range is what the reader sees, and the field name is not the dead part: the binding
    // is spelled the way the updater wants it and only the channel it names has no reader, so the
    // range has to sit on the name alone.
    it('fades the channel name alone and not the binding that writes it', () => {
        expect(findings.map((finding) => finding.marked)).toEqual(findings.map((finding) => finding.channel));
    });

    // A dead write costs nothing at load time, so the editor fades the value out rather than
    // underlining it as something the author has to answer for.
    it('fades every finding instead of underlining it', () => {
        expect(findings.map((finding) => `${finding.severity} ${finding.unnecessary}`)).toEqual(
            EXPECTED.map(() => 'hint true')
        );
    });
});
