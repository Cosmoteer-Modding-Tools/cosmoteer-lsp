// Constants, plus the two row accessors the grouping levels read. Everything the page tunes lives
// here rather than beside its first use, so a value can be found and changed without reading the
// function that happens to read it first.

/** @import {PartRow} from './types.js' */

/**
 * The formula examples the panel offers, so a column can be written by picking one apart rather
 * than by guessing the syntax. The paths are the ones the game's own parts carry.
 */
export const EXAMPLES = [
    { what: 'Health for every cell the part takes up', formula: '[MaxHealth] / [@Tiles]' },
    { what: 'Credits paid for every point of health', formula: '[@Cost] / [MaxHealth]' },
    { what: 'Damage per second for every credit', formula: '[@DPS] / [@Cost]' },
    {
        what: 'Damage per shot times fire rate, times the barrels where a part counts them',
        formula: '[StatsByCategory/0/Stats/DamagePerShot] * [StatsByCategory/0/Stats/ROF] * coalesce([Barrels], 1)',
    },
    {
        what: 'Steel and coils added up, for the parts that take only one of them too',
        formula: 'coalesce([Resources/steel], 0) + coalesce([Resources/coil], 0)',
    },
    { what: 'Every resource the part takes, added up', formula: 'sum([Resources/*])' },
    { what: 'Percent of the compared part', formula: '[MaxHealth] / ref([MaxHealth]) * 100' },
    { what: 'Percent of the average of the parts on screen', formula: '[MaxHealth] / colavg([MaxHealth]) * 100' },
    { what: 'Rank by health, 1 for the highest', formula: 'rank([MaxHealth])' },
    { what: '1 for the parts above ten thousand health, 0 for the rest', formula: 'if([MaxHealth] > 10000, 1, 0)' },
    { what: 'The larger of two columns', formula: 'max([Size/0], [Size/1])' },
    { what: 'Rounded to one decimal', formula: 'round([MaxHealth] / [Size/0], 1)' },
];

/** How far from the reference a value has to be before its cell takes the stronger shade. */
export const FAR_FACTOR = 2;

/** How close to the reference a value counts as the same. */
export const SAME_BAND = 0.005;

/** The identity columns every table opens with, ahead of the picked ones. */
export const IDENTITY = ['id', 'source'];

/** The column the per-tile switch divides by, which the server computes for every row. */
export const TILES = '@Tiles';

/** How many columns a wildcard in a formula may pull onto the table. */
export const MAX_GLOB_COLUMNS = 40;

/**
 * The ship classes that register a part, as one label. A part two classes share, the way the
 * asteroid deposits sit in both the asteroid and the megaroid class, reads as both.
 *
 * @param {PartRow} row the row.
 * @returns {string} the label, empty when no ship class registers the part.
 */
export const shipOf = (row) => (row.ships && row.ships.length ? row.ships.join(' & ') : '');

/**
 * The build menu groups a part sits in, as one label.
 *
 * @param {PartRow} row the row.
 * @returns {string} the label, empty when the part names no group.
 */
export const editorGroupsOf = (row) =>
    row.editorGroups && row.editorGroups.length ? row.editorGroups.join(' & ') : '';

/** The levels a grouping can be built from, each reading one field of a row. */
export const LEVELS = {
    ship: { header: 'Ship class', none: 'No ship class', of: shipOf },
    editorGroup: { header: 'Group', none: 'No group', of: editorGroupsOf },
    category: { header: 'Category', none: 'No category', of: (row) => (row.categories && row.categories[0]) || '' },
    source: { header: 'Mod', none: 'No mod', of: (row) => row.source || '' },
};

/**
 * The ways the rows can be grouped. The first is the way the game files parts: the ship class
 * a part belongs to, and inside it the build menu group.
 */
export const GROUPINGS = {
    shipEditorGroup: { label: 'By ship class, then build menu group', levels: [LEVELS.ship, LEVELS.editorGroup] },
    ship: { label: 'By ship class', levels: [LEVELS.ship] },
    editorGroup: { label: 'By build menu group', levels: [LEVELS.editorGroup] },
    category: { label: 'By category', levels: [LEVELS.category] },
    source: { label: 'By mod', levels: [LEVELS.source] },
};
