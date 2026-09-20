// Pure header shortening, exported for Node unit tests. Nothing here touches the DOM or the host,
// so the module can be read on its own.

/**
 * A member path turned into something a header can be read at a glance: a name, and the context
 * above it.
 *
 * The path itself is a poor header. It is long, it repeats the same leading segments on every
 * component field, and its last segment is often the least telling part of it: the `0` of
 * `Size/0` and the `BaseValue` of a modifiable field say nothing on their own. So an index and a
 * base value fold into the field they belong to, the `Components` every component field starts
 * with is dropped, and what is left is the component or the group the field sits in. The game's
 * own stats block reads as `Stats`, since its index and its wrapper say nothing a reader needs.
 * A computed column is named by its name alone.
 *
 * @param {string} path the column path.
 * @returns {{context: string, label: string}} the two lines of the header.
 */
export function headerOf(path) {
    if (path.startsWith('@')) return { context: '', label: path.slice(1) };
    const segments = path.split('/');
    let label = segments[segments.length - 1];
    let above = segments.slice(0, -1);
    if (/^\d+$/.test(label) && above.length) label = `${above.pop()} ${label}`;
    else if (label.toLowerCase() === 'basevalue' && above.length) label = above.pop();
    // Every component field starts with the same segment, so it distinguishes nothing.
    if (above[0] === 'Components') above.shift();
    // The stats block is one wrapper around one list: `StatsByCategory/0/Stats` is the stats,
    // and only a second category needs its number to tell it from the first.
    if (above[0] === 'StatsByCategory' && /^\d+$/.test(above[1] || '') && above[2] === 'Stats') {
        above = [above[1] === '0' ? 'Stats' : `Stats ${above[1]}`].concat(above.slice(3));
    }
    const context = [];
    for (const segment of above) {
        if (/^\d+$/.test(segment) && context.length) context[context.length - 1] += ` ${segment}`;
        else context.push(segment);
    }
    return { context: context.join(' › '), label };
}

/**
 * The headers of the shown columns, keyed by path. Two different fields can shorten to the same
 * header, and a header that names two columns names neither, so those keep their whole path.
 *
 * @param {readonly string[]} keys the columns being drawn.
 * @returns {Map<string, {context: string, label: string}>} the header of each column path.
 */
export function headersFor(keys) {
    const headers = new Map();
    const seen = new Map();
    for (const key of keys) {
        const header = headerOf(key);
        const spelling = `${header.context}/${header.label}`;
        seen.set(spelling, (seen.get(spelling) ?? 0) + 1);
        headers.set(key, header);
    }
    for (const [key, header] of headers) {
        if (seen.get(`${header.context}/${header.label}`) > 1) headers.set(key, { context: '', label: key });
    }
    return headers;
}

/**
 * The number a value typed over a cell stands for, read the way the game reads a literal: a
 * percentage is a fraction, a degree count is radians, a plain number is itself.
 *
 * @param {string} text the typed text.
 * @returns {{value: number, text: string}|null} the number and the trimmed text, or null when
 *          the text is not a number.
 */
export function parseTyped(text) {
    const trimmed = String(text || '').trim();
    const match = /^(-?\d*\.?\d+(?:[eE][-+]?\d+)?)([%dr])?$/.exec(trimmed);
    if (!match) return null;
    const number = Number(match[1]);
    if (!isFinite(number)) return null;
    if (match[2] === '%') return { value: number / 100, text: trimmed };
    if (match[2] === 'd') return { value: (number * Math.PI) / 180, text: trimmed };
    return { value: number, text: trimmed };
}
