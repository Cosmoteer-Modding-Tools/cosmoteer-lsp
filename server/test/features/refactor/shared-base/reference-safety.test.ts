import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeReferences, applyRebases } from '../../../../src/features/refactor/shared-base/reference-safety';

// A `<file path>` is read from the directory of the file it is written in, so a member carrying one
// means something different once it lives in a base file elsewhere. The judgement has to rewrite
// the path, and it only rewrites what it can prove, which is why the target has to exist on disk.
// These tests therefore run against a real directory tree rather than synthesized paths.
let root: string;
let partsDir: string;
let baseDir: string;

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'refsafety-')).replace(/\\/g, '/');
    partsDir = `${root}/parts`;
    baseDir = root;
    mkdirSync(partsDir);
    mkdirSync(`${root}/sprites`);
    writeFileSync(`${root}/sprites/armor.png`, '');
    writeFileSync(`${root}/base_part.rules`, 'Part\n{\n}\n');
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('reference safety of a member that moves into a base file', () => {
    it('rebases a file path when the base file lands in another directory', () => {
        const raw = 'Sprite = <../sprites/armor.png>';
        const verdict = analyzeReferences(raw, partsDir, baseDir);
        expect(verdict.safe).toBe(true);
        expect(verdict.rebases).toHaveLength(1);
        expect(verdict.rebases[0].newText).toBe('sprites/armor.png');
        // The span covers the path only, so the `<` and `>` survive the rewrite.
        expect(raw.slice(verdict.rebases[0].start, verdict.rebases[0].end)).toBe('../sprites/armor.png');
        expect(applyRebases(raw, verdict.rebases)).toBe('Sprite = <sprites/armor.png>');
    });

    it('leaves a file path alone when the base file lands in the same directory', () => {
        const raw = 'Base = <base_part.rules>/Part';
        const verdict = analyzeReferences(raw, baseDir, baseDir);
        expect(verdict.safe).toBe(true);
        expect(verdict.rebases).toEqual([]);
        expect(applyRebases(raw, verdict.rebases)).toBe(raw);
    });

    it('refuses a file path whose target does not exist', () => {
        // Nothing on disk proves the rewritten path still names the same file, so the member stays.
        const verdict = analyzeReferences('Sprite = <../sprites/missing.png>', partsDir, baseDir);
        expect(verdict.safe).toBe(false);
        expect(verdict.rebases).toEqual([]);
    });

    it('carries a game-root path over verbatim', () => {
        // `<./Data/…>` is read from the install root, so it means the same thing wherever written.
        const raw = 'Sprite = <./Data/ships/terran/armor.png>';
        const verdict = analyzeReferences(raw, partsDir, baseDir);
        expect(verdict.safe).toBe(true);
        expect(verdict.rebases).toEqual([]);
        expect(applyRebases(raw, verdict.rebases)).toBe(raw);
    });

    it('refuses an unterminated file path', () => {
        expect(analyzeReferences('Sprite = <../sprites/armor.png', partsDir, baseDir).safe).toBe(false);
    });

    it('refuses every reference form that resolves against its surroundings', () => {
        const forms = [
            'Power = &~/Components/Reactor/Power',
            'Work = &^/0/ConstructionWork',
            'Work = &BUILD_WORK',
            'Health = (&:/MaxHealth)',
        ];
        for (const raw of forms) expect(analyzeReferences(raw, partsDir, baseDir).safe).toBe(false);
    });

    it('judges a reference inside a quoted string like any other, since the game evaluates it', () => {
        // Quoted text is not skipped: the game's own computed values are quoted expressions carrying
        // real references (`"round((&~/Tier) * 40, 0)"`), so a `~` or a path inside quotes has to be
        // judged. The cost is that a quoted string which merely looks like a path is refused too.
        expect(analyzeReferences('MaxHealth = "round((&~/Tier) * 40, 0)"', partsDir, baseDir).safe).toBe(false);
        expect(analyzeReferences('NameKey = "<not/a/path>"', partsDir, baseDir).safe).toBe(false);
    });

    it('refuses a member whose quoting never closes', () => {
        expect(analyzeReferences('NameKey = "unclosed', partsDir, baseDir).safe).toBe(false);
    });

    it('rewrites several paths in one member from back to front without shifting them', () => {
        writeFileSync(`${root}/sprites/glow.png`, '');
        const raw = 'Sprites\n{\n\tA = <../sprites/armor.png>\n\tB = <../sprites/glow.png>\n}';
        const verdict = analyzeReferences(raw, partsDir, baseDir);
        expect(verdict.safe).toBe(true);
        expect(verdict.rebases).toHaveLength(2);
        expect(verdict.rebases[0].start).toBeLessThan(verdict.rebases[1].start);
        expect(applyRebases(raw, verdict.rebases)).toBe(
            'Sprites\n{\n\tA = <sprites/armor.png>\n\tB = <sprites/glow.png>\n}'
        );
    });
});
