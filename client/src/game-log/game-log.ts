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

/** Mirror of the server's game-log import result (see server features/game-log/import-game-log.command.ts). */
interface ImportGameLogResult {
    kind: 'imported' | 'loaded-clean' | 'no-mod' | 'no-logs' | 'nothing-for-this-mod';
    log?: { path: string; time: string; gameVersion?: string };
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
            gameLogDiagnostics.clear();
            if (result.kind === 'no-mod') {
                window.showInformationMessage(l10n.t('This file is not inside a mod: no mod.rules was found above it.'));
                return;
            }
            if (result.kind === 'no-logs') {
                window.showInformationMessage(l10n.t('Cosmoteer has written no logs yet. Run the game once, then try again.'));
                return;
            }
            if (result.kind === 'loaded-clean') {
                window.showInformationMessage(
                    l10n.t(
                        'The newest run that loaded this mod reported nothing about its files ({0}).',
                        result.log ? path.basename(result.log.path) : ''
                    )
                );
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
                    (entry.diagnostic.severity ?? 1) - 1 as DiagnosticSeverity
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
