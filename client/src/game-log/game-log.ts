import * as path from 'path';
import {
    commands,
    Diagnostic,
    DiagnosticSeverity,
    ExtensionContext,
    l10n,
    languages,
    Range,
    Uri,
    window,
    workspace,
} from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { anchorUri } from '../wizards/wizard-client';

/**
 * What the game itself said about the mod the last time it loaded it, read out of the game's log and
 * shown in the Problems panel under a collection of its own.
 */

/**
 * The part of the server's game-log import result this side reads (see server
 * features/game-log/import-game-log.command.ts). Deliberately not shared: the server types each
 * finding as a protocol `Diagnostic`, and the editor's own `Diagnostic` is a different class that has
 * to be built by hand anyway, so all this side ever reads off one is its range, its severity and its
 * message. Sharing the server's type would pull the protocol's packages into the files both sides
 * read for no gain here.
 */
interface ImportGameLogResult {
    kind: 'imported' | 'loaded-clean' | 'run-failed' | 'no-mod' | 'no-logs' | 'nothing-for-this-mod';
    log?: { path: string; time: string; gameVersion?: string };
    unplaced?: Array<{ text: string; logLine: number }>;
    diagnostics: Array<{
        uri: string;
        diagnostic: {
            range: { start: { line: number; character: number }; end: { line: number; character: number } };
            severity?: number;
            message: string;
        };
    }>;
    stale: number;
}

/**
 * Tells the author that the run listed the mod and then reported a failure the editor could not
 * place, and offers to open the log where the failure stands. Saying which file it was about would
 * be a guess, so the log's own words are shown instead.
 *
 * @param result what the server read out of the log.
 */
async function showRunFailed(result: ImportGameLogResult): Promise<void> {
    const first = result.unplaced?.[0];
    const rest = (result.unplaced?.length ?? 0) - 1;
    const open = l10n.t('Open the log');
    const message = l10n.t(
        'The newest run that loaded this mod reported a failure the editor cannot place in a file: {0}{1}',
        first?.text ?? '',
        rest > 0 ? l10n.t(' and {0} more.', String(rest)) : ''
    );
    const log = result.log;
    if (!log) {
        window.showWarningMessage(message);
        return;
    }
    if ((await window.showWarningMessage(message, open)) !== open) return;
    const document = await workspace.openTextDocument(Uri.file(log.path));
    const line = Math.max((first?.logLine ?? 1) - 1, 0);
    await window.showTextDocument(document, { selection: new Range(line, 0, line, 0) });
}

/**
 * Registers the import command and the collection its findings go into.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the command runs through.
 */
export function registerGameLog(context: ExtensionContext, client: LanguageClient): void {
    // What the game itself said the last time it loaded this mod. Its own collection, never the
    // language server's: these findings are a recording of a past run, so nothing an edit does can
    // make them true again, and they have to be retractable on their own. Cleared when a file they
    // name is saved, since that is the moment the recording stops describing it.
    const gameLogDiagnostics = languages.createDiagnosticCollection('cosmoteer-game-log');
    context.subscriptions.push(gameLogDiagnostics);
    context.subscriptions.push(
        workspace.onDidSaveTextDocument((document) => {
            if (gameLogDiagnostics.get(document.uri)?.length) gameLogDiagnostics.delete(document.uri);
        })
    );
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.importGameLog', async () => {
            const uri = anchorUri();
            if (!uri) {
                window.showInformationMessage(l10n.t('Cosmoteer: open a file of the mod first.'));
                return;
            }
            const result = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.readGameLog',
                arguments: [{ uri }],
            })) as ImportGameLogResult | null;
            if (!result) {
                window.showErrorMessage(l10n.t('The game log could not be read.'));
                return;
            }
            // The two outcomes where the command could not even ask the question leave what an
            // earlier import put on screen alone: running it from a note or a file outside the mod
            // is a slip, and emptying the panel over it throws away work the author is in the
            // middle of. Every other outcome is a newer word on this mod's files, and the old
            // findings describe text that has moved on, so those still clear first.
            if (result.kind === 'no-mod') {
                window.showInformationMessage(
                    l10n.t('This file is not inside a mod: no mod.rules was found above it.')
                );
                return;
            }
            if (result.kind === 'no-logs') {
                window.showInformationMessage(
                    l10n.t('Cosmoteer has written no logs yet. Run the game once, then try again.')
                );
                return;
            }
            gameLogDiagnostics.clear();
            if (result.kind === 'loaded-clean') {
                window.showInformationMessage(
                    l10n.t(
                        'The newest run that loaded this mod reported nothing about its files ({0}).',
                        result.log ? path.basename(result.log.path) : ''
                    )
                );
                return;
            }
            if (result.kind === 'run-failed') {
                await showRunFailed(result);
                return;
            }
            if (result.kind === 'nothing-for-this-mod') {
                window.showInformationMessage(
                    l10n.t('No game log mentions this mod. The game reports a mod only while it loads it.')
                );
                return;
            }
            const byUri = new Map<string, Diagnostic[]>();
            for (const entry of result.diagnostics) {
                const range = new Range(
                    entry.diagnostic.range.start.line,
                    entry.diagnostic.range.start.character,
                    entry.diagnostic.range.end.line,
                    entry.diagnostic.range.end.character
                );
                const diagnostic = new Diagnostic(
                    range,
                    entry.diagnostic.message,
                    // The protocol counts severities from one, the editor from zero.
                    ((entry.diagnostic.severity ?? 1) - 1) as DiagnosticSeverity
                );
                diagnostic.source = 'cosmoteer-game-log';
                const existing = byUri.get(entry.uri);
                if (existing) existing.push(diagnostic);
                else byUri.set(entry.uri, [diagnostic]);
            }
            for (const [uriText, diagnostics] of byUri) gameLogDiagnostics.set(Uri.parse(uriText), diagnostics);
            const parts = [
                l10n.t('{0} findings from the run of {1}', String(result.diagnostics.length), result.log?.time ?? '?'),
            ];
            // A log outlives the files it describes, so anything that no longer fits is counted
            // rather than moved to a line that happens to exist.
            if (result.stale > 0) {
                parts.push(l10n.t('{0} no longer fit the files and were left out', String(result.stale)));
            }
            window.showInformationMessage(`${parts.join(', ')}.`);
        })
    );
}
