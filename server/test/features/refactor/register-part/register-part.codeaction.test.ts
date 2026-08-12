import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeActionKind } from 'vscode-languageserver';
import { SchemaIdIndex } from '../../../../src/features/completion/schema-id.index';
import { registerPartInShipCodeAction } from '../../../../src/features/refactor/register-part/register-part.codeaction';
import {
    REGISTER_PART_IN_SHIP_ACTION_COMMAND,
    REGISTER_PART_IN_SHIP_COMMAND,
} from '../../../../src/features/refactor/register-part/register-part.command';
import { clearModRootCache } from '../../../../src/mod/mod-root';
import { globalSettings } from '../../../../src/settings';
import { parseText } from '../../../../src/utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../../../src/workspace/cosmoteer-workspace.service';
import { FIXTURES_DIR } from '../../../helpers';

// The lightbulb itself. It runs inside `onCodeAction`, which never awaits the project indexes, so
// everything it needs has to come out of the document in front of it.
const FIXTURE = join(FIXTURES_DIR, 'register-part-mod').replace(/\\/g, '/');
const MOD_DIR = `${FIXTURE}/mod`;
const PART_FILE = `${MOD_DIR}/parts/new_part.rules`;
const COMMENTED_PART = `${MOD_DIR}/parts/anonymous_part.rules`;
const VANILLA_PART = `${FIXTURE}/Data/ships/terran/reactor/reactor.rules`;

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

let wasAllowed: boolean;

beforeEach(() => {
    clearModRootCache();
    wasAllowed = globalSettings.allowEditingVanillaFiles;
    globalSettings.allowEditingVanillaFiles = false;
});

afterEach(() => {
    globalSettings.allowEditingVanillaFiles = wasAllowed;
    clearModRootCache();
});

describe('the register-part code action', () => {
    it('is offered with the caret inside the part group of a file in a mod', () => {
        const text = read(PART_FILE);
        const action = registerPartInShipCodeAction(parseText(text, PART_FILE), text.indexOf('Size'), PART_FILE);
        expect(action?.kind).toBe(CodeActionKind.RefactorExtract);
    });

    it('carries the unclaimed command and the group name offset, and no edit of its own', () => {
        // A client resolves a command against its own handlers only when the server does not claim
        // it. Claiming this one would send it straight back, where nobody can be asked which ship.
        expect(REGISTER_PART_IN_SHIP_ACTION_COMMAND).not.toBe(REGISTER_PART_IN_SHIP_COMMAND);

        const text = read(PART_FILE);
        const action = registerPartInShipCodeAction(parseText(text, PART_FILE), text.indexOf('ID'), PART_FILE);
        expect(action?.edit).toBeUndefined();
        expect(action?.command?.command).toBe(REGISTER_PART_IN_SHIP_ACTION_COMMAND);
        expect(action?.command?.arguments).toHaveLength(1);
        expect(action?.command?.arguments?.[0]).toEqual({ uri: PART_FILE, offset: text.indexOf('Part') });
    });

    it('is not offered with the caret outside the part group span', () => {
        const before = read(COMMENTED_PART);
        expect(registerPartInShipCodeAction(parseText(before, COMMENTED_PART), 0, COMMENTED_PART)).toBeUndefined();
        const after = read(PART_FILE);
        expect(registerPartInShipCodeAction(parseText(after, PART_FILE), after.length, PART_FILE)).toBeUndefined();
    });

    it('is not offered in a mod manifest, whatever the manifest happens to hold', () => {
        const manifest = `${MOD_DIR}/mod.rules`;
        const text = 'Part\n{\n\tID = test.in_manifest\n}\n';
        expect(registerPartInShipCodeAction(parseText(text, manifest), text.indexOf('ID'), manifest)).toBeUndefined();
    });

    it('leaves the game data alone until the vanilla-editing switch says otherwise', () => {
        const text = read(VANILLA_PART);
        const offset = text.indexOf('ID');
        expect(registerPartInShipCodeAction(parseText(text, VANILLA_PART), offset, VANILLA_PART)).toBeUndefined();
        globalSettings.allowEditingVanillaFiles = true;
        expect(registerPartInShipCodeAction(parseText(text, VANILLA_PART), offset, VANILLA_PART)).toBeDefined();
    });

    it('is offered with no project index built at all, which is the state it always runs in', () => {
        // Gating the offer on an id index would withhold it for as long as the build takes, and a
        // mod ship never reaches that index in the first place.
        expect(CosmoteerWorkspaceService.instance.dataRootPath).toBeUndefined();
        expect(SchemaIdIndex.instance.hasFileDeclarationsFor('Cosmoteer.Ships.ShipRules')).toBe(false);
        const text = read(PART_FILE);
        expect(registerPartInShipCodeAction(parseText(text, PART_FILE), text.indexOf('Size'), PART_FILE)).toBeDefined();
    });
});
