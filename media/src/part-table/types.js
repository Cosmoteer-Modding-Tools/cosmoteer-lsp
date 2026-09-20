// The shapes the part table reads: the payload the server sends, the columns its walk discovered,
// the formula columns the page computes for itself, and the levels a grouping is built from. Types
// alone, so nothing here reaches the bundle.

export {};

/**
 * @typedef {object} PartRow one part of the table, as the server built it.
 * @property {string} key the row's identity, which the view addresses a row by.
 * @property {string} id the part's declared id.
 * @property {string} name the part group's name inside its file.
 * @property {string} file the file's base name.
 * @property {string} uri the part group's own file.
 * @property {number} line the line the part group starts on.
 * @property {number} character the column the part group starts at.
 * @property {string} source the mod the part comes from, or the game's own name.
 * @property {string[]} categories the part's type categories.
 * @property {string[]} editorGroups the build menu groups the part sits in.
 * @property {string[]} ships the ship classes that register the part.
 * @property {Record<string, any>} cells the read values, keyed by column path.
 */

/**
 * @typedef {object} PartColumn one column the walk discovered.
 * @property {string} path the member path from the part group.
 * @property {number} rows how many parts carry a value.
 * @property {boolean} [derived] true for a column the table works out rather than reads.
 * @property {string} [description] what a derived column is.
 */

/**
 * @typedef {object} PartTable the payload the server sends, as the page reads it.
 * @property {PartRow[]} rows the parts.
 * @property {PartColumn[]} columns the columns the walk discovered.
 * @property {string[]} categories the type categories the parts carry.
 * @property {string[]} componentTypes the component types the parts carry.
 * @property {string[]} sources the game and the mods the parts come from.
 * @property {string[]} editorGroups the build menu groups the parts sit in.
 * @property {string[]} suggested the columns to show until the reader picks their own.
 * @property {number} [total] how many parts the project holds.
 * @property {string} [mod] the mod the table was read with.
 * @property {boolean} [truncated] true when the project holds more parts than the table reads.
 * @property {unknown} [columnsVersion] the version of the column set already on the page.
 */

/**
 * @typedef {object} FormulaColumn one column computed from an expression over the others.
 * @property {string} id the page's own id for the column.
 * @property {string} name the name the reader gave it.
 * @property {string} formula the expression as the reader wrote it.
 * @property {Record<string, number|null>} values the computed number per row key.
 */

/**
 * @typedef {object} GroupLevel one level a grouping is built from.
 * @property {string} header what the level is called.
 * @property {string} none what a row that has no value at this level reads as.
 * @property {(row: PartRow) => string} of the label a row carries at this level.
 */
