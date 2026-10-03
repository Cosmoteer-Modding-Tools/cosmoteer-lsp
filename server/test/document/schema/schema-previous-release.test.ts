import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { schema, fieldOf, enumDef, selectSchemaForInstalledGame } from '../../../src/document/schema/schema';
import { setInstalledGameVersion } from '../../../src/document/schema/deprecations';
import { applySchemaOverlay } from '../../../src/document/schema/schema-overlay';
import { applyFieldDocs } from '../../../src/document/schema/field-docs';
import type { SchemaBundle, SchemaReleaseDelta } from '../../../src/document/schema/schema.types';

const SCHEMA_DIR = join(__dirname, '../../../src/document/schema');
const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8')) as T;
const delta = readJson<SchemaReleaseDelta>('cosmoteer.schema.previous.json');

/** The previous release's schema built the slow way, from an untouched copy of the shipped bundle. */
const previousFromScratch = (): SchemaBundle => {
    const raw = readJson<Record<string, Record<string, unknown> | undefined>>('cosmoteer.schema.json');
    for (const [section, entries] of Object.entries(delta.keyed)) {
        const target = (raw[section] ??= {});
        for (const [key, value] of Object.entries(entries)) {
            if (value === null) delete target[key];
            else target[key] = value;
        }
    }
    for (const [section, value] of Object.entries(delta.whole)) raw[section] = (value ?? undefined) as never;
    return applyFieldDocs(applySchemaOverlay(raw as unknown as SchemaBundle));
};

/** The parts of the bundle a switch can touch, as comparable text. */
const snapshot = (bundle: SchemaBundle): string =>
    JSON.stringify([bundle.types, bundle.enums, bundle.registries, bundle.builtinIds, bundle.componentKinds]);

const WEAPON = 'Cosmoteer.Ships.Parts.Weapons.WeaponRules';
const SHIP = 'Cosmoteer.Ships.ShipRules';

// A player on the release before the one the schema was extracted from gets that release's schema.
// The switch patches only the changed entries in place, which is only right while the overlay run
// over the patched bundle comes out the same as one over a fresh copy. These tests are that check.
describe('the previous release schema', () => {
    afterEach(() => {
        setInstalledGameVersion('');
        selectSchemaForInstalledGame();
    });

    it('is the shipped schema while the installed game is the release it was extracted from', () => {
        setInstalledGameVersion('0.30.5_rc1');
        expect(selectSchemaForInstalledGame()).toBe(false);
        expect(fieldOf(WEAPON, 'DefaultWeaponCoverage')).toBeDefined();
    });

    it('equals the previous release built from scratch once the installed game is older', () => {
        setInstalledGameVersion(delta.version);
        expect(selectSchemaForInstalledGame()).toBe(true);
        expect(snapshot(schema)).toBe(snapshot(previousFromScratch()));
    });

    it('reads the fields the previous release reads, and does not ask for the new ones', () => {
        setInstalledGameVersion('0.30.4c');
        selectSchemaForInstalledGame();
        expect(fieldOf(WEAPON, 'DefaultWeaponCoverage')).toBeUndefined();
        const aim = fieldOf(WEAPON, 'SaveShipRelativeTargets');
        expect(aim).toBeDefined();
        expect(aim!.dead).toBeFalsy();
        expect(fieldOf(SHIP, 'DefaultTargetingRangeExtension')).toBeUndefined();
        expect(fieldOf(SHIP, 'DefaultTargetingRangeFactor')?.dead).toBeFalsy();
        expect(enumDef(`${WEAPON}/WeaponToggleOnMode`)?.members).toContain('HasTargetExceptShipRelative');
    });

    it('switches back to exactly the shipped schema', () => {
        const shipped = snapshot(schema);
        setInstalledGameVersion('0.30.4c');
        selectSchemaForInstalledGame();
        expect(snapshot(schema)).not.toBe(shipped);
        setInstalledGameVersion('0.30.5');
        expect(selectSchemaForInstalledGame()).toBe(true);
        expect(snapshot(schema)).toBe(shipped);
    });
});
