import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { join, resolve } from 'path';

// The part table page's header shortening, imported straight from the shipped media script (its
// module.exports guard activates outside a webview). A member path makes a poor column header: it is
// long, it repeats the same leading segments on every component field, and its last segment is often
// the least telling part of it.
const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const page = require(join(REPO_ROOT, 'media', 'part-table.js')) as {
    headerOf(path: string): { context: string; label: string };
    headersFor(keys: readonly string[]): Map<string, { context: string; label: string }>;
    parseTyped(text: string): { value: number; text: string } | null;
};

const header = (path: string): string => {
    const { context, label } = page.headerOf(path);
    return context ? `${context} | ${label}` : label;
};

describe('part table column headers', () => {
    it('leaves a field of the part itself alone', () => {
        expect(header('MaxHealth')).toBe('MaxHealth');
    });

    it('reads an index as part of the field it indexes', () => {
        expect(header('Size/0')).toBe('Size 0');
        expect(header('Components/ArcShield/PenetrationResistance/0')).toBe('ArcShield | PenetrationResistance 0');
    });

    it('names a modifiable value by its field rather than by its wrapper', () => {
        expect(header('Components/ArcShield/Radius/BaseValue')).toBe('ArcShield | Radius');
    });

    it('drops the segment every component field starts with', () => {
        expect(header('Components/BatteryStorage/MaxResources')).toBe('BatteryStorage | MaxResources');
    });

    it('keeps the group of a field that is not a component', () => {
        expect(header('Resources/steel')).toBe('Resources | steel');
    });

    it("reads the game's stats block as the stats, numbering only a second category", () => {
        expect(header('StatsByCategory/0/Stats/ShieldHP')).toBe('Stats | ShieldHP');
        expect(header('StatsByCategory/1/Stats/ROF')).toBe('Stats 1 | ROF');
        expect(header('StatsByCategory/0/Stats/DamagePerSecond/1')).toBe('Stats | DamagePerSecond 1');
    });

    it('names a computed column by its name alone', () => {
        expect(header('@Cost')).toBe('Cost');
        expect(header('@DPS')).toBe('DPS');
    });

    it('gives two fields that shorten alike their whole path back', () => {
        // One part writes the radius as a plain number and another wraps it in a modifiable value.
        // Both columns are in the table, and both would read as "ArcShield | Radius".
        const paths = ['Components/ArcShield/Radius', 'Components/ArcShield/Radius/BaseValue'];
        const headers = page.headersFor(paths);
        for (const path of paths) {
            expect(headers.get(path)).toEqual({ context: '', label: path });
        }
    });

    it('reads a typed value the way the game reads a literal', () => {
        expect(page.parseTyped(' 6000 ')).toEqual({ value: 6000, text: '6000' });
        expect(page.parseTyped('150%')).toEqual({ value: 1.5, text: '150%' });
        expect(page.parseTyped('90d')?.value).toBeCloseTo(Math.PI / 2, 10);
        expect(page.parseTyped('1.5r')).toEqual({ value: 1.5, text: '1.5r' });
        expect(page.parseTyped('abc')).toBeNull();
        expect(page.parseTyped('')).toBeNull();
    });

    it('leaves a header that names one column shortened', () => {
        const headers = page.headersFor(['MaxHealth', 'Components/ArcShield/Radius/BaseValue']);
        expect(headers.get('Components/ArcShield/Radius/BaseValue')).toEqual({
            context: 'ArcShield',
            label: 'Radius',
        });
    });
});
