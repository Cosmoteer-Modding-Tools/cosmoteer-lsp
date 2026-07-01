import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { ReferenceAutoCompletionStrategy } from '../../../src/features/completion/strategy/reference.autocompletion-strategy';
import { AbstractNode, AbstractNodeDocument, ValueNode } from '../../../src/core/ast/ast';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { invalidateModContext } from '../../../src/mod/mod-context';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';
import { FIXTURES_DIR } from '../../helpers';

// Reference completion must offer members the mod merges into a vanilla file via a whole-file /
// file-aliasing-global `Overrides`, alongside the file's own — so `&/INDICATORS/` (which aliases the
// vanilla indicators file) and `&/BASE_AUDIO/` (a global aliasing a whole file) reflect the EFFECTIVE
// tree. The origin (editing) file's URI is threaded through so the owning mod is found even though
// the traversal walks INTO the vanilla cosmoteer.rules to follow the global.
const completion = new ReferenceAutoCompletionStrategy();
const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'mod');
const pos = { line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 };

const refNode = (value: string, parent: AbstractNode): ValueNode => ({
    type: 'Value',
    valueType: { type: 'Reference', value },
    position: pos,
    parent,
});

const complete = (value: string, parent: AbstractNode) =>
    completion.complete({ node: refNode(value, parent), isInheritanceNode: false, cancellationToken: token });

describe('ReferenceAutoCompletionStrategy — mod override members', () => {
    // A document INSIDE the mod, so the completion origin resolves to the mod root.
    let modDoc: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        clearModRootCache();
        invalidateModContext();
        modDoc = await parseFilePath(join(MOD_DIR, 'consumer.rules'));
    });

    it('`&/INDICATORS/` lists the mod-added member AND the vanilla member', async () => {
        const options = await complete('&/INDICATORS/', modDoc);
        expect(options).toContain('SWNoShields'); // merged in via the mod's whole-file Overrides
        expect(options).toContain('Scorched'); // the vanilla file's own member
    });

    it('`&/BASE_AUDIO/` lists a member merged into a file-aliasing global', async () => {
        const options = await complete('&/BASE_AUDIO/', modDoc);
        expect(options).toContain('SWExtraSound'); // merged via OverrideIn=<cosmoteer.rules>/BASE_AUDIO
        expect(options).toContain('BaseAudio'); // the aliased file's own member
    });

    it('does not invent members for a global the mod does not override (`&/Palette/`)', async () => {
        const options = await complete('&/Palette/', modDoc);
        expect(options).toContain('Main');
        expect(options).not.toContain('SWNoShields');
    });
});
