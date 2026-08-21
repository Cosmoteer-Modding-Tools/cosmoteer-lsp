import { describe, expect, it } from 'vitest';
import {
    overridesActionText,
    overridesTargetPath,
    sparseOverrideFileText,
} from '../../../../src/features/refactor/override-in-mod/overrides-action.emitter';

// The text the feature writes. The shape is the one the game's own `Standard Mods/example_mod`
// teaches, so it is compared against that spelling rather than against a house style.
const DATA_DIR = 'C:/Game/Data';
const CANNON = 'C:/Game/Data/parts/cannon/cannon.rules';

describe('the target path an override names', () => {
    it('reads from the game Data folder, in the bare form the game own example mod writes', () => {
        expect(overridesTargetPath(DATA_DIR, CANNON, ['Part', 'Components'])).toBe(
            '<parts/cannon/cannon.rules>/Part/Components'
        );
    });

    it('names the file alone when the file top level is the target', () => {
        // A file top level is a group in the game's own tree, which is why Overrides accepts it.
        expect(overridesTargetPath(DATA_DIR, CANNON, [])).toBe('<parts/cannon/cannon.rules>');
    });
});

describe('the action entry an override writes', () => {
    it('matches the shape the game own example mod uses', () => {
        const text = overridesActionText(
            '<parts/cannon/cannon.rules>/Part',
            { kind: 'inline', body: '\t\t\tDensity = 8' },
            '\t'
        );
        expect(text).toBe(
            [
                '\t{',
                '\t\tAction = Overrides',
                '\t\tOverrideIn = "<parts/cannon/cannon.rules>/Part"',
                '\t\tOverrides',
                '\t\t{',
                '\t\t\tDensity = 8',
                '\t\t}',
                '\t}',
            ].join('\n')
        );
    });

    it('holds exactly one member, so nothing under the target is replaced by accident', () => {
        const text = overridesActionText(
            '<parts/cannon/cannon.rules>/Part/Components/Weapon',
            { kind: 'inline', body: '\t\t\tWeapon\n\t\t\t{\n\t\t\t\tDamage = 12\n\t\t\t}' },
            '\t'
        );
        const body = text.split('\n').slice(5, -2);
        // Only one member head sits at the map's own depth. Anything else there would be a second
        // child of the target, and anything deeper would be a nested body, which the game applies as
        // a replacement of everything under the node it nests through.
        expect(body.filter((line) => /^\t{3}[A-Za-z_]/.test(line))).toEqual(['\t\t\tWeapon']);
    });

    it('points at a file of the mod when the map is not written inline', () => {
        const text = overridesActionText(
            '<parts/cannon/cannon.rules>/Part',
            { kind: 'reference', reference: '&<overrides/cannon_Part.rules>/Part' },
            '\t'
        );
        expect(text).toContain('\t\tOverrides = &<overrides/cannon_Part.rules>/Part');
        expect(text).not.toContain('{\n\t\t\t');
    });

    it('carries the entry indentation into the body, so a deeper list keeps its shape', () => {
        const text = overridesActionText('<a.rules>/A', { kind: 'inline', body: '\t\t\tDensity = 8' }, '\t\t');
        expect(text.split('\n')).toEqual([
            '\t\t{',
            '\t\t\tAction = Overrides',
            '\t\t\tOverrideIn = "<a.rules>/A"',
            '\t\t\tOverrides',
            '\t\t\t{',
            '\t\t\t\tDensity = 8',
            '\t\t\t}',
            '\t\t}',
        ]);
    });

    it('writes the line ending the manifest already uses', () => {
        const text = overridesActionText('<a.rules>/A', { kind: 'inline', body: '\t\t\tDensity = 8' }, '\t', '\r\n');
        expect(text.split('\r\n')).toHaveLength(8);
        expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    });
});

describe('the fragment file an override can be kept in', () => {
    it('is one group holding the member, at the depth a file of its own uses', () => {
        expect(sparseOverrideFileText('Part', '\t\t\tDensity = 8')).toBe('Part\n{\n\tDensity = 8\n}\n');
    });

    it('keeps a multi-line member together and takes the manifest line ending', () => {
        const text = sparseOverrideFileText('Weapon', '\t\t\tSizes\n\t\t\t[\n\t\t\t\t2\n\t\t\t]', '\r\n');
        expect(text).toBe('Weapon\r\n{\r\n\tSizes\r\n\t[\r\n\t\t2\r\n\t]\r\n}\r\n');
    });
});
