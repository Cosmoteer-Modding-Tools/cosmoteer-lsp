import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';
import { documentRootClass } from '../../../src/document/schema/document-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

// False-positive guard over every installed workshop mod. Validates each mod's `.rules` with the forward
// alias and reverse-include indexes built over the merged `[Data, …mods]` tree in production order. The
// game loads all of this content, so a warning is either our false positive, which must be zero, or a
// genuine mod bug pinned in KNOWN_MOD_BUGS. Anything outside that allowlist fails the test. Self-skips
// when the game or workshop tree is absent, override with COSMOTEER_DATA_DIR or COSMOTEER_MODS_DIR.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const HAVE = existsSync(DATA_DIR) && existsSync(MODS_DIR);
const token = CancellationToken.None;

// Genuine mod bugs, not false positives, keyed by `<modId>/<path-within-mod> :: <message>` so the key is
// machine-independent. All from one mod that ships custom C# component `Type=`s with no accompanying DLL,
// so those discriminators resolve to nothing. Add an entry only for a genuinely new real mod bug. An
// entry that is actually a false positive means a schema or rooting regression to fix instead.
const KNOWN_MOD_BUGS = new Set<string>([
    "3119349707/ships/terran/weapons/super/deathstar_superlaser2/DSLaser_core.rules :: 'AmmoChange' was renamed to 'ResourceChange' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/ships/terran/weapons/super/deathstar_superlaser2/DSlaser_director.rules :: 'UITargetor' is not a valid PartComponentRules type.",
    "3119349707/ships/terran/weapons/super/deathstar_superlaser2/DSlaser_emitter.rules :: 'UITargetor' is not a valid PartComponentRules type.",
    "3119349707/ships/terran/weapons/super/deathstar_superlaser2/DSLaser_tunnel.rules :: 'AmmoChange' was renamed to 'ResourceChange' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/ships/terran/weapons/super/deathstar_superlaser2/unused/deathstar_superlaser_sect2R.rules :: 'CrewIdler' is not a valid PartComponentRules type.",
    "3119349707/ships/terran/weapons/super/galvenning_barrel_section/galvenning_barrel_section.rules :: 'AmmoChange' was renamed to 'ResourceChange' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/ships/terran/weapons/super/gravity_well_projector/manual.rules :: 'AmmoChange' was renamed to 'ResourceChange' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/ships/terran/weapons/super/mega_ion_impulse_cannon/ion_impulse_accelerator.rules :: 'AmmoChange' was renamed to 'ResourceChange' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/sw_effects/shots/laser_shot_blue_pd.rules :: 'AntiBullet' is not a valid BulletComponentRules type.",
    "3119349707/sw_effects/shots/laser_shot_green_pd.rules :: 'AntiBullet' is not a valid BulletComponentRules type.",
    "3119349707/sw_effects/shots/laser_shot_red_pd.rules :: 'AntiBullet' is not a valid BulletComponentRules type.",
    // Surfaced when hit-effect list elements started resolving through the value-form delegation:
    // `Fire`/`AreaFires` hit effects and the `Ammo*` drains were removed or renamed by newer game
    // versions (verified absent in the current Cosmoteer.dll), so these mods target an older game.
    // `DestroyShips` is an alias of the DefeatShips objective class only; the spawner the
    // ObjectiveSpawner registry dispatches accepts just `DefeatShips`, so these two backup files
    // wrote a spelling the game cannot dispatch.
    "3093774017/career/merchantraiders - BAK.rules :: 'DestroyShips' is not a valid ObjectiveSpawner type.",
    "3093774017/career/merchantraiders.ffweg.rules :: 'DestroyShips' is not a valid ObjectiveSpawner type.",
    "2880017812/Parts/Weapons/CRAM megacannon/Bullet0.rules :: 'Fire' is not a valid HitEffectRules type.",
    "2946411143/cannons/dpmcannon_med/bullet_med/dpmbullet_medt.rules :: 'Fire' is not a valid HitEffectRules type.",
    "2946411143/missile_launcher/mine/projectile/dpmmine_shrapnel.rules :: 'Fire' is not a valid HitEffectRules type.",
    "3119349707/ships/terran/weapons/dev_code_sketches/Graphics_TestWeapon/dual_laser_cannon_switchable_test.rules :: 'AreaFires' is not a valid HitEffectRules type.",
    "3119349707/ships/terran/weapons/dev_code_sketches/Graphics_Weapons/dual_laser_cannon_switchable.rules :: 'AreaFires' is not a valid HitEffectRules type.",
    "3119349707/ships/terran/weapons/turbolasers/Turbolasers_Spinal_Turret/turbolaser_spinal_turret_2x3.rules :: 'AreaFires' is not a valid HitEffectRules type.",
    "3119349707/ships/terran/weapons/super/gravity_well_projector/FTL_jammer_energy_shot.rules :: 'ExplosiveAmmoDrain' was renamed to 'ExplosiveResourceDrain' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/ships/terran/weapons/super/gravity_well_projector/FTL_jammer_shot.rules :: 'ExplosiveAmmoDrain' was renamed to 'ExplosiveResourceDrain' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/ships/terran/weapons/super/gravity_well_projector/manual.rules :: 'ExplosiveAmmoDrain' was renamed to 'ExplosiveResourceDrain' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/ships/terran/weapons/super/mega_ion_impulse_cannon/mega_ion_impulse_wave_child_shot.rules :: 'AmmoDrain' was renamed to 'ResourceDrain' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/ships/terran/weapons/super/mega_ion_impulse_cannon/mega_ion_impulse_wave_child_shot.rules :: 'ExplosiveAmmoDrain' was renamed to 'ExplosiveResourceDrain' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/ships/terran/weapons/super/mega_ion_impulse_cannon/mega_ion_impulse_wave_child_shot02.rules :: 'AmmoDrain' was renamed to 'ResourceDrain' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/ships/terran/weapons/super/mega_ion_impulse_cannon/mega_ion_impulse_wave_child_shot02.rules :: 'ExplosiveAmmoDrain' was renamed to 'ExplosiveResourceDrain' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/ships/terran/weapons/super/mega_ion_impulse_cannon/mega_ion_impulse_wave_child_shot03.rules :: 'AmmoDrain' was renamed to 'ResourceDrain' in a newer game version (ammo was generalized into the resource system).",
    // Surfaced when the part `Components` map got its slot typing: these are the SW mod's
    // copy-and-rename TEMPLATE files, whose `Type = COMPONENT_BASE_NAME` is a find/replace
    // placeholder. The flag is accurate for the file as written (the game could not load it), and
    // the files are scaffolding the manifest never reaches.
    "3119349707/ships/common/common_code/bases/base_component - Kopie (2).rules :: 'COMPONENT_BASE_NAME' is not a valid PartComponentRules type.",
    "3119349707/ships/common/common_code/bases/base_component - Kopie (3).rules :: 'COMPONENT_BASE_NAME' is not a valid PartComponentRules type.",
    "3119349707/ships/common/common_code/bases/base_component - Kopie (4).rules :: 'COMPONENT_BASE_NAME' is not a valid PartComponentRules type.",
    "3119349707/ships/common/common_code/bases/base_component - Kopie.rules :: 'COMPONENT_BASE_NAME' is not a valid PartComponentRules type.",
    "3119349707/ships/common/common_code/bases/base_component.rules :: 'COMPONENT_BASE_NAME' is not a valid PartComponentRules type.",
    // Surfaced when inheritance bases reached through mod convenience-global super-paths started
    // rooting (the shots-fragment beams inherited as `BeamEmitter : &/SW_SHOTS/…`): the nested
    // `AmmoDrain` hit effects inside those beams now validate, and their legacy name is the same
    // genuine pre-rename bug as the entries above.
    "3119349707/sw_effects/shots/SuperLaser_beam_green.rules :: 'AmmoDrain' was renamed to 'ResourceDrain' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/sw_effects/shots/SuperLaser_beam_green2.rules :: 'AmmoDrain' was renamed to 'ResourceDrain' in a newer game version (ammo was generalized into the resource system).",
    "3119349707/ships/terran/weapons/super/mega_ion_impulse_cannon/mega_ion_impulse_wave_child_shot03.rules :: 'ExplosiveAmmoDrain' was renamed to 'ExplosiveResourceDrain' in a newer game version (ammo was generalized into the resource system).",
]);

const rulesFiles = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const entry of entries) {
            const p = join(dir, entry);
            let s;
            try { s = statSync(p); } catch { continue; }
            if (s.isDirectory()) walk(p);
            else if (entry.endsWith('.rules')) out.push(p);
        }
    };
    walk(root);
    return out;
};

/** The machine-independent key `<modId>/<path within the mod>` with forward slashes. */
const modSignature = (file: string): string => file.replace(/\\/g, '/').split('/799600/')[1] ?? file.replace(/\\/g, '/');

describe.skipIf(!HAVE)('schema false-positive scan over installed workshop mods', () => {
    it('flags only the known genuine mod bugs across every mod (no new false positives)', async () => {
        // Production order. Workspace init and forward alias index from the real cosmoteer.rules first, so
        // game-root `<./Data/…>` includes resolve, then reverse-include over the merged tree.
        const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;
        const resolveRef = async (fileRef: string, fromUri: string) => {
            const rel = fileRef.replace(/[<>]/g, '').trim();
            if (!rel) return undefined;
            const withExt = /\.[^/\\.]+$/.test(rel) ? rel : `${rel}.rules`;
            for (const abs of [join(dirname(fileURLToPath(fromUri)), withExt), join(DATA_DIR, withExt), join(dirname(DATA_DIR), withExt)]) {
                if (existsSync(abs)) { try { return parseReal(abs); } catch { return undefined; } }
            }
            return undefined;
        };
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const svc = CosmoteerWorkspaceService.instance;
        svc.setConnection({ languages: { diagnostics: { refresh: () => undefined } }, window: { showWarningMessage: () => undefined } } as unknown as Connection);
        await svc.initialize(DATA_DIR, noop);
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);

        const modDirs = readdirSync(MODS_DIR)
            .map((d) => join(MODS_DIR, d))
            .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
        ReverseIncludeIndex.instance.reset();
        await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR, ...modDirs], token);

        const modFiles = modDirs.flatMap((d) => rulesFiles(d));
        const unexpected: string[] = [];
        let reverseRooted = 0;
        try {
            for (const file of modFiles) {
                let doc;
                try { doc = parser(lexer(readFileSync(file, 'utf8')), pathToFileURL(file).href).value; } catch { continue; }
                // Files the reverse seam roots that native rooting misses.
                if (documentRootClass(doc) === undefined && ReverseIncludeIndex.instance.rootType(doc.uri) !== undefined) reverseRooted++;
                for (const e of await validateSchema(doc, token)) {
                    const sig = `${modSignature(file)} :: ${e.message}`;
                    if (!KNOWN_MOD_BUGS.has(sig)) unexpected.push(sig);
                }
            }
        } finally {
            // The mod-populated indexes must not leak into a later test sharing this worker.
            ReverseIncludeIndex.instance.reset();
            aliasRootIndex.invalidate();
        }

        // A path-resolution break would root nothing and so flag nothing. Require a floor to catch that.
        expect(reverseRooted).toBeGreaterThan(100);
        expect(unexpected.slice(0, 40)).toEqual([]);
    }, 600_000);
});
