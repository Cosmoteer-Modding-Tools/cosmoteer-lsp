import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { validateRedundantOverrides } from '../../../src/features/diagnostics/validator.redundant-override';
import { clearBaseFileCache } from '../../../src/features/refactor/shared-base/base-index';
import { clearInheritedValueCache } from '../../../src/features/refactor/shared-base/inherited-value';
import { ValidationError } from '../../../src/features/diagnostics/validator';
import { FIXTURES_DIR } from '../../helpers';

// A mod whose base file supplies values that one of its parts writes out again. The fixture exists
// on disk because the check has to prove that a path in the base and a path in the deriver name the
// same file, which only the filesystem can answer.
const MOD_DIR = join(FIXTURES_DIR, 'redundant-override-mod').replace(/\\/g, '/');

const validate = async (name: string): Promise<ValidationError[]> => {
    const fsPath = `${MOD_DIR}/parts/${name}`;
    const text = readFileSync(fsPath, { encoding: 'utf-8' });
    return validateRedundantOverrides(parseText(text, fsPath), text, CancellationToken.None);
};

const names = (errors: readonly ValidationError[]): string[] =>
    errors.map((error) => /'([^']+)'/.exec(error.message)?.[1] ?? '').sort();

beforeEach(() => {
    clearBaseFileCache();
    clearInheritedValueCache();
});

describe('a field whose value the base already supplies', () => {
    it('is faded, and only when the base really does say the same thing', async () => {
        const errors = await validate('hull_a.rules');
        // Density repeats the base word for word. IsRotateable disagrees with it, so it is doing
        // work. Size agrees but is a list, which the game prepends rather than replaces.
        expect(names(errors)).toEqual(['Density', 'JobsIcon']);
    });

    it('carries a remove fix over the span of the field itself', async () => {
        const errors = await validate('hull_a.rules');
        const density = errors.find((error) => error.message.includes("'Density'"));
        expect(density?.severity).toBe('hint');
        expect(density?.unnecessary).toBe(true);
        const remove = (density?.data as { remove?: { start: number; end: number } } | undefined)?.remove;
        expect(remove).toBeDefined();
        const text = readFileSync(`${MOD_DIR}/parts/hull_a.rules`, { encoding: 'utf-8' });
        expect(text.slice(remove!.start, remove!.end)).toBe('Density = 3');
    });

    it('is faded when a relative asset path names the same file from both directories', async () => {
        // The base writes `sprites/hull.png` from the mod root and the part writes
        // `../sprites/hull.png` from `parts/`. Different text, same file, so the override is dead.
        const errors = await validate('hull_a.rules');
        expect(errors.some((error) => error.message.includes("'JobsIcon'"))).toBe(true);
    });

    it('is left alone when the same spelling names a different file', async () => {
        // `hull.png` beside the part is not the `sprites/hull.png` the base means, so writing it is
        // the whole point of the override.
        expect(await validate('hull_b.rules')).toEqual([]);
    });

    it('is left alone when the value carries a reference that resolves against its own file', async () => {
        // Both files write `"&~/SPEED"`, which starts at the root of whichever file it is written in,
        // so identical text is no proof of an identical value.
        const errors = await validate('hull_a.rules');
        expect(names(errors)).not.toContain('CrewSpeedFactor');
    });
});
