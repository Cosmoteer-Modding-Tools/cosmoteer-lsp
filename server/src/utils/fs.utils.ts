import { readdirSync } from 'fs';

/** List a directory's entries, returning an empty array instead of throwing when it can't be read. */
export const safeReaddir = (dir: string): string[] => {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
};
