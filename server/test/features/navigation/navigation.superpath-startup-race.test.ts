import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import {
    FullNavigationStrategy,
    clearNavigationMemo,
} from '../../../src/features/navigation/full.navigation-strategy';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { initWorkspace, valueOf, workspaceFile } from '../../workspace-helper';

// Regression: an already-open file's validation resolves references before the workspace has
// finished initializing. A super-path (`&/…`) resolves through the game's `cosmoteer.rules`, which
// `navigateSuperPath` cannot load until then, so it returns null meaning "not ready", not "absent".
// That transient null used to be memoized as a genuine miss and (because the memo is only cleared
// on an fs change, never on init completing) permanently flagged a valid reference (e.g. the vanilla
// `&/PRIORITIES/ControlRoom_Supply` in a bridge part). The fix skips storing a super-path miss while
// the game root is unavailable, so a later resolution re-resolves it for real.
describe('super-path resolution across workspace init (startup race)', () => {
    it('does not pin a pre-init super-path miss that resolves once the game root is ready', async () => {
        const nav = new FullNavigationStrategy();
        const token = CancellationToken.None;

        // The singleton service is fresh in this isolated test module: not yet initialized.
        expect(CosmoteerWorkspaceService.instance.dataRootPath).toBeUndefined();
        clearNavigationMemo();

        // A start node is required by the signature but irrelevant to a super-path; parsing a file
        // does not depend on the service being initialized.
        const start = await parseFilePath(workspaceFile('a.rules'));
        const location = workspaceFile('a.rules');

        // Before init: cosmoteer.rules can't load, so this resolves to null ("not ready").
        const before = await nav.navigate('&/Palette/Main', start, location, token);
        expect(before).toBeNull();

        // Init completes. Nothing clears the navigation memo here, so a pinned miss would survive.
        await initWorkspace();

        // After init the same super-path must resolve for real (Palette/Main = 8 in the fixture's
        // cosmoteer.rules), proving the pre-init null was not pinned as a stale miss.
        const after = await nav.navigate('&/Palette/Main', start, location, token);
        expect(valueOf(after)).toBe(8);
    });
});
