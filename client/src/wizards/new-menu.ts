import { l10n, QuickPickItem, QuickPickItemKind, window } from 'vscode';

/**
 * The one command that creates anything: a picker of everything the wizards can write, the way
 * the New submenu of an IDE lists every file kind in one place. Each entry hands over to the wizard
 * that already knows how to ask its questions, with the folder the command was invoked on as the
 * mod to write into.
 */
export const NEW_MENU_LOCAL_COMMAND = 'cosmoteer.new';

/** The wizards the menu can hand over to. Each runs the wizard from the anchor the menu was opened on. */
export interface NewMenuActions {
    newMod(): Promise<void>;
    /** A content file of one kind, by the server's kind id (`part`, `resource`, `buff`, …). */
    newContent(kind: string): Promise<void>;
    newFaction(): Promise<void>;
    addShipsToFaction(): Promise<void>;
    newNebula(): Promise<void>;
    newGalaxySize(): Promise<void>;
    newAsteroidType(): Promise<void>;
    newPlanet(): Promise<void>;
    tradeGood(): Promise<void>;
    newTech(): Promise<void>;
}

/** One line of the menu. */
interface NewMenuEntry {
    label: string;
    detail: string;
    run: () => Promise<void>;
}

/** A named section of the menu. */
interface NewMenuSection {
    title: string;
    entries: NewMenuEntry[];
}

/**
 * The menu's sections, in the order they are shown: the mod itself, then the files that go into a
 * mod, then the things that shape the galaxy. The labels match the wizard titles so a name found
 * here is the name found in the palette.
 *
 * @param actions the wizards to hand over to.
 * @returns the sections.
 */
const sectionsOf = (actions: NewMenuActions): NewMenuSection[] => [
    {
        title: l10n.t('Mod'),
        entries: [{ label: l10n.t('Mod'), detail: l10n.t('A mod folder with its manifest and language file.'), run: actions.newMod }],
    },
    {
        title: l10n.t('Content files'),
        entries: [
            { label: l10n.t('Part'), detail: l10n.t('A part, registered in a ship class you pick.'), run: () => actions.newContent('part') },
            { label: l10n.t('Resource'), detail: l10n.t('A resource, added to the game\'s resource list.'), run: () => actions.newContent('resource') },
            { label: l10n.t('Shot'), detail: l10n.t('A projectile for a weapon to fire, created unwired.'), run: () => actions.newContent('bullet') },
            { label: l10n.t('Media effect'), detail: l10n.t('A sound or particle effect for a part to reference, created unwired.'), run: () => actions.newContent('mediaEffect') },
            { label: l10n.t('Title screen ship'), detail: l10n.t('A saved ship of yours, copied in and flown on the menu.'), run: () => actions.newContent('logoShip') },
            { label: l10n.t('Roof decal folder'), detail: l10n.t('A folder whose PNGs the paint tool offers as decals.'), run: () => actions.newContent('decalFolder') },
            { label: l10n.t('Build toolbar category'), detail: l10n.t('A category of the build toolbar for your parts to sit in.'), run: () => actions.newContent('editorGroup') },
            { label: l10n.t('Part stat line'), detail: l10n.t('A line of a part tooltip, shown once a part writes a value under it.'), run: () => actions.newContent('partStat') },
            { label: l10n.t('Part toggle'), detail: l10n.t('An on/off switch a part component can carry, with its buttons and hotkeys.'), run: () => actions.newContent('partToggle') },
            { label: l10n.t('Buff'), detail: l10n.t("A buff parts can provide and receive, merged into the game's buff map."), run: () => actions.newContent('buff') },
            { label: l10n.t('Codex page'), detail: l10n.t('A help page under the Tutorials tab of the codex, with its texts as language keys.'), run: () => actions.newContent('codexPage') },
        ],
    },
    {
        title: l10n.t('Galaxy'),
        entries: [
            { label: l10n.t('Faction'), detail: l10n.t('A faction with its territory, tiers, beacon and lore page.'), run: actions.newFaction },
            { label: l10n.t('Ships in a faction'), detail: l10n.t('Saved ships put into a faction\'s spawn pool, rated the way the game rates them.'), run: actions.addShipsToFaction },
            { label: l10n.t('Nebula'), detail: l10n.t('A nebula built on one of the game\'s own, in your colours.'), run: actions.newNebula },
            { label: l10n.t('Galaxy size'), detail: l10n.t('A galaxy size offered when a new game begins.'), run: actions.newGalaxySize },
            { label: l10n.t('Tech'), detail: l10n.t('A tech that puts one of your parts behind a purchase at a station.'), run: actions.newTech },
            { label: l10n.t('Asteroid type'), detail: l10n.t("A mineable asteroid yielding a resource, with a look borrowed from the game's own."), run: actions.newAsteroidType },
            { label: l10n.t('Planet'), detail: l10n.t("A planet built on one of the game's own, spawning in career sectors."), run: actions.newPlanet },
            { label: l10n.t('Resource in trade'), detail: l10n.t('A resource that trade ships carry and stations stock.'), run: actions.tradeGood },
        ],
    },
];

/**
 * Shows the menu and runs what was picked.
 *
 * @param actions the wizards to hand over to.
 */
export async function showNewMenu(actions: NewMenuActions): Promise<void> {
    const items: Array<QuickPickItem & { run?: () => Promise<void> }> = [];
    for (const section of sectionsOf(actions)) {
        items.push({ label: section.title, kind: QuickPickItemKind.Separator });
        for (const entry of section.entries) items.push({ label: entry.label, detail: entry.detail, run: entry.run });
    }
    const picked = await window.showQuickPick(items, {
        title: l10n.t('Cosmoteer: New'),
        placeHolder: l10n.t('What do you want to create?'),
        matchOnDetail: true,
    });
    if (picked?.run) await picked.run();
}
