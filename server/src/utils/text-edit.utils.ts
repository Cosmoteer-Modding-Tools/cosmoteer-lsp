import { TextEdit } from 'vscode-languageserver';

/**
 * Drops duplicate edits within each file, so a range reached twice (a self-reference beside its
 * declaration, a document visited by two walks) contributes one rewrite.
 *
 * @param changes the per-file edits of a workspace edit, rewritten in place.
 */
export const dedupeEdits = (changes: { [uri: string]: TextEdit[] }): void => {
    for (const uri of Object.keys(changes)) {
        const seen = new Set<string>();
        changes[uri] = changes[uri].filter((edit) => {
            const key = `${edit.range.start.line}:${edit.range.start.character}-${edit.range.end.line}:${edit.range.end.character}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
};
