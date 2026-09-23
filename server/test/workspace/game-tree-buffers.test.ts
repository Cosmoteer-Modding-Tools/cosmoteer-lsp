import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import type { Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { ParserResultRegistrar } from '../../src/document/parser-result-registrar';
import { globalSettings } from '../../src/settings';
import { normalizeUri } from '../../src/document/reference-location';
import { CosmoteerWorkspaceService } from '../../src/workspace/cosmoteer-workspace.service';
import { documentsMentioning } from '../../src/workspace/workspace-files';

// Several checks read the game `Data` tree to decide what the base game itself carries: an id
// vanilla references without declaring, a field name vanilla writes. The mention walk yielded every
// registered buffer first, so an unsaved buffer over a vanilla file counted as shipped game content
// and answered those questions for the whole install. The verdicts are memoized per session, so one
// such buffer silenced an id in every mod file until the server restarted, closing the buffer
// included. The game reads its own tree from disk, and so does the walk now.

const progress: WorkDoneProgressReporter = {
    begin: () => undefined,
    report: () => undefined,
    done: () => undefined,
};

const connection = {
    window: { showWarningMessage: () => Promise.resolve(undefined) },
    languages: { diagnostics: { refresh: () => undefined } },
} as unknown as Connection;

/** A word no file on disk writes, so only a buffer can bring it into an answer. */
const MARKER = 'ZzUnsavedMarker';

let root: string;
let dataRoot: string;
let modRoot: string;

/**
 * Registers a parsed buffer for a file, the way an open editor does, with text of its own.
 *
 * @param file the file the buffer stands for.
 * @param text the buffer's text.
 * @returns nothing.
 */
const registerBuffer = (file: string, text: string): void => {
    ParserResultRegistrar.instance.setResult(pathToFileURL(file).href, parser(lexer(text), file).value);
};

/**
 * The uris the walk answers with.
 *
 * @param folders the folders to search.
 * @returns the yielded documents, keyed the spelling-independent way.
 */
const mentioning = async (folders: string[]): Promise<string[]> => {
    const found: string[] = [];
    for await (const document of documentsMentioning(folders, MARKER, CancellationToken.None)) {
        found.push(normalizeUri(document.uri));
    }
    return found;
};

describe('a buffer over a game Data file in the mention walk', () => {
    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), 'cosmoteer-gametree-'));
        dataRoot = join(root, 'install', 'Data');
        modRoot = join(root, 'mod');
        mkdirSync(join(dataRoot, 'parts'), { recursive: true });
        mkdirSync(modRoot, { recursive: true });
        // Neither file writes the marker on disk. Only the buffers below do.
        writeFileSync(join(dataRoot, 'parts', 'vanilla.rules'), 'Vanilla {\n    VALUE = 1\n}\n');
        writeFileSync(join(modRoot, 'mine.rules'), 'Mine {\n    VALUE = 1\n}\n');
        CosmoteerWorkspaceService.instance.setConnection(connection);
        await CosmoteerWorkspaceService.instance.initialize(dataRoot, progress);
    });

    afterAll(() => {
        ParserResultRegistrar.instance.clear();
        globalSettings.allowEditingVanillaFiles = false;
        rmSync(root, { recursive: true, force: true });
    });

    beforeEach(() => {
        ParserResultRegistrar.instance.clear();
        globalSettings.allowEditingVanillaFiles = false;
    });

    it('is read from disk, so it cannot answer for the whole install', async () => {
        registerBuffer(join(dataRoot, 'parts', 'vanilla.rules'), `Vanilla {\n    VALUE = ${MARKER}\n}\n`);
        expect(await mentioning([pathToFileURL(dataRoot).href])).toEqual([]);
    });

    it('still stands in for its file once the vanilla files are declared editable', async () => {
        globalSettings.allowEditingVanillaFiles = true;
        registerBuffer(join(dataRoot, 'parts', 'vanilla.rules'), `Vanilla {\n    VALUE = ${MARKER}\n}\n`);
        expect(await mentioning([pathToFileURL(dataRoot).href])).toEqual([
            normalizeUri(join(dataRoot, 'parts', 'vanilla.rules')),
        ]);
    });

    it('leaves a buffer outside the game tree standing in for its file', async () => {
        registerBuffer(join(modRoot, 'mine.rules'), `Mine {\n    VALUE = ${MARKER}\n}\n`);
        expect(await mentioning([pathToFileURL(modRoot).href])).toEqual([normalizeUri(join(modRoot, 'mine.rules'))]);
    });
});
