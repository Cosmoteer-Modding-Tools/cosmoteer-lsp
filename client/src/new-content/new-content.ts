import { commands, ExtensionContext, l10n, Uri, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { openDocumentPaths, saveAndTidy } from '../shared-base/apply-cleanup';
import { wizardAnchor } from '../wizards/wizard-client';

/**
 * A new content file, written and wired into the game in one step, because a file nothing registers
 * is a file the game never loads. The server writes and registers it, and this side asks what to
 * create, what to call it and where to register it.
 */

/**
 * The palette command that creates a new content file. A distinct id from the server's own
 * `cosmoteer.newContent`, because the language client auto-registers that one as a plain
 * no-feedback forwarder and the questions have to be asked here.
 */
export const NEW_CONTENT_LOCAL_COMMAND = 'cosmoteer.newContentFile';

/**
 * Mirror of the server's content kinds (see server
 * features/refactor/new-content/new-content.types.ts).
 */
export type ContentKind =
    | 'part'
    | 'resource'
    | 'bullet'
    | 'mediaEffect'
    | 'logoShip'
    | 'decalFolder'
    | 'editorGroup'
    | 'partStat'
    | 'partToggle'
    | 'buff'
    | 'codexPage';

/** Mirror of what one content kind would do in the mod. */
interface ContentKindInfo {
    kind: ContentKind;
    folder: string;
    registration: 'ship' | 'manifest' | 'none';
    pointedAtBy?: string;
    blocked?: string;
}

/** Mirror of a ship class a new part could be registered in. */
interface NewContentShip {
    key: string;
    groupName: string;
    id?: string;
    fsPath: string;
    target: 'workspace' | 'vanilla';
    via: 'shipFile' | 'modAction';
    blocked?: string;
}

/** Mirror of the server's scan round. */
interface NewContentScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    idPrefix: string;
    kinds: ContentKindInfo[];
    ships: NewContentShip[];
    failure?: NewContentFailure;
}

/** Mirror of the server's apply round. */
interface NewContentApplyResult {
    kind: 'apply';
    created: string;
    contentKind: ContentKind;
    id: string;
    route: 'ship' | 'manifest' | 'none';
    registeredIn: string;
    registrationFailure?: string;
    manifests?: string[];
    changedFiles: string[];
    localizationKeys: string[];
    localizationFiles: string[];
    reference: string;
    pointedAtBy?: string;
    usage?: string;
    placeholderAssets: string[];
    previousLogo?: string;
    failure?: NewContentFailure;
}

/** Mirror of why the server created nothing at all. */
type NewContentFailure =
    'noModRoot' | 'notEditable' | 'unknownKind' | 'invalidName' | 'pathTaken' | 'idTaken' | 'writeFailed';

/**
 * Create a new content file: ask what to create, what to call it and where to register it, then let
 * the server write it, wire it in and add its localization keys.
 *
 * @param client the language client the command runs through.
 */
export async function createNewContent(
    client: LanguageClient,
    preset: { uri?: string; kind?: ContentKind } = {}
): Promise<void> {
    const uri = wizardAnchor(preset.uri);
    if (!uri) return;
    const scan = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.newContent',
        arguments: [{ uri }],
    })) as NewContentScanResult | null;
    if (!scan || scan.failure) {
        window.showWarningMessage(
            scan?.failure
                ? newContentFailureMessage(scan.failure)
                : l10n.t('Cosmoteer: the mod could not be read, so nothing was created.')
        );
        return;
    }
    // A kind chosen from the New menu skips the picker, the way a named entry there would.
    const kind = preset.kind
        ? scan.kinds.find((candidate) => candidate.kind === preset.kind)
        : await pickContentKind(scan);
    if (!kind) return;
    const name = await window.showInputBox({
        title: l10n.t('Cosmoteer: New Content File'),
        prompt:
            kind.kind === 'resource' || !scan.idPrefix
                ? l10n.t('Name it. The file, its folder and its id are derived from this.')
                : l10n.t('Name it. The file, its folder and the id {0}.<name> are derived from this.', scan.idPrefix),
        validateInput: (value) =>
            /^[A-Za-z][A-Za-z0-9 _-]*$/.test(value.trim())
                ? undefined
                : l10n.t('Use letters, digits, spaces, underscores and dashes, starting with a letter.'),
    });
    if (!name) return;

    let ship: NewContentShip | 'skip' | undefined;
    if (kind.registration === 'ship') {
        ship = await pickNewContentShip(scan.ships);
        if (!ship) return;
    }
    // The title screen ship is a saved ship the author already has, copied in rather than written
    // from a template, so this kind asks for the file.
    let source: string | undefined;
    if (kind.kind === 'logoShip') {
        const picked = await window.showOpenDialog({
            canSelectMany: false,
            filters: { [l10n.t('Saved ship')]: ['png'] },
            openLabel: l10n.t('Use on the title screen'),
        });
        source = picked?.[0]?.fsPath;
        if (!source) return;
    }
    // Captured before the write, so the tidy-up can tell the tabs the author had from the ones the
    // registration opened on its own.
    const openBefore = openDocumentPaths();
    const result = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.newContent',
        arguments: [
            {
                uri,
                kind: kind.kind,
                name,
                ship: ship && ship !== 'skip' ? ship.key : undefined,
                skipRegistration: ship === 'skip',
                source,
            },
        ],
    })) as NewContentApplyResult | null;
    if (!result) {
        window.showWarningMessage(l10n.t('Cosmoteer: nothing was created.'));
        return;
    }
    if (result.failure) {
        window.showWarningMessage(newContentFailureMessage(result.failure));
        return;
    }
    await saveAndTidy(result.changedFiles, openBefore);
    const document = await workspace.openTextDocument(Uri.file(result.created));
    await window.showTextDocument(document, { preview: false });
    await showNewContentSummary(result);
}

/**
 * Offer the content kinds, each saying where it goes and what will wire it in.
 *
 * @param scan the server's report for this mod.
 * @returns the picked kind, or undefined when the author backed out.
 */
async function pickContentKind(scan: NewContentScanResult): Promise<ContentKindInfo | undefined> {
    const labels: Record<ContentKind, string> = {
        part: l10n.t('Part'),
        resource: l10n.t('Resource'),
        bullet: l10n.t('Shot'),
        mediaEffect: l10n.t('Media effect'),
        logoShip: l10n.t('Title screen ship'),
        decalFolder: l10n.t('Roof decal folder'),
        editorGroup: l10n.t('Build toolbar category'),
        partStat: l10n.t('Part stat line'),
        partToggle: l10n.t('Part toggle'),
        buff: l10n.t('Buff'),
        codexPage: l10n.t('Codex page'),
    };
    const picked = await window.showQuickPick(
        scan.kinds.map((info) => ({
            label: labels[info.kind],
            description: `${info.folder}/`,
            detail:
                info.pointedAtBy ??
                (info.blocked
                    ? l10n.t('Cannot be registered in this mod, so it will be created unwired')
                    : info.registration === 'ship'
                      ? l10n.t('Registered in a ship class you pick')
                      : l10n.t("Registered with an action in this mod's mod.rules")),
            info,
        })),
        { placeHolder: l10n.t('Pick what to create in {0}', scan.modId || workspace.asRelativePath(scan.modRoot)) }
    );
    return picked?.info;
}

/**
 * Offer the ship classes a new part could be registered in, plus the honest option of creating it
 * unregistered.
 *
 * @param ships the ship classes the server reported, in registry order.
 * @returns the picked ship, `skip` to create it unwired, or undefined when the author backed out.
 */
async function pickNewContentShip(ships: NewContentShip[]): Promise<NewContentShip | 'skip' | undefined> {
    const open = ships.filter((ship) => !ship.blocked);
    const items = [
        ...open.map((ship) => ({
            label: ship.id ?? ship.groupName,
            description: workspace.asRelativePath(ship.fsPath),
            detail:
                ship.via === 'modAction'
                    ? l10n.t("Patched in from this mod's manifest, so the game files stay untouched")
                    : l10n.t("Appended to this ship's own Parts list"),
            ship: ship as NewContentShip | undefined,
        })),
        {
            label: l10n.t('Do not register it yet'),
            description: '',
            detail: l10n.t('The file is created, and nothing will load it until a ship lists it'),
            ship: undefined as NewContentShip | undefined,
        },
    ];
    const picked = await window.showQuickPick(items, {
        placeHolder: l10n.t('Pick the ship class this part belongs to'),
        matchOnDescription: true,
    });
    if (!picked) return undefined;
    return picked.ship ?? 'skip';
}

/**
 * Say what was created and what still has to happen, which for a shot or a media effect is the whole
 * point: nothing in the game registers those, so the reference to paste is the answer.
 *
 * @param result the server's summary.
 */
async function showNewContentSummary(result: NewContentApplyResult): Promise<void> {
    const notes: string[] = [];
    if (result.route === 'none') {
        notes.push(result.pointedAtBy ?? l10n.t('Nothing references this file yet.'));
        notes.push(l10n.t('The reference to use is {0}.', result.reference));
    } else if (result.registrationFailure) {
        notes.push(newContentRegistrationMessage(result.registrationFailure, result.manifests));
        notes.push(l10n.t('The reference to use is {0}.', result.reference));
    } else {
        notes.push(l10n.t('Registered in {0}.', workspace.asRelativePath(result.registeredIn)));
    }
    if (result.usage) notes.push(result.usage);
    if (result.previousLogo) {
        notes.push(
            l10n.t(
                'The title screen showed {0} before. That action now points at the new ship, and the old file stays where it is.',
                result.previousLogo
            )
        );
    }
    if (result.localizationKeys.length > 0 && result.localizationFiles.length === 0) {
        notes.push(
            l10n.t(
                'This mod ships no language file, so {0} was not declared anywhere and the game will show no name.',
                result.localizationKeys[0]
            )
        );
    }
    if (result.placeholderAssets.length > 0) {
        notes.push(
            l10n.t(
                'It points at {0} for now, which is a file of the game you can replace with your own.',
                result.placeholderAssets[0]
            )
        );
    }
    window.showInformationMessage(
        [l10n.t('Cosmoteer: created {0}.', workspace.asRelativePath(result.created)), ...notes].join(' ')
    );
}

/**
 * Say why nothing was created, one message per reason the server reports.
 *
 * @param failure the server's reason.
 * @returns the message to show.
 */
function newContentFailureMessage(failure: NewContentFailure): string {
    switch (failure) {
        case 'noModRoot':
            return l10n.t('Cosmoteer: this folder is in no mod. Open a mod with a mod.rules manifest first.');
        case 'notEditable':
            return l10n.t(
                "Cosmoteer: this is the game's own data or somebody else's installed mod, which is not yours to add to."
            );
        case 'unknownKind':
            return l10n.t('Cosmoteer: that kind of content is not one this version can create.');
        case 'invalidName':
            return l10n.t(
                'Cosmoteer: that name leaves nothing usable behind. Use letters and digits, starting with a letter.'
            );
        case 'pathTaken':
            return l10n.t('Cosmoteer: a file or folder of that name is already there, so nothing was created.');
        case 'idTaken':
            return l10n.t(
                'Cosmoteer: that id is already declared, and two files with one id means the game keeps only one of them.'
            );
        case 'writeFailed':
            return l10n.t('Cosmoteer: the file could not be written, so nothing was created.');
    }
}

/**
 * Say why a created file was not wired in, which never stops the file from being created.
 *
 * @param failure the server's reason.
 * @param manifests the manifest names to choose between, only for `ambiguousManifest`.
 * @returns the message to show.
 */
function newContentRegistrationMessage(failure: string, manifests?: string[]): string {
    switch (failure) {
        case 'noShipChosen':
            return l10n.t('Nothing registers it yet, so no ship will build it until one lists it.');
        case 'alreadyRegistered':
            return l10n.t('It was already registered, so nothing was added twice.');
        case 'ambiguousManifest':
            return l10n.t(
                'This mod has several manifests and none of them is mod.rules, so which one gets it is yours to decide. Candidates: {0}.',
                (manifests ?? []).join(', ')
            );
        case 'manifestUnusable':
            return l10n.t(
                "This mod's Actions come from an included file, which cannot be appended to, so the action is yours to add."
            );
        case 'noGameRoot':
            return l10n.t('The Cosmoteer game path is unset, so where the registry lives could not be read.');
        case 'partsInherited':
            return l10n.t('That ship gets its Parts list from a base file, which is not rewritten.');
        case 'noPartsList':
            return l10n.t('That ship declares no Parts list to add to.');
        case 'editRejected':
            return l10n.t('The editor turned the registration down, so the file is not wired in yet.');
        default:
            return l10n.t('It could not be registered, so nothing loads it yet.');
    }
}

/**
 * Registers the palette command. The New menu calls {@link createNewContent} directly with the kind
 * it was opened on.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the command runs through.
 */
export function registerNewContent(context: ExtensionContext, client: LanguageClient): void {
    // Creating a piece of content and wiring it into the game are one step, because a file nothing
    // registers is a file the game never loads and the editor never types. The server writes and
    // registers. This wrapper only asks the questions a tool cannot answer for the author.
    context.subscriptions.push(
        commands.registerCommand(NEW_CONTENT_LOCAL_COMMAND, async () => {
            await createNewContent(client);
        })
    );
}
