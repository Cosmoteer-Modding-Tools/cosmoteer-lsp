import { beforeEach, describe, expect, it } from 'vitest';
import { registerGameLog } from '../../../client/src/game-log/game-log';
import { createdCollections, ExtensionContext, registeredCommands, resetStub, Uri, window } from './vscode-stub';

// Importing the game log from a file the command cannot ask about, a note or anything outside a mod,
// used to empty the panel of everything an earlier import had put there. The two outcomes that never
// reached the question leave the collection alone; every other outcome is a newer word on this mod's
// files, so those still clear first. This is the module the campaign shipped without a check.
const context = (): ExtensionContext => ({ subscriptions: [] });

/** A language client that answers one canned result, standing in for the server. */
const clientAnswering = (result: unknown): { sendRequest: () => Promise<unknown> } => ({
    sendRequest: () => Promise.resolve(result),
});

const runImport = async (result: unknown): Promise<void> => {
    registerGameLog(context(), clientAnswering(result) as never);
    const handler = registeredCommands.get('cosmoteer.importGameLog');
    expect(handler, 'the import command was registered').toBeTypeOf('function');
    await handler!();
};

/** The collection the activation made, with one finding already on it from an earlier import. */
const collectionCarryingAFinding = () => {
    const collection = createdCollections[createdCollections.length - 1];
    collection.set(Uri.file('c:/mod/parts/part.rules'), [{ message: 'from an earlier import' }]);
    return collection;
};

describe('importing the game log from a file the command cannot ask about', () => {
    beforeEach(() => {
        resetStub();
        window.activeTextEditor = { document: { uri: Uri.file('c:/mod/parts/part.rules') } };
    });

    it('leaves the findings already on screen when the file is in no mod', async () => {
        registerGameLog(context(), clientAnswering({ kind: 'no-mod' }) as never);
        const collection = collectionCarryingAFinding();
        await registeredCommands.get('cosmoteer.importGameLog')!();
        expect(collection.clears).toBe(0);
        expect(collection.entries.size).toBe(1);
    });

    it('leaves them alone when the game has written no log yet', async () => {
        registerGameLog(context(), clientAnswering({ kind: 'no-logs' }) as never);
        const collection = collectionCarryingAFinding();
        await registeredCommands.get('cosmoteer.importGameLog')!();
        expect(collection.clears).toBe(0);
        expect(collection.entries.size).toBe(1);
    });

    it('clears them for a run that did report on this mod, since they describe text that moved on', async () => {
        registerGameLog(context(), clientAnswering({ kind: 'loaded-clean', diagnostics: [], stale: 0 }) as never);
        const collection = collectionCarryingAFinding();
        await registeredCommands.get('cosmoteer.importGameLog')!();
        expect(collection.clears).toBe(1);
    });

    it('clears them for a run that said nothing about this mod', async () => {
        registerGameLog(context(), clientAnswering({ kind: 'nothing-for-this-mod' }) as never);
        const collection = collectionCarryingAFinding();
        await registeredCommands.get('cosmoteer.importGameLog')!();
        expect(collection.clears).toBe(1);
    });

    it('says so and keeps the panel when the log could not be read at all', async () => {
        await runImport(null);
        expect(createdCollections[createdCollections.length - 1].clears).toBe(0);
    });
});
