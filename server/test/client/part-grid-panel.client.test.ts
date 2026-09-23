import { beforeEach, describe, expect, it } from 'vitest';
import { PartGridEditorPanel } from '../../../client/src/part-editor/editor-panel';
import {
    appliedEdits,
    applyEditAnswer,
    createdPanels,
    ExtensionContext,
    openDocuments,
    Position,
    resetStub,
    Uri,
} from './vscode-stub';

// The grid editor draws a mutation against the version of the file it last rendered. The server
// builds the edit from that version too, but the author can type while it does, and an edit whose
// ranges point into text that has moved writes into the wrong place. The server refuses a request it
// sees race; this is the last gate before the write, for a change that lands after the server
// answered.
const PART = Uri.file('c:/mod/parts/part.rules');

const context = (): ExtensionContext => ({ subscriptions: [], extensionUri: Uri.file('c:/ext') }) as never;

/** A grid payload thin enough to render, with no sprites so nothing reads the disk. */
const payload = { anchor: { line: 0, character: 0 }, partName: 'Part', sprites: [], dependsOn: [] };

/** A language client that renders once, then answers every edit with the given result. */
const clientAnswering = (editResult: unknown): never =>
    ({
        sendRequest: (method: string) =>
            Promise.resolve(String(method).includes('partGridData') ? payload : editResult),
        protocol2CodeConverter: { asWorkspaceEdit: (edit: unknown) => Promise.resolve(edit) },
    }) as never;

/** Opens the panel on the part and hands back the webview the test drives. */
const openPanel = async (editResult: unknown) => {
    await PartGridEditorPanel.show(context(), clientAnswering(editResult), PART, new Position(0, 0));
    return createdPanels[createdPanels.length - 1];
};

/** The edit message the page sends after drawing against `dataVersion`. */
const clickAt = (dataVersion: number) => ({
    type: 'edit',
    dataVersion,
    mutation: { op: 'addCell', layerId: 'Cells', cell: { x: 0, y: 0 } },
});

describe('the last gate before the grid editor writes', () => {
    beforeEach(() => {
        // The panel is a singleton across shows, so each test gets a fresh one by disposing the
        // previous panel, which is what the editor does when its tab is closed. This has to happen
        // before the stub is reset, or the list of panels to dispose is already empty.
        for (const panel of createdPanels) panel.dispose();
        resetStub();
        openDocuments.push({ uri: PART, version: 7 });
    });

    it('applies the edit when the file has not moved since the page drew it', async () => {
        const panel = await openPanel({ status: 'ok', edit: { changes: {} } });
        await panel.send(clickAt(7));
        expect(appliedEdits).toHaveLength(1);
        expect(panel.lastPosted('editRejected')).toBeUndefined();
    });

    it('refuses to write when the file moved on while the server built the edit', async () => {
        const panel = await openPanel({ status: 'ok', edit: { changes: {} } });
        openDocuments[0].version = 8;
        await panel.send(clickAt(7));
        expect(appliedEdits).toHaveLength(0);
        expect(panel.lastPosted('editRejected')?.reason).toBe('stale');
    });

    it('redraws the page after refusing, so the next click is drawn against the new text', async () => {
        const panel = await openPanel({ status: 'ok', edit: { changes: {} } });
        panel.posted.length = 0;
        openDocuments[0].version = 8;
        await panel.send(clickAt(7));
        expect(panel.lastPosted('render')).toBeDefined();
    });

    it('passes the server its own refusal through, rather than writing anyway', async () => {
        const panel = await openPanel({ status: 'stale' });
        await panel.send(clickAt(7));
        expect(appliedEdits).toHaveLength(0);
        expect(panel.lastPosted('editRejected')?.reason).toBe('stale');
    });

    it('says so when the editor itself turned the write down', async () => {
        const panel = await openPanel({ status: 'ok', edit: { changes: {} } });
        applyEditAnswer.applied = false;
        await panel.send(clickAt(7));
        expect(panel.lastPosted('editRejected')?.reason).toBe('applyFailed');
    });
});
