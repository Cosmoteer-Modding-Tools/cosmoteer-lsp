import { existsSync } from 'fs';
import { basename, join, resolve } from 'path';

/**
 * Map a game path the user gave to the `Data` directory it names. A path ending in `Data`,
 * `Cosmoteer` or `common` maps by its tail, compared without case. Any other folder counts when it
 * holds a `Data` folder, so an install under another name still works. A trailing slash of either
 * kind is ignored.
 *
 * @param gamePath the path as it was given, absolute or relative.
 * @returns the `Data` directory it names, or undefined when the path names none.
 */
export const toDataRoot = (gamePath: string): string | undefined => {
    if (!gamePath.trim()) return undefined;
    const trimmed = resolve(gamePath.trim().replace(/[\\/]+$/, ''));
    const tail = basename(trimmed).toLowerCase();
    if (tail === 'data') return trimmed;
    if (tail === 'cosmoteer') return join(trimmed, 'Data');
    if (tail === 'common') return join(trimmed, 'Cosmoteer', 'Data');
    const nested = join(trimmed, 'Data');
    return existsSync(nested) ? nested : undefined;
};
