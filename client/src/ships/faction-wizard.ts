import { commands, ExtensionContext, l10n, QuickPickItem, Uri, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { showNewFactionForm } from './new-faction-form';
import { openDocumentPaths, saveAndTidy } from '../shared-base/apply-cleanup';
import { anchorUri, applyForWizard, scanForWizard, wizardAnchor } from '../wizards/wizard-client';
import {
    NewFactionApplyResult,
    NewFactionScanResult,
    RegisterShipApplyResult,
    RegisterShipScanResult,
    ScannedShip,
    ShipChoice,
    ShipDifficulty,
    ShipRole,
} from './faction-wizard.types';

/**
 * Putting saved ships into a faction, and creating the faction to put them in.
 *
 * The server reads the blueprints, rates each one the way the game does and says what it is; this
 * wrapper asks the two questions only the author can answer, which faction and whether the
 * suggestions stand, and registers everything in one go. A ship goes in with a tier the game's own
 * arithmetic gives it, a difficulty read against the game's own ships and a role read off its parts,
 * so the ordinary case is one pick of a faction and one confirmation.
 */

/** The palette command that registers saved ships, distinct from the server's own command id. */
export const ADD_SHIP_TO_FACTION_COMMAND = 'cosmoteer.addShipToFaction';

/** The palette command that creates a faction, distinct from the server's own command id. */
export const NEW_FACTION_LOCAL_COMMAND = 'cosmoteer.newFaction.create';

/** The server commands the two wrappers run. */
const REGISTER_SHIP_SERVER_COMMAND = 'cosmoteer.registerShip';
const NEW_FACTION_SERVER_COMMAND = 'cosmoteer.newFaction';

/** The roles, as the picker names them. */
const roleLabel = (role: ShipRole): string => {
    switch (role) {
        case 'combat':
            return l10n.t('Combat ship');
        case 'trade':
            return l10n.t('Trade ship');
        case 'crew_transport':
            return l10n.t('Crew transport');
        case 'defense':
            return l10n.t('Defense platform');
        case 'trade_station':
            return l10n.t('Trade station');
        case 'military_station':
            return l10n.t('Military station');
        case 'wreckage':
            return l10n.t('Wreckage');
        case 'starter':
            return l10n.t('Starter ship');
        case 'storage_pod':
            return l10n.t('Storage pod');
    }
};

/** One sentence on why a role was suggested. */
const roleReason = (ship: ScannedShip, role: ShipRole): string => {
    const { signals } = ship;
    switch (role) {
        case 'combat':
            return l10n.t('{0} weapons and {1} thrusters', String(signals.weapons), String(signals.thrusters));
        case 'trade':
            return l10n.t('{0} storage parts and {1} weapons', String(signals.storage), String(signals.weapons));
        case 'crew_transport':
            return l10n.t('houses {0} crew', String(signals.crew));
        case 'defense':
            return l10n.t('armed and named as a platform');
        case 'trade_station':
        case 'military_station':
            return signals.thrusters === 0 ? l10n.t('no thrusters') : l10n.t('too few thrusters for its size to fly');
        case 'wreckage':
            return l10n.t('a derelict for the debris fields, belonging to no faction');
        case 'starter':
            return l10n.t('offered when a new career begins, belonging to no faction');
        case 'storage_pod':
            return l10n.t('dropped beside wrecks and handed out as loot, belonging to no faction');
    }
};

/** The difficulty bands, as the picker names them. */
const difficultyLabel = (difficulty: ShipDifficulty): string => {
    switch (difficulty) {
        case 1:
            return l10n.t("1 · Easy: fewer weapons and less armor than the game's ships of its tier");
        case 2:
            return l10n.t("2 · Average: armed and armored like the game's ships of its tier");
        case 3:
            return l10n.t("3 · Hard: more weapons and armor than the game's ships of its tier");
    }
};

/** The one word a difficulty band means, for the lines that quote the number. */
const difficultyWord = (difficulty: ShipDifficulty): string => {
    switch (difficulty) {
        case 1:
            return l10n.t('easy');
        case 2:
            return l10n.t('average');
        case 3:
            return l10n.t('hard');
    }
};

/**
 * What the difficulty was read from, in one sentence: the ship's weapon and armor shares next to
 * what the game's own ships of that tier spend.
 *
 * @param ship the scanned ship.
 * @returns the sentence.
 */
const difficultyReason = (ship: ScannedShip): string =>
    l10n.t(
        "Weapons take {0} of its value and armor {1}, where the game's tier {2} ships spend {3} and {4}, so it rates {5}.",
        percent(ship.strength.weaponShare),
        percent(ship.strength.armorShare),
        String(ship.valueTier),
        percent(ship.strength.typicalWeaponShare),
        percent(ship.strength.typicalArmorShare),
        difficultyWord(ship.difficulty)
    );

/** The legend the review carries, saying what tier and difficulty mean. */
const ratingLegend = (): string =>
    l10n.t(
        'Tier is the danger level of the star systems the ship spawns in, 1 to 18. Difficulty rates how hard it is for that tier, 1 easy, 2 average, 3 hard.'
    );

/** A percentage with no decimals, for the reason lines. */
const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** A credit figure with thousands separators, for the reason lines. */
const credits = (value: number): string => Math.round(value).toLocaleString();

/**
 * The line under a ship in the review: its value, the tier it lands on and why the difficulty is
 * what it is.
 *
 * @param ship the scanned ship.
 * @param role the role it is going in as.
 * @returns the detail line.
 */
const shipDetail = (ship: ScannedShip, role: ShipRole): string => {
    if (ship.blocked === 'idTaken')
        return l10n.t(
            'A built-in ship of that name exists, so the game would refuse the duplicate. Rename the file to register it.'
        );
    if (ship.blocked) return l10n.t('This file does not carry a saved ship.');
    const parts: string[] = [
        l10n.t(
            "Worth {0} credits ({1} parts, {2} crew), which the game's tier table puts at tier {3}.",
            credits(ship.value.total),
            String(ship.signals.parts),
            String(ship.signals.crew),
            String(ship.valueTier)
        ),
    ];
    if (ship.tierByRole[role] !== ship.valueTier) {
        parts.push(
            l10n.t(
                "Written at tier {0} instead, since the game's own stations sit below their value so they outweigh the ships around them.",
                String(ship.tierByRole[role])
            )
        );
    }
    parts.push(difficultyReason(ship), l10n.t('{0}: {1}.', roleLabel(role), roleReason(ship, role)));
    if (ship.signals.unknownParts.length > 0) {
        parts.push(l10n.t('{0} parts nothing declares.', String(ship.signals.unknownParts.length)));
    }
    return parts.join(' ');
};

/**
 * The files the command was given: the explorer's selection, or a dialog when it was run from the
 * palette. A saved ship is a picture, so it is rarely the file in the editor.
 *
 * @param uri the resource the explorer passed, absent from the palette.
 * @param uris every selected resource, when several were.
 * @returns the paths to read, empty when the author backed out.
 */
const blueprintPaths = async (uri?: Uri, uris?: Uri[]): Promise<string[]> => {
    const given = (uris && uris.length > 0 ? uris : uri ? [uri] : []).filter((item) => item.scheme === 'file');
    if (given.length > 0) return given.map((item) => item.fsPath);
    const how = await window.showQuickPick(
        [
            { label: l10n.t('Pick saved ships'), detail: l10n.t('One or more .ship.png files'), folder: false },
            {
                label: l10n.t('Pick a folder of saved ships'),
                detail: l10n.t('Every .ship.png directly in it'),
                folder: true,
            },
        ],
        { placeHolder: l10n.t('Which ships should join a faction?') }
    );
    if (!how) return [];
    const chosen = await window.showOpenDialog({
        canSelectFiles: !how.folder,
        canSelectFolders: how.folder,
        canSelectMany: !how.folder,
        filters: how.folder ? undefined : { [l10n.t('Saved ships')]: ['png'] },
        openLabel: l10n.t('Add to a faction'),
    });
    return (chosen ?? []).map((item) => item.fsPath);
};

/**
 * Offer the factions, the mod's own first, plus creating one.
 *
 * @param context the extension context, for the faction form.
 * @param client the language client, for the faction wizard.
 * @param anchor the uri the mod is found from.
 * @param scan the server's report.
 * @returns the faction id, or undefined when the author backed out.
 */
const pickFaction = async (
    context: ExtensionContext,
    client: LanguageClient,
    anchor: string,
    scan: RegisterShipScanResult
): Promise<string | undefined> => {
    type Item = QuickPickItem & { id?: string; create?: boolean };
    const items: Item[] = [
        ...scan.factions.map((faction) => ({
            label: faction.name ? `${faction.name} (${faction.id})` : faction.id,
            description: faction.own
                ? l10n.t('this mod')
                : faction.source === 'game'
                  ? l10n.t('the game')
                  : l10n.t('another mod in the workspace'),
            id: faction.id,
        })),
        {
            label: `$(add) ${l10n.t('Create a new faction…')}`,
            detail: l10n.t(
                'Writes the faction, its territory, its tiers and its FTL beacon, then puts the ships in it'
            ),
            create: true,
        },
    ];
    const picked = await window.showQuickPick(items, {
        placeHolder: l10n.t('Which faction do the ships join?'),
        matchOnDescription: true,
    });
    if (!picked) return undefined;
    if (picked.create) return await createNewFaction(context, client, anchor, { silent: true });
    return picked.id;
};

/**
 * Review the ships: every one is offered with its suggestion and ticked, and an extra entry lets
 * the author adjust a ship before anything is written.
 *
 * @param scan the server's report.
 * @returns the choices, or undefined when the author backed out.
 */
const reviewShips = async (scan: RegisterShipScanResult): Promise<ShipChoice[] | undefined> => {
    type Item = QuickPickItem & { ship?: ScannedShip; adjust?: boolean };
    const readable = scan.ships.filter((ship) => !ship.blocked);
    const items: Item[] = readable.map((ship) => {
        const role = ship.roles[0];
        return {
            label: ship.name,
            description: l10n.t(
                '{0} · tier {1} · difficulty {2} ({3})',
                roleLabel(role),
                String(ship.tierByRole[role]),
                String(ship.difficulty),
                difficultyWord(ship.difficulty)
            ),
            detail: shipDetail(ship, role),
            picked: true,
            ship,
        };
    });
    for (const ship of scan.ships.filter((ship) => ship.blocked)) {
        items.push({ label: ship.name, description: l10n.t('skipped'), detail: shipDetail(ship, 'combat'), ship });
    }
    if (readable.length > 1) {
        items.push({
            label: `$(settings-gear) ${l10n.t('Adjust a ship before registering')}`,
            detail: l10n.t('Tick this to change the role, the tier or the difficulty of each ticked ship'),
            adjust: true,
        });
    }
    const picked = await window.showQuickPick(items, {
        canPickMany: true,
        title: ratingLegend(),
        placeHolder:
            readable.length === 1
                ? l10n.t('Register this ship as suggested? Untick it to adjust it first.')
                : l10n.t('Register the ticked ships as suggested'),
        matchOnDescription: true,
    });
    if (!picked) return undefined;
    const adjust = picked.some((item) => item.adjust) || (readable.length === 1 && picked.length === 0);
    const chosen = picked.filter((item) => item.ship && !item.ship.blocked).map((item) => item.ship as ScannedShip);
    const ships = readable.length === 1 && picked.length === 0 ? readable : chosen;
    const choices: ShipChoice[] = [];
    for (const ship of ships) {
        const choice = adjust ? await adjustShip(ship) : suggestionFor(ship);
        if (!choice) return undefined;
        choices.push(choice);
    }
    return choices;
};

/** The server's suggestion for a ship, as a choice. */
const suggestionFor = (ship: ScannedShip): ShipChoice => ({
    fsPath: ship.fsPath,
    role: ship.roles[0],
    tier: ship.tierByRole[ship.roles[0]],
    difficulty: ship.difficulty,
});

/**
 * Ask the role, the tier and the difficulty of one ship, each starting from the suggestion.
 *
 * @param ship the scanned ship.
 * @returns the choice, or undefined when the author backed out.
 */
const adjustShip = async (ship: ScannedShip): Promise<ShipChoice | undefined> => {
    const role = await window.showQuickPick(
        ship.roles.map((candidate, index) => ({
            label: roleLabel(candidate),
            description: index === 0 ? l10n.t('suggested') : '',
            detail:
                l10n.t('tier {0}', String(ship.tierByRole[candidate])) +
                (index === 0 ? ` · ${roleReason(ship, candidate)}` : ''),
            role: candidate,
        })),
        { title: ship.name, placeHolder: l10n.t('What kind of ship is it?') }
    );
    if (!role) return undefined;
    const tier = await window.showInputBox({
        title: ship.name,
        prompt: l10n.t(
            'The danger level of the star systems the ship spawns in, 1 to 18. The game values it at {0} credits, which its tier table puts at tier {1}.',
            credits(ship.value.total),
            String(ship.valueTier)
        ),
        value: String(ship.tierByRole[role.role]),
        validateInput: (value) =>
            /^\d{1,2}$/.test(value.trim()) && Number(value) >= 1 ? undefined : l10n.t('A whole number from 1 up.'),
    });
    if (tier === undefined) return undefined;
    const difficulty = await window.showQuickPick(
        ([1, 2, 3] as ShipDifficulty[]).map((band) => ({
            label: difficultyLabel(band),
            description: band === ship.difficulty ? l10n.t('suggested') : '',
            band,
        })),
        {
            title: ship.name,
            placeHolder:
                difficultyReason(ship) +
                ' ' +
                l10n.t('The game itself never reads the difficulty, only mods that filter their spawns by it do.'),
        }
    );
    if (!difficulty) return undefined;
    return { fsPath: ship.fsPath, role: role.role, tier: Number(tier), difficulty: difficulty.band };
};

/**
 * Say why nothing could be registered.
 *
 * @param failure the server's reason.
 * @returns the message.
 */
const registerFailureMessage = (failure: string): string => {
    switch (failure) {
        case 'noModRoot':
            return l10n.t('Cosmoteer: this folder is in no mod. Open a mod with a mod.rules manifest first.');
        case 'notEditable':
            return l10n.t(
                "Cosmoteer: this is the game's own data or somebody else's installed mod, which is not yours to add to."
            );
        case 'noGameRoot':
            return l10n.t('Cosmoteer: the game path is unset, so the ships could not be judged.');
        case 'noBlueprints':
            return l10n.t('Cosmoteer: none of those files is a saved ship.');
        case 'unknownFaction':
            return l10n.t('Cosmoteer: no faction was chosen, so nothing was registered.');
        default:
            return l10n.t('Cosmoteer: nothing was registered ({0}).', failure);
    }
};

/**
 * Say why one ship stayed out.
 *
 * @param failure the server's reason.
 * @returns the phrase.
 */
const shipFailurePhrase = (failure: string): string => {
    switch (failure) {
        case 'alreadyRegistered':
            return l10n.t('already registered');
        case 'idTaken':
            return l10n.t('a built-in ship of that name exists, so the game would refuse the duplicate');
        case 'unreadable':
            return l10n.t('not a saved ship');
        case 'copyFailed':
            return l10n.t('could not be copied into the mod');
        case 'editRejected':
            return l10n.t('the editor turned the edit down');
        default:
            return failure;
    }
};

/**
 * Say why the manifest was not written, which leaves the ship files in place but unwired.
 *
 * @param failure the server's reason.
 * @param manifests the manifests to choose between, for the ambiguous case.
 * @returns the sentence.
 */
const manifestFailureSentence = (failure: string, manifests?: string[]): string => {
    switch (failure) {
        case 'ambiguousManifest':
            return l10n.t(
                'The mod has several manifests and none is mod.rules, so the action adding the faction to the built-in ships is yours to write. Candidates: {0}.',
                (manifests ?? []).join(', ')
            );
        case 'manifestUnusable':
            return l10n.t(
                "The mod's Actions come from an included file, which cannot be appended to, so the action adding the faction to the built-in ships is yours to write."
            );
        case 'noGameRoot':
            return l10n.t('The game path is unset, so the manifest action could not be written.');
        default:
            return l10n.t('The manifest could not be written, so nothing loads the ships yet.');
    }
};

/**
 * Put saved ships into a faction. Bound to `cosmoteer.addShipToFaction`, which the explorer passes
 * the selected files or folders to.
 *
 * @param client the language client the command runs through.
 * @param uri the resource the explorer passed, absent from the palette.
 * @param uris every selected resource, when several were.
 */
export async function addShipToFaction(
    context: ExtensionContext,
    client: LanguageClient,
    uri?: Uri,
    uris?: Uri[]
): Promise<void> {
    const anchor = anchorUri();
    if (!anchor) {
        window.showInformationMessage(l10n.t('Cosmoteer: open the folder of your mod first.'));
        return;
    }
    const blueprints = await blueprintPaths(uri, uris);
    if (blueprints.length === 0) return;

    const scan = await window.withProgress(
        { location: { viewId: 'workbench.view.explorer' }, title: l10n.t('Reading the ships') },
        async () =>
            (await client.sendRequest(ExecuteCommandRequest.type, {
                command: REGISTER_SHIP_SERVER_COMMAND,
                arguments: [{ uri: anchor, blueprints }],
            })) as RegisterShipScanResult | null
    );
    if (!scan || scan.failure) {
        window.showWarningMessage(
            scan?.failure ? registerFailureMessage(scan.failure) : l10n.t('Cosmoteer: the ships could not be read.')
        );
        return;
    }
    if (scan.balanceFallback) {
        window.showWarningMessage(
            l10n.t(
                "Cosmoteer: the game path is unset, so the tiers were worked out from the shipped tier table rather than the game's own."
            )
        );
    }

    // Nothing to register is said before a faction is asked for, with the reason, so a folder of
    // the game's own ships does not cost the author the whole wizard to find out.
    if (!scan.ships.some((ship) => !ship.blocked)) {
        window.showWarningMessage(
            scan.ships.some((ship) => ship.blocked === 'idTaken')
                ? l10n.t(
                      'Cosmoteer: none of those ships can be registered. {0} of them carry the name of a built-in ship, which the game refuses as a duplicate. Rename the files to register them.',
                      String(scan.ships.filter((ship) => ship.blocked === 'idTaken').length)
                  )
                : l10n.t('Cosmoteer: none of those files is a saved ship.')
        );
        return;
    }

    const faction = await pickFaction(context, client, anchor, scan);
    if (!faction) return;
    const ships = await reviewShips(scan);
    if (!ships || ships.length === 0) return;

    const openBefore = openDocumentPaths();
    const result = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: REGISTER_SHIP_SERVER_COMMAND,
        arguments: [{ uri: anchor, blueprints, faction, ships }],
    })) as RegisterShipApplyResult | null;
    if (!result) {
        window.showWarningMessage(l10n.t('Cosmoteer: nothing was registered.'));
        return;
    }
    if (result.failure) {
        window.showWarningMessage(registerFailureMessage(result.failure));
        return;
    }
    await saveAndTidy(result.changedFiles, openBefore);
    await showRegistrationSummary(result);
}

/**
 * Say what was registered and what was not.
 *
 * @param result the server's summary.
 */
const showRegistrationSummary = async (result: RegisterShipApplyResult): Promise<void> => {
    const done = result.ships.filter((ship) => !ship.failure);
    const failed = result.ships.filter((ship) => ship.failure);
    const notes: string[] = [];
    if (done.length > 0) {
        notes.push(
            l10n.t(
                'Cosmoteer: {0} registered in {1}: {2}.',
                String(done.length),
                result.faction,
                done
                    .map((ship) => `${ship.name} (${roleLabel(ship.role)}, ${l10n.t('tier {0}', String(ship.tier))})`)
                    .join(', ')
            )
        );
    }
    for (const ship of failed) notes.push(l10n.t('{0}: {1}.', ship.name, shipFailurePhrase(ship.failure ?? '')));
    if (result.manifestFailure) notes.push(manifestFailureSentence(result.manifestFailure, result.manifests));
    else if (done.length > 0 && result.manifest)
        notes.push(l10n.t('The faction is wired in from {0}.', workspace.asRelativePath(result.manifest)));
    const icons = done.filter((ship) => ship.stasisIcon).length;
    if (icons > 0)
        notes.push(
            l10n.t('{0} station icons were drawn beside the ships, for you to replace if you like.', String(icons))
        );
    const starterKeys = done.map((ship) => ship.starterDescriptionKey).filter((key): key is string => !!key);
    if (starterKeys.length > 0) {
        notes.push(
            l10n.t(
                'The career mode offers the starter ships with these descriptions to write in the language files: {0}.',
                starterKeys.join(', ')
            )
        );
    }
    const message = notes.join(' ');
    const first = done[0];
    if (!first) {
        window.showWarningMessage(message);
        return;
    }
    const open = l10n.t('Open the registration');
    const picked = await window.showInformationMessage(message, open);
    if (picked === open) {
        const document = await workspace.openTextDocument(Uri.file(first.registeredIn));
        await window.showTextDocument(document, { preview: false });
    }
};

/**
 * Create a faction: ask its id and its name, and let the server write it and everything the career
 * mode needs to give it territory. Bound to `cosmoteer.newFaction.create`, and run from the ship
 * wizard when the author picks a faction that does not exist yet.
 *
 * @param client the language client the command runs through.
 * @param anchor the uri the mod is found from, absent to find it from the editor.
 * @param options `silent` to skip opening the file, for the ship wizard's use.
 * @returns the new faction's id, or undefined when nothing was created.
 */
export async function createNewFaction(
    context: ExtensionContext,
    client: LanguageClient,
    anchor?: string,
    options: { silent?: boolean } = {}
): Promise<string | undefined> {
    const uri = wizardAnchor(anchor);
    if (!uri) return undefined;
    const scan = await scanForWizard<NewFactionScanResult>(
        client,
        NEW_FACTION_SERVER_COMMAND,
        uri,
        factionFailureMessage
    );
    if (!scan) return undefined;
    const form = await showNewFactionForm(context, {
        modRoot: scan.modRoot,
        takenIds: scan.takenIds,
        playerIndexes: [scan.suggestedPlayerIndex, scan.suggestedPlayerIndex + 1],
    });
    if (!form) return undefined;

    const result = await applyForWizard<NewFactionApplyResult>(
        client,
        NEW_FACTION_SERVER_COMMAND,
        {
            uri,
            id: form.id,
            name: form.name,
            color: form.color,
            icon: form.icon,
            beaconShip: form.beaconShip,
            lore: form.lore,
        },
        factionFailureMessage
    );
    if (!result) return undefined;

    const notes = [
        l10n.t(
            'Cosmoteer: created the faction {0} with player indexes {1} and {2}.',
            result.id,
            String(result.militaryPlayerIndex),
            String(result.civilianPlayerIndex)
        ),
    ];
    const unwired = Object.entries(result.wiring).filter(
        ([, outcome]) => outcome !== 'written' && outcome !== 'present' && outcome !== 'skipped'
    );
    if (unwired.length > 0) {
        const reason = unwired[0][1];
        notes.push(
            reason === 'ambiguousManifest'
                ? l10n.t(
                      'The mod has several manifests and none is mod.rules, so the actions wiring it in are yours to write. Candidates: {0}.',
                      (result.manifests ?? []).join(', ')
                  )
                : reason === 'manifestUnusable'
                  ? l10n.t(
                        "The mod's Actions come from an included file, which cannot be appended to, so the actions wiring it in are yours to write."
                    )
                  : l10n.t('Some of it could not be wired in: {0}.', unwired.map(([key]) => key).join(', '))
        );
    }
    if (result.localizationFiles.length === 0) {
        notes.push(
            l10n.t(
                'This mod ships no language file, so {0} was not declared anywhere and the game will show no name.',
                result.nameKey
            )
        );
    }
    if (result.placeholderAssets.length === 2) {
        notes.push(
            l10n.t("Its icon and its FTL beacon are the game's own for now, named in the files for you to replace.")
        );
    } else if (result.placeholderAssets.length === 1) {
        notes.push(
            result.iconFile
                ? l10n.t("Its FTL beacon is the game's own for now, named in the beacon file for you to replace.")
                : l10n.t("Its icon is the game's own for now, named in the faction file for you to replace.")
        );
    }
    if (result.loreFile) {
        notes.push(
            l10n.t(
                'Its lore page is in the codex, with {0} texts to write in the language files.',
                String(result.loreKeys.length)
            )
        );
    }
    if (options.silent) {
        window.showInformationMessage(notes.join(' '));
        return result.id;
    }
    const document = await workspace.openTextDocument(Uri.file(result.factionFile));
    await window.showTextDocument(document, { preview: false });
    const addShips = l10n.t('Add ships to it');
    const picked = await window.showInformationMessage(notes.join(' '), addShips);
    if (picked === addShips) await commands.executeCommand(ADD_SHIP_TO_FACTION_COMMAND);
    return result.id;
}

/**
 * Say why no faction was created.
 *
 * @param failure the server's reason.
 * @returns the message.
 */
const factionFailureMessage = (failure: string): string => {
    switch (failure) {
        case 'noModRoot':
            return l10n.t('Cosmoteer: this folder is in no mod. Open a mod with a mod.rules manifest first.');
        case 'notEditable':
            return l10n.t(
                "Cosmoteer: this is the game's own data or somebody else's installed mod, which is not yours to add to."
            );
        case 'noGameRoot':
            return l10n.t('Cosmoteer: the game path is unset, so where the faction registry lives could not be read.');
        case 'invalidId':
            return l10n.t('Cosmoteer: a faction id is one word of letters, digits and underscores.');
        case 'idTaken':
            return l10n.t('Cosmoteer: a faction of that id already exists.');
        case 'pathTaken':
            return l10n.t('Cosmoteer: a folder for that faction is already there, so nothing was created.');
        case 'writeFailed':
            return l10n.t('Cosmoteer: the files could not be written, so nothing was created.');
        default:
            return l10n.t('Cosmoteer: nothing was created ({0}).', failure);
    }
};
