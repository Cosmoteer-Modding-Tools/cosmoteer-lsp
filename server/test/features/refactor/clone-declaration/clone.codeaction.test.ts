import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { CodeActionKind } from 'vscode-languageserver';
import { cloneDeclarationCodeAction } from '../../../../src/features/refactor/clone-declaration/clone.codeaction';
import { CLONE_DECLARATION_ACTION_COMMAND } from '../../../../src/features/refactor/clone-declaration/clone.command';
import { parseText } from '../../../../src/utils/ast.utils';
import { FIXTURES_DIR } from '../../../helpers';

// The lightbulb offer. It is deliberately cheap: it consults no index, and it does not care whether
// the file belongs to the game, because copying a game part into a mod is the whole point.
const FIXTURE = join(FIXTURES_DIR, 'clone-declaration-mod').replace(/\\/g, '/');
const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

const offerAt = (path: string, at: string | number): ReturnType<typeof cloneDeclarationCodeAction> => {
    const text = read(path);
    const offset = typeof at === 'number' ? at : text.indexOf(at);
    return cloneDeclarationCodeAction(parseText(text, path), offset, `file:///${path}`);
};

describe('the clone offer', () => {
    it('is made in a part of the game s own install, which is the case it exists for', () => {
        const action = offerAt(`${FIXTURE}/Data/ships/terran/cannon/cannon.rules`, 'cosmoteer.cannon');
        expect(action).toMatchObject({
            kind: CodeActionKind.RefactorExtract,
            command: { command: CLONE_DECLARATION_ACTION_COMMAND },
        });
        expect(action?.command?.arguments?.[0]).toMatchObject({ offset: expect.any(Number) });
    });

    it('is made on a whole-file root and on a collection element as well', () => {
        expect(offerAt(`${FIXTURE}/Data/codex/lore/lore_cabal.rules`, 'cabal')).toBeDefined();
        expect(offerAt(`${FIXTURE}/Data/factions/factions.rules`, 'ID = cabal')).toBeDefined();
    });

    it('is made on a base template too, so the command can say why it will not copy one', () => {
        // Withholding the offer would leave the author wondering; the command answers with the reason.
        expect(offerAt(`${FIXTURE}/Data/ships/terran/template/derived.rules`, 'Size')).toBeDefined();
    });

    it('is not made where nothing declares anything, nor in a manifest', () => {
        expect(offerAt(`${FIXTURE}/Data/ships/terran/cannon/particles/smoke.rules`, 0)).toBeUndefined();
        expect(offerAt(`${FIXTURE}/mod/mod.rules`, 'Test.CloneDeclaration')).toBeUndefined();
    });
});
