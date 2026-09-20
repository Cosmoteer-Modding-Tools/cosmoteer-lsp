import { commands, ExtensionContext, Uri } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import {
    ADD_SHIP_TO_FACTION_COMMAND,
    addShipToFaction,
    createNewFaction,
    NEW_FACTION_LOCAL_COMMAND,
} from '../ships/faction-wizard';
import { createNewNebula, NEW_NEBULA_LOCAL_COMMAND } from './nebula-wizard';
import { createNewGalaxySize, NEW_GALAXY_SIZE_LOCAL_COMMAND } from './galaxy-size-wizard';
import { createNewAsteroidType, NEW_ASTEROID_TYPE_LOCAL_COMMAND } from './asteroid-type-wizard';
import { createNewPlanet, NEW_PLANET_LOCAL_COMMAND } from './planet-wizard';
import { createTradeGood, TRADE_GOOD_LOCAL_COMMAND } from './trade-good-wizard';
import { createNewTech, NEW_TECH_LOCAL_COMMAND } from './tech-wizard';
import { NEW_MENU_LOCAL_COMMAND, showNewMenu } from './new-menu';
import { createNewContent } from '../new-content/new-content';
import { ContentKind } from '../../../shared/new-content.types';
import { createNewMod } from '../new-mod/new-mod';

/**
 * Registers every content wizard, plus the single New entry that offers all of them.
 *
 * The server judges each piece of content the way the game does and writes every file; these
 * wrappers ask the two questions a tool cannot answer for the author, which faction or folder it
 * belongs to and whether the suggested figures stand.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the wizards run their commands through.
 */
export function registerWizards(context: ExtensionContext, client: LanguageClient): void {
    context.subscriptions.push(
        commands.registerCommand(ADD_SHIP_TO_FACTION_COMMAND, async (uri?: Uri, uris?: Uri[]) => {
            await addShipToFaction(context, client, uri, uris);
        }),
        commands.registerCommand(NEW_FACTION_LOCAL_COMMAND, async () => {
            await createNewFaction(context, client);
        }),
        commands.registerCommand(NEW_NEBULA_LOCAL_COMMAND, async () => {
            await createNewNebula(context, client);
        }),
        commands.registerCommand(NEW_GALAXY_SIZE_LOCAL_COMMAND, async () => {
            await createNewGalaxySize(context, client);
        }),
        commands.registerCommand(NEW_ASTEROID_TYPE_LOCAL_COMMAND, async () => {
            await createNewAsteroidType(context, client);
        }),
        commands.registerCommand(NEW_PLANET_LOCAL_COMMAND, async () => {
            await createNewPlanet(context, client);
        }),
        commands.registerCommand(TRADE_GOOD_LOCAL_COMMAND, async () => {
            await createTradeGood(context, client);
        }),
        commands.registerCommand(NEW_TECH_LOCAL_COMMAND, async () => {
            await createNewTech(context, client);
        }),
        // One entry for all of it, the way an IDE's New submenu works: from the palette, from a
        // folder's context menu and from the editor, with that folder or file as the mod to write
        // into.
        commands.registerCommand(NEW_MENU_LOCAL_COMMAND, async (uri?: Uri) => {
            const anchor = uri?.toString();
            await showNewMenu({
                newMod: () => createNewMod(client),
                newContent: (kind) => createNewContent(client, { uri: anchor, kind: kind as ContentKind }),
                newFaction: async () => {
                    await createNewFaction(context, client, anchor);
                },
                addShipsToFaction: () => addShipToFaction(context, client, uri),
                newNebula: () => createNewNebula(context, client, anchor),
                newGalaxySize: () => createNewGalaxySize(context, client, anchor),
                newAsteroidType: () => createNewAsteroidType(context, client, anchor),
                newPlanet: () => createNewPlanet(context, client, anchor),
                tradeGood: () => createTradeGood(context, client, anchor),
                newTech: () => createNewTech(context, client, anchor),
            });
        })
    );
}
