import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import {
    CloneTarget,
    CloneTargetResult,
    cloneShapesOf,
    copyUnitOf,
    dirOfPath,
    locateCloneTarget,
    removableMemberSpan,
} from '../../../../src/features/refactor/clone-declaration/clone-target';
import { clearModRootCache } from '../../../../src/mod/mod-root';
import { parseText } from '../../../../src/utils/ast.utils';
import { FIXTURES_DIR } from '../../../helpers';

// What the caret anchors, what it refuses, and how much of the source a copy would carry. Everything
// here is decided from the files alone, so no index and no game install take part.
const FIXTURE = join(FIXTURES_DIR, 'clone-declaration-mod').replace(/\\/g, '/');
const CANNON = `${FIXTURE}/Data/ships/terran/cannon/cannon.rules`;
const WALL = `${FIXTURE}/Data/ships/terran/walls/wall.rules`;
const DERIVED = `${FIXTURE}/Data/ships/terran/template/derived.rules`;
const ORPHAN = `${FIXTURE}/Data/ships/terran/template/orphan.rules`;
const TWO = `${FIXTURE}/Data/ships/terran/twoids/two.rules`;
const LORE = `${FIXTURE}/Data/codex/lore/lore_cabal.rules`;
const FACTIONS = `${FIXTURE}/Data/factions/factions.rules`;
const SMOKE = `${FIXTURE}/Data/ships/terran/cannon/particles/smoke.rules`;

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The lookup against a fixture file, at the offset of the first occurrence of `at`. */
const locate = async (path: string, at: string | number): Promise<CloneTargetResult> => {
    const text = read(path);
    const offset = typeof at === 'number' ? at : text.indexOf(at);
    return await locateCloneTarget(parseText(text, path), offset, path, `file:///${path}`, CancellationToken.None);
};

/** The located target, asserting the lookup found one. */
const targetOf = (result: CloneTargetResult): CloneTarget => {
    if ('refusal' in result) throw new Error(`expected a target, got the refusal "${result.refusal}"`);
    return result.target;
};

beforeEach(() => clearModRootCache());
afterEach(() => clearModRootCache());

describe('anchoring a clone', () => {
    it('anchors on a part group, on a whole-file root, and on a collection element alike', async () => {
        expect(targetOf(await locate(CANNON, 'cosmoteer.cannon'))).toMatchObject({
            id: 'cosmoteer.cannon',
            identityKey: 'ID',
            cls: 'Cosmoteer.Ships.Parts.PartRules',
            member: 'Part',
            unit: 'directory',
        });
        expect(targetOf(await locate(LORE, 'cabal'))).toMatchObject({
            id: 'cabal',
            cls: 'Cosmoteer.Codex.CodexPageRules',
            member: '',
        });
        expect(targetOf(await locate(FACTIONS, 'ID = cabal'))).toMatchObject({
            id: 'cabal',
            cls: 'Cosmoteer.Factions.FactionRules',
            member: 'Factions',
            unit: 'listElement',
        });
    });

    it('anchors on the declaration the caret is in when a file writes several', async () => {
        expect(targetOf(await locate(TWO, 'cosmoteer.two_two')).id).toBe('cosmoteer.two_two');
        expect(targetOf(await locate(TWO, 'cosmoteer.two_one')).id).toBe('cosmoteer.two_one');
    });

    it('refuses to guess when the file writes several and the caret is in none of them', async () => {
        const text = read(TWO);
        const between = text.indexOf('}\n\nPart') + 2;
        expect(await locate(TWO, between)).toEqual({ refusal: 'severalIdentities' });
    });

    it('anchors nothing in a file that declares nothing and nothing in a manifest', async () => {
        expect(await locate(SMOKE, 0)).toEqual({ refusal: 'noDeclaration' });
        const text = read(`${FIXTURE}/mod/mod.rules`);
        const located = await locateCloneTarget(
            parseText(text, `${FIXTURE}/mod/mod.rules`),
            text.indexOf('Test.CloneDeclaration'),
            `${FIXTURE}/mod/mod.rules`,
            `file:///${FIXTURE}/mod/mod.rules`,
            CancellationToken.None
        );
        expect(located).toEqual({ refusal: 'noDeclaration' });
    });
});

describe('the refusals a clone decides before a destination is known', () => {
    it('refuses a container that only inherits its identity, which a copy would collide with', async () => {
        expect(await locate(DERIVED, 'Size')).toEqual({ refusal: 'inheritedIdentity' });
    });

    it('refuses a container whose base cannot be read, since nothing can be said about the copy', async () => {
        expect(await locate(ORPHAN, 'cosmoteer.orphan')).toEqual({ refusal: 'unreadableBase' });
    });
});

describe('the copy unit', () => {
    it('carries the whole folder when the file is the only thing in it that declares an id', async () => {
        expect(await copyUnitOf(CANNON, CancellationToken.None)).toBe('directory');
    });

    it('carries the single file when a neighbour declares an id the copy would duplicate', async () => {
        expect(await copyUnitOf(WALL, CancellationToken.None)).toBe('file');
    });

    it('never carries a whole mod, however few declarations the folder holds', async () => {
        expect(await copyUnitOf(`${FIXTURE}/mod/mod.rules`, CancellationToken.None)).toBe('file');
    });
});

describe('reading the source', () => {
    it('finds the shapes of a document without deciding which one the caret means', () => {
        const text = read(TWO);
        expect(cloneShapesOf(parseText(text, TWO)).map((shape) => shape.identity?.id)).toEqual([
            'cosmoteer.two_one',
            'cosmoteer.two_two',
        ]);
    });

    it('measures an OtherIDs member from its name to the end of its line', () => {
        const text = read(CANNON);
        const document = parseText(text, CANNON);
        const part = document.elements.find((element) => 'identifier' in element)!;
        const span = removableMemberSpan(part as never, text, 'OtherIDs')!;
        expect(text.slice(span.start, span.end)).toBe('\tOtherIDs = [old_cannon]\n');
    });

    it('reads a directory off a path with either separator', () => {
        expect(dirOfPath('C:\\a\\b\\c.rules')).toBe('C:/a/b');
        expect(dirOfPath('/a/b/c.rules')).toBe('/a/b');
    });
});
