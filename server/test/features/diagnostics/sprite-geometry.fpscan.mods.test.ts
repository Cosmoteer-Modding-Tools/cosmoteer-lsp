import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { validateSpriteGeometry } from '../../../src/features/diagnostics/validator.sprite-geometry';

// Triage scan of the sprite-geometry check over every installed workshop mod. A mod is not the
// game, so a finding here is not a false positive by definition, and the contract is a pinned one
// rather than a zero: every file the scan reports has been opened and confirmed to draw one of its
// sprites distorted. A finding in a file outside that set is a new case to look at, which is what
// this test fails on. Counts are not pinned, so uninstalling a mod does not break the tripwire.
//
// What the confirmed set holds, all measured against the art on disk:
//   - XWingThruster draws the same 128 by 64 armour plate at [2, 1] undamaged and at [1, 2] once
//     damaged, so it turns on its side the moment the part is hit.
//   - dpm_armoraba_1x2_wedge draws one 64 by 128 plate at [1, 2], [1, 1] and [1, 2] again, and
//     dpmcrew_quarters_tiny does the same, so the middle damage level is squashed.
//   - OUDFFWEGdpm_thruster_giga draws the 128 by 64 batteries7/batteries8 art in a 3 by 2 quad. The
//     mod ships a 192 by 128 `oud` variant of exactly that art, which is what the quad was cut for.
//   - The two hyperdrive_small copies draw every battery level at [2, 2], including vanilla's 128 by
//     64 power5/power6 art, which vanilla itself draws at [2, 1].
//   - The three big reactors scale vanilla's four-tile battery art down to three tiles but keep
//     vanilla's 128 pixel wide steps, so the two middle levels are drawn a third too tall.
//   - Bridge_2x3's damaged roofs drop from [2, 3] to [1, 2] while keeping the same art, Bridge_4x4
//     draws a square 512 pixel floor in a 1 by 2 quad, and CockpitN1 draws a 96 by 384 roof in one.
//   - The deathstar superlaser sections draw 64 by 448 art with the same [1, 8] the 64 by 512 art
//     uses, so the shortened sections are stretched back to full length.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const OUT_FILE = process.env.SPRITE_SCAN_OUT ?? '';
const HAVE = existsSync(DATA_DIR) && existsSync(MODS_DIR);
const token = CancellationToken.None;

/** The mod files whose findings have been triaged, as workshop-relative paths with forward slashes. */
const CONFIRMED = new Set([
    '2946411143/armor/armor/armor_1x2_wedge/dpm_armoraba_1x2_wedge.rules',
    '2946411143/crew/crew_quarters_tiny/dpmcrew_quarters_tiny.rules',
    '2946411143/hyperdrive_small/dpmhhyperdrive_small - Copy.rules',
    '2946411143/hyperdrive_small/kloondpmhhyperdrive_small.rules',
    '2946411143/thrusters/thruster_giga/OUDFFWEGdpm_thruster_gigaOUDE.rules',
    '3119349707/ships/terran/Reactor/battery/reactor_huge/reactor_huge.rules',
    '3119349707/ships/terran/Reactor/battery/reactor_large/reactor_large.rules',
    '3119349707/ships/terran/Reactor/battery/reactor_large/reactor_large_wireless.rules',
    '3119349707/ships/terran/control_rooms/bridges/Bridge_2x3/roofs.rules',
    '3119349707/ships/terran/control_rooms/bridges/Bridge_4x4/cockpit.rules',
    '3119349707/ships/terran/control_rooms/cockpits/CockpitN1/cockpit.rules',
    '3119349707/ships/terran/thrusters/XWing/XWingThruster/XWingThruster.rules',
    '3119349707/ships/terran/weapons/super/deathstar_superlaser/deathstar_superlaser_sect1L.rules',
    '3119349707/ships/terran/weapons/super/deathstar_superlaser/deathstar_superlaser_sect1R.rules',
    '3119349707/ships/terran/weapons/super/deathstar_superlaser/deathstar_superlaser_sect2L.rules',
    '3119349707/ships/terran/weapons/super/deathstar_superlaser/deathstar_superlaser_sect2R.rules',
    '3119349707/ships/terran/weapons/super/deathstar_superlaser2/DSLaser_tunnel.rules',
    '3119349707/ships/terran/weapons/super/deathstar_superlaser2/DSlaser_emitter.rules',
    '3119349707/ships/terran/weapons/super/deathstar_superlaser2/unused/deathstar_superlaser_sect1L.rules',
    '3119349707/ships/terran/weapons/super/deathstar_superlaser2/unused/deathstar_superlaser_sect1R.rules',
    '3119349707/ships/terran/weapons/super/deathstar_superlaser2/unused/deathstar_superlaser_sect2R.rules',
]);

const rulesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(dir, entry);
            let stats;
            try {
                stats = statSync(full);
            } catch {
                continue;
            }
            if (stats.isDirectory()) walk(full);
            else if (entry.toLowerCase().endsWith('.rules')) out.push(full);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE)('sprite geometry over installed workshop mods', () => {
    it('reports only sprites confirmed to be drawn distorted', async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = {
            begin: () => undefined,
            report: () => undefined,
            done: () => undefined,
        };
        const svc = CosmoteerWorkspaceService.instance;
        svc.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await svc.initialize(DATA_DIR, noop);

        const mods = readdirSync(MODS_DIR)
            .map((name) => join(MODS_DIR, name))
            .filter((path) => {
                try {
                    return statSync(path).isDirectory();
                } catch {
                    return false;
                }
            });
        expect(mods.length).toBeGreaterThan(30);

        const findings: string[] = [];
        const unexpected: string[] = [];
        for (const mod of mods) {
            for (const file of rulesUnder(mod)) {
                const rel = relative(MODS_DIR, file).replace(/\\/g, '/');
                let document;
                try {
                    document = parser(lexer(readFileSync(file, 'utf8')), pathToFileURL(file).href).value;
                } catch {
                    continue;
                }
                const errors = await validateSpriteGeometry(document, token).catch(() => []);
                for (const error of errors) {
                    findings.push(`${rel}:${error.node.position.line + 1} :: ${error.message}`);
                    if (!CONFIRMED.has(rel)) unexpected.push(`${rel}:${error.node.position.line + 1}`);
                }
            }
        }
        console.log(`[sprite-geometry] ${mods.length} mods, ${findings.length} findings`);
        if (OUT_FILE) writeFileSync(OUT_FILE, findings.join('\n'), 'utf8');
        expect(unexpected).toEqual([]);
        // The mod the check was designed against: one wide plate drawn upright at both damage levels.
        const xwing = findings.filter((finding) => finding.includes('XWingThruster.rules'));
        expect(xwing).toHaveLength(2);
        expect(xwing[0]).toContain('128 by 64 pixels');
        expect(xwing[0]).toContain('[2, 1]');
    }, 1_800_000);
});
