import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../../src/utils/ast.utils';
import { clearSharedBaseScanCache } from '../../../../src/features/refactor/shared-base/mod-scan';
import { extractSharedBaseCodeActions } from '../../../../src/features/refactor/shared-base/extract-shared-base.codeaction';
import {
    EXTRACT_SHARED_BASE_ACTION_COMMAND,
    EXTRACT_SHARED_BASE_COMMAND,
} from '../../../../src/features/refactor/shared-base/shared-base.command';
import { SerializedPlan } from '../../../../src/features/refactor/shared-base/plan.types';
import { FIXTURES_DIR } from '../../../helpers';

// What the refactoring offered in the editor hands to the client. Both clients key off the command
// id and read the plan out of the single argument, and the server has to leave that id unclaimed, so
// this is the contract between the three of them.
const MOD_DIR = join(FIXTURES_DIR, 'shared-base-existing-mod').replace(/\\/g, '/');
const PART_FILE = `${MOD_DIR}/parts/hull_a.rules`;

beforeEach(() => clearSharedBaseScanCache());

describe('the extract-shared-base code action', () => {
    it('carries a command the server does not answer, so the editor runs it and can show a diff', async () => {
        // A client resolves a command against its own handlers only when the server does not claim
        // it. Claiming this one would send it straight back here, where there is no way to put a
        // diff in front of anybody.
        expect(EXTRACT_SHARED_BASE_ACTION_COMMAND).not.toBe(EXTRACT_SHARED_BASE_COMMAND);

        const text = readFileSync(PART_FILE, { encoding: 'utf-8' });
        const document = parseText(text, PART_FILE);
        const actions = await extractSharedBaseCodeActions(
            document,
            text,
            text.indexOf('Density'),
            [MOD_DIR],
            CancellationToken.None
        );
        expect(actions.length).toBeGreaterThan(0);

        const command = actions[0].command;
        expect(command?.command).toBe(EXTRACT_SHARED_BASE_ACTION_COMMAND);
        // One argument, and it is the plan itself: anything wrapping it would have to be unwrapped
        // identically by two clients written in different languages.
        expect(command?.arguments).toHaveLength(1);
        const plan = command?.arguments?.[0] as SerializedPlan;
        expect(plan.id).toBeTruthy();
        expect(plan.fields.length).toBeGreaterThan(0);
        expect(plan.participants.length).toBeGreaterThan(0);
        expect(plan.baseFsPath).toContain('base_hull.rules');
    });
});
