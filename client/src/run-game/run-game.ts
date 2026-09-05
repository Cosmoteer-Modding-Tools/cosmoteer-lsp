import { commands, ExtensionContext, l10n, window } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { anchorUri } from '../wizards/wizard-client';

/**
 * Starting the game with the mod enabled. The server links the mod in, switches it on and starts the
 * game, and this side asks the one question it cannot answer, which user folder the game uses, and
 * puts every refusal into a sentence of its own.
 */

/** Mirror of the server's run-in-game result (see server features/run-game/run-game.command.ts). */
type RunGameResult =
    | { kind: 'started'; modFolder: string; linked: boolean; enabled: boolean; backup?: string; compatible: boolean }
    | { kind: 'choose-user-data'; candidates: string[] }
    | { kind: 'refused'; reason: string; detail?: string };

/**
 * The sentence for each reason the run refused. Every one of them is a state the flow will not
 * guess its way through, since it writes into the user's own game settings and mods folder.
 *
 * @param reason the reason the server answered with.
 * @param detail the path or message it named, when it named one.
 * @returns the message to show.
 */
function runGameRefusalMessage(reason: string, detail?: string): string {
    switch (reason) {
        case 'unsupported-platform':
            return l10n.t('Cosmoteer ships no macOS build, so it cannot be started from here.');
        case 'no-install':
            return l10n.t('No Cosmoteer install was found. Set "cosmoteerLSPRules.cosmoteerPath" to its Data folder.');
        case 'no-executable':
            return l10n.t('The Cosmoteer executable is missing at {0}.', detail ?? '');
        case 'no-mod':
            return l10n.t('This file is not inside a mod: no mod.rules was found above it.');
        case 'no-user-data':
            return l10n.t('Cosmoteer has no user folder yet. Start the game once, then try again.');
        case 'no-settings-file':
            return l10n.t('Cosmoteer has never written its settings file at {0}, so there is nothing to enable the mod in.', detail ?? '');
        case 'game-running':
            return l10n.t('Cosmoteer is running. It rewrites its settings when it exits, so close it first.');
        case 'duplicate-mod-enabled':
            return l10n.t(
                'Another copy of this mod is already enabled at {0}. Cosmoteer loads no mod id twice and stops with an error, so turn that copy off in its mod list or unsubscribe it first.',
                detail ?? ''
            );
        case 'link-name-taken':
            return l10n.t('{0} already exists and is not a link to this mod. Rename one of them first.', detail ?? '');
        case 'link-failed':
            return l10n.t('The mod could not be linked into your Mods folder: {0}', detail ?? '');
        case 'settings-unparseable':
            return l10n.t("Cosmoteer's settings file could not be read, so it was left untouched.");
        case 'settings-no-game-settings':
        case 'settings-no-enabled-mods':
            return l10n.t("Cosmoteer's settings file has no enabled-mods list, so it was left untouched.");
        case 'settings-not-equivalent':
        case 'settings-bad-entry':
            return l10n.t('The change to the settings file did not come out as expected, so nothing was written.');
        case 'settings-write-failed':
            return l10n.t('The settings file could not be written: {0}', detail ?? '');
        default:
            return l10n.t('Cosmoteer could not be started.');
    }
}

/**
 * Registers the run command.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the command runs through.
 */
export function registerRunGame(context: ExtensionContext, client: LanguageClient): void {
    // Run the mod: the server links the workspace into the folder the game loads mods from, switches
    // it on in the game's own settings and starts the game in developer mode. Everything that can go
    // wrong comes back as a named reason rather than a thrown error, since the flow writes into the
    // user's game settings and each refusal needs its own sentence. A distinct command id from the
    // server's executeCommand id, for the same reason as the migration above.
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.runInGame', async () => {
            const uri = anchorUri();
            if (!uri) {
                window.showInformationMessage(l10n.t('Cosmoteer: open a file of the mod first.'));
                return;
            }
            const run = async (userDataFolder?: string): Promise<RunGameResult | null> =>
                (await client.sendRequest(ExecuteCommandRequest.type, {
                    command: 'cosmoteer.runInCosmoteer',
                    arguments: [{ uri, userDataFolder }],
                })) as RunGameResult | null;

            let result = await run();
            if (result?.kind === 'choose-user-data') {
                // Which folder the game uses depends on the Steam account it is signed into, which
                // the server cannot read, so the user picks.
                const chosen = await window.showQuickPick(result.candidates.slice(), {
                    placeHolder: l10n.t('Which Cosmoteer user folder does the game use?'),
                });
                if (!chosen) return;
                result = await run(chosen);
            }
            if (!result) {
                window.showErrorMessage(l10n.t('Cosmoteer could not be started.'));
                return;
            }
            if (result.kind === 'refused') {
                window.showErrorMessage(runGameRefusalMessage(result.reason, result.detail));
                return;
            }
            if (result.kind !== 'started') return;
            window.showInformationMessage(
                result.linked
                    ? l10n.t('Starting Cosmoteer. The mod is linked into your Mods folder as {0}.', result.modFolder)
                    : l10n.t('Starting Cosmoteer with the mod enabled.')
            );
            if (!result.compatible) {
                window.showWarningMessage(
                    l10n.t(
                        "The mod's CompatibleGameVersions names no game version this build accepts, so the game will turn it off again while loading."
                    )
                );
            }
        })
    );
}
