import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeActionKind } from 'vscode-languageserver';
import {
    OVERRIDE_IN_MOD_ACTION_COMMAND,
    OVERRIDE_IN_MOD_COMMAND,
} from '../../../../src/features/refactor/override-in-mod/override-in-mod.command';
import {
    clearOverrideInModCache,
    overrideInModCodeAction,
} from '../../../../src/features/refactor/override-in-mod/override-in-mod.codeaction';
import { clearModRootCache } from '../../../../src/mod/mod-root';
import { parseText } from '../../../../src/utils/ast.utils';
import { FIXTURES_DIR } from '../../../helpers';

// The lightbulb itself. It runs inside `onCodeAction`, which never awaits the project indexes, so
// everything it needs has to come out of the document in front of it and the folders it is handed.
const FIXTURE = join(FIXTURES_DIR, 'override-in-mod-mod').replace(/\\/g, '/');
const DATA_DIR = `${FIXTURE}/Data`;
const CANNON = `${DATA_DIR}/parts/cannon/cannon.rules`;
const STRINGS = `${DATA_DIR}/strings/en.rules`;
const MOD_DIR = `${FIXTURE}/mod`;
const MOD_MANIFEST = `${MOD_DIR}/mod.rules`;
const PLAIN_DIR = `${FIXTURE}/plainfolder`;
const SHADER = `${DATA_DIR}/parts/cannon/cannon.shader`;

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The offer for a caret on the member the needle names. */
const offer = (fsPath: string, needle: string, folders: string[] = [MOD_DIR]) => {
    const text = read(fsPath);
    const at = text.indexOf(needle) + 1;
    return overrideInModCodeAction(parseText(text, fsPath), text, at, fsPath, DATA_DIR, folders);
};

beforeEach(() => {
    clearModRootCache();
    clearOverrideInModCache();
});

afterEach(() => {
    clearModRootCache();
    clearOverrideInModCache();
});

describe('the override code action', () => {
    it('is offered on a value of the game own files when the workspace holds a mod', () => {
        const action = offer(CANNON, 'Damage = 12');
        expect(action?.kind).toBe(CodeActionKind.RefactorExtract);
        expect(action?.title).toContain('Damage');
    });

    it('carries the unclaimed command and the member offset, and no edit of its own', () => {
        // A client resolves a command against its own handlers only when the server does not claim
        // it. Claiming this one would send it straight back, where nobody can be asked which mod.
        expect(OVERRIDE_IN_MOD_ACTION_COMMAND).not.toBe(OVERRIDE_IN_MOD_COMMAND);

        const text = read(CANNON);
        const action = offer(CANNON, 'Damage = 12');
        expect(action?.edit).toBeUndefined();
        expect(action?.command?.command).toBe(OVERRIDE_IN_MOD_ACTION_COMMAND);
        expect(action?.command?.arguments).toEqual([{ uri: CANNON, offset: text.indexOf('Damage = 12') }]);
    });

    it('is not offered when the workspace holds no mod to write into', () => {
        expect(offer(CANNON, 'Damage = 12', [PLAIN_DIR])).toBeUndefined();
    });

    it('is not offered when the game folder is unknown', () => {
        const text = read(CANNON);
        const at = text.indexOf('Damage = 12') + 1;
        expect(
            overrideInModCodeAction(parseText(text, CANNON), text, at, CANNON, undefined, [MOD_DIR])
        ).toBeUndefined();
    });

    it('is not offered inside a mod, which is edited directly', () => {
        expect(offer(MOD_MANIFEST, 'Action = Add')).toBeUndefined();
    });

    it('is not offered on a language strings file, which no action can touch', () => {
        expect(offer(STRINGS, 'Parts/Cannon')).toBeUndefined();
    });

    it('is not offered on a shader, whose parse is not an object text tree', () => {
        const text = 'float4 main() { return 1; }\n';
        expect(
            overrideInModCodeAction(parseText(text, SHADER), text, 5, SHADER, DATA_DIR, [MOD_DIR])
        ).toBeUndefined();
    });

    it('is not offered where the member analysis refuses, so the offer never leads to a dead end', () => {
        for (const needle of ['Scoped', 'Missing', 'Inherited', 'Twice = 2']) {
            expect(offer(CANNON, needle), needle).toBeUndefined();
        }
    });

    it('answers the same way twice, since the folder walk it makes is remembered for a moment', () => {
        expect(offer(CANNON, 'Damage = 12')).toBeTruthy();
        expect(offer(CANNON, 'Density = 5')).toBeTruthy();
        clearOverrideInModCache();
        expect(offer(CANNON, 'Damage = 12', [PLAIN_DIR])).toBeUndefined();
    });
});
