import { commands, ExtensionContext, l10n, Uri, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';

/**
 * A whole new mod. The server writes the manifest and the language file, and this side asks where
 * the mod goes, what it is called and who wrote it.
 */

/**
 * The palette command that creates a whole mod. Like the content command it is a distinct id from
 * the server's `cosmoteer.newMod`, since where the mod goes and what it is called are questions only
 * the editor can ask.
 */
export const NEW_MOD_LOCAL_COMMAND = 'cosmoteer.newMod.create';

/** Mirror of one folder the server offers to create a mod in. */
interface NewModDestination {
    path: string;
    loadedByGame: boolean;
}

/** Mirror of the server's new-mod scan round (see server features/refactor/new-mod). */
interface NewModScanResult {
    kind: 'scan';
    destinations: NewModDestination[];
    gameVersions: string;
    knownAuthors: string[];
}

/** Mirror of the server's new-mod apply round. */
interface NewModApplyResult {
    kind: 'apply';
    modRoot: string;
    manifest: string;
    id: string;
    createdFiles: string[];
    loadedByGame: boolean;
    failure?: NewModFailure;
}

/** Mirror of why the server created no mod. */
type NewModFailure = 'noDestination' | 'invalidName' | 'invalidAuthor' | 'pathTaken' | 'idTaken' | 'writeFailed';

/**
 * Create a whole mod: ask where it goes, what it is called and who wrote it, let the server write
 * the manifest and the language file, then open the manifest and offer to open the mod itself.
 *
 * The folders the game loads mods from are offered first, since a mod written anywhere else has to
 * be linked into one of them before the game sees it at all.
 *
 * @param client the language client the command runs through.
 */
export async function createNewMod(client: LanguageClient): Promise<void> {
    const scan = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.newMod',
        arguments: [{}],
    })) as NewModScanResult | null;
    if (!scan) {
        window.showWarningMessage(l10n.t('Cosmoteer: the mod folders could not be read, so nothing was created.'));
        return;
    }
    const destination = await pickNewModDestination(scan);
    if (!destination) return;
    const name = await window.showInputBox({
        title: l10n.t('Cosmoteer: New Mod'),
        prompt: l10n.t('Name your mod. The folder and the mod id are derived from this.'),
        validateInput: (value) =>
            /^[A-Za-z][A-Za-z0-9 _-]*$/.test(value.trim())
                ? undefined
                : l10n.t('Use letters, digits, spaces, underscores and dashes, starting with a letter.'),
    });
    if (!name) return;
    const author = await window.showInputBox({
        title: l10n.t('Cosmoteer: New Mod'),
        prompt: l10n.t('Your name as the game shows it. It also becomes the first half of the mod id.'),
        value: scan.knownAuthors[0],
        validateInput: (value) =>
            /[A-Za-z0-9]/.test(value) ? undefined : l10n.t('Use at least one letter or digit.'),
    });
    if (!author) return;

    const result = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.newMod',
        arguments: [{ destination, name, author }],
    })) as NewModApplyResult | null;
    if (!result) {
        window.showWarningMessage(l10n.t('Cosmoteer: nothing was created.'));
        return;
    }
    if (result.failure) {
        window.showWarningMessage(newModFailureMessage(result.failure));
        return;
    }
    const document = await workspace.openTextDocument(Uri.file(result.manifest));
    await window.showTextDocument(document, { preview: false });
    const openIt = l10n.t('Open the mod folder');
    const notes = [l10n.t('Cosmoteer: created {0} as {1}.', result.modRoot, result.id)];
    notes.push(
        result.loadedByGame
            ? l10n.t('The game reads mods from that folder, so it will find this one.')
            : l10n.t('The game does not read mods from that folder. Cosmoteer: Run in Cosmoteer links it in for you.')
    );
    notes.push(l10n.t('Cosmoteer: New Content File adds your first part and the action that loads it.'));
    const picked = await window.showInformationMessage(notes.join(' '), openIt);
    if (picked === openIt) await commands.executeCommand('vscode.openFolder', Uri.file(result.modRoot), true);
}

/**
 * Offer the folders the game loads mods from, plus picking any folder by hand.
 *
 * @param scan the server's report.
 * @returns the chosen folder, or undefined when the author backed out.
 */
async function pickNewModDestination(scan: NewModScanResult): Promise<string | undefined> {
    const BROWSE = '__browse__';
    const items = [
        ...scan.destinations.map((destination) => ({
            label: destination.path,
            description: l10n.t('The game loads mods from here'),
            path: destination.path,
        })),
        ...(workspace.workspaceFolders ?? []).map((folder) => ({
            label: folder.uri.fsPath,
            description: l10n.t('This workspace folder'),
            path: folder.uri.fsPath,
        })),
        { label: l10n.t('Choose a folder…'), description: '', path: BROWSE },
    ];
    const picked = await window.showQuickPick(items, { placeHolder: l10n.t('Where should the mod folder be created?') });
    if (!picked) return undefined;
    if (picked.path !== BROWSE) return picked.path;
    const chosen = await window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: l10n.t('Create the mod here'),
    });
    return chosen?.[0]?.fsPath;
}

/**
 * Say why no mod was created, one message per reason the server reports.
 *
 * @param failure the server's reason.
 * @returns the message to show.
 */
function newModFailureMessage(failure: NewModFailure): string {
    switch (failure) {
        case 'noDestination':
            return l10n.t('Cosmoteer: that folder is not there, so nothing was created.');
        case 'invalidName':
            return l10n.t('Cosmoteer: that name leaves no folder name behind. Use letters and digits.');
        case 'invalidAuthor':
            return l10n.t('Cosmoteer: that author name leaves nothing for the mod id. Use letters and digits.');
        case 'pathTaken':
            return l10n.t('Cosmoteer: a folder of that name is already there, and it was left alone.');
        case 'idTaken':
            return l10n.t('Cosmoteer: another mod on this machine already carries that id, and the game tells mods apart by it.');
        case 'writeFailed':
            return l10n.t('Cosmoteer: the mod folder could not be written, so nothing was created.');
    }
}

/**
 * Registers the palette command. The New menu calls {@link createNewMod} directly.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the command runs through.
 */
export function registerNewMod(context: ExtensionContext, client: LanguageClient): void {
    // Creating the mod itself is the step before that one: the server writes the manifest and the
    // language file, and this wrapper asks where the mod goes, what it is called and who wrote it.
    context.subscriptions.push(
        commands.registerCommand(NEW_MOD_LOCAL_COMMAND, async () => {
            await createNewMod(client);
        })
    );
}
