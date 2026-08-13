import { isAbsolute, relative, resolve } from 'path';
import { AbstractNode, isIdentifierNode, isListNode, isValueNode } from '../../core/ast/ast';
import { lexer, Token } from '../../core/lexer/lexer';
import { namedMembersOf, parseText } from '../../utils/ast.utils';
import { foldPathCase } from '../../workspace/fs-cache';

/**
 * Reading and editing the game's own `settings.rules`, specifically its `EnabledMods` list.
 *
 * The file belongs to the game, which rewrites the whole of it from memory on exit, and it carries
 * the user's keybinds, display settings and preferences. So nothing here re-emits it: the edit is a
 * byte splice into the one list, and the result is checked to lex into the original token stream
 * plus exactly the one string that was added, the same self-verification the formatter bails on.
 *
 * Entry paths are read the way `Halfling.IO.FilePath` reads them: an absolute path is taken as
 * written, a `./`-prefixed path resolves against the process working directory (the install root),
 * and anything else resolves against the directory of the file it is written in.
 */

/** What the enable attempt did, or why it refused to touch the file. */
export type EnableModResult =
    | { readonly kind: 'already-enabled'; readonly entry: string }
    | { readonly kind: 'enabled'; readonly text: string; readonly entry: string }
    | { readonly kind: 'refused'; readonly reason: EnableRefusal };

/** Why the settings file was left alone. Each is a shape the game did not write. */
export type EnableRefusal = 'unparseable' | 'no-game-settings' | 'no-enabled-mods' | 'not-equivalent' | 'bad-entry';

/**
 * How a mod folder is written into `EnabledMods`: relative to the settings file when it sits under
 * it, which is what the game writes back anyway, and absolute otherwise. Always forward slashes,
 * never a trailing separator, since the game compares the normalized path against what
 * `Directory.GetDirectories` returned and a trailing separator makes the comparison fail.
 *
 * @param settingsDir the directory `settings.rules` lives in.
 * @param modFolder the absolute path of the mod folder to enable.
 * @returns the entry text, without quotes.
 */
export const settingsEntryFor = (settingsDir: string, modFolder: string): string => {
    const relativePath = relative(settingsDir, modFolder).replace(/\\/g, '/');
    const entry = relativePath === '' || relativePath.startsWith('..') ? modFolder.replace(/\\/g, '/') : relativePath;
    return entry.replace(/\/+$/, '');
};

/**
 * The absolute folder an existing entry names, read the way the game reads it.
 *
 * @param settingsDir the directory `settings.rules` lives in.
 * @param installRoot the game install root, which is the game's working directory.
 * @param entry the written entry, without quotes.
 * @returns the absolute path it resolves to.
 */
export const resolveSettingsEntry = (settingsDir: string, installRoot: string, entry: string): string => {
    const written = entry.trim().replace(/\/+$/, '');
    if (isAbsolute(written)) return resolve(written);
    if (written.startsWith('./') || written.startsWith('.\\')) return resolve(installRoot, written);
    return resolve(settingsDir, written);
};

/** The whitespace the line containing `offset` starts with, so an insertion keeps the file's indent. */
const lineIndentAt = (text: string, offset: number): string => {
    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const match = /^[\t ]*/.exec(text.slice(lineStart, offset));
    return match ? match[0] : '';
};

/**
 * Whether the edited text lexes into the original token stream with only the expected tokens added,
 * one contiguous run holding the new entry. The formatter refuses to write anything whose tokens
 * moved; this refuses to write anything whose tokens moved by more than the entry it meant to add.
 *
 * @param before the original tokens.
 * @param after the tokens of the edited text.
 * @param entry the entry text the added run must contain.
 * @param added how many tokens the shape being written adds.
 * @returns true when the edit added exactly that run and changed nothing else.
 */
const addsOnlyTheEntry = (before: readonly Token[], after: readonly Token[], entry: string, added: number): boolean => {
    if (after.length !== before.length + added) return false;
    const same = (a: Token, b: Token): boolean => a.type === b.type && (a.value ?? '') === (b.value ?? '');
    let at = before.length;
    for (let i = 0; i < before.length; i++) {
        if (same(before[i], after[i])) continue;
        at = i;
        break;
    }
    const run = after.slice(at, at + added);
    if (!run.some((token) => (token.value ?? '').replace(/^"|"$/g, '') === entry)) return false;
    for (let i = at; i < before.length; i++) {
        if (!same(before[i], after[i + added])) return false;
    }
    return true;
};

/** The `EnabledMods` member of the settings file's `GameSettings` group, whatever shape it is in. */
const enabledModsMember = (text: string, settingsPath: string): AbstractNode | 'unparseable' | 'no-game-settings' | 'no-enabled-mods' => {
    let document;
    try {
        document = parseText(text, settingsPath);
    } catch {
        return 'unparseable';
    }
    const gameSettings = namedMembersOf(document).find(([name]) => name.toLowerCase() === 'gamesettings')?.[1];
    if (!gameSettings || !('elements' in gameSettings)) return 'no-game-settings';
    const member = namedMembersOf(gameSettings as { elements: AbstractNode[] }).find(
        ([name]) => name.toLowerCase() === 'enabledmods'
    )?.[1];
    return member ?? 'no-enabled-mods';
};

/**
 * Adds a mod folder to the game's enabled mods, as a byte splice into the written list.
 *
 * @param text the current contents of `settings.rules`.
 * @param settingsPath the absolute path of that file, which entry paths are read relative to.
 * @param installRoot the game install root, for reading `./`-prefixed entries.
 * @param settingsDir the directory the settings file lives in.
 * @param modFolder the absolute path of the mod folder to enable.
 * @returns the new text, or that the mod is already enabled, or the reason nothing was written.
 */
export const enableModInSettings = (
    text: string,
    settingsPath: string,
    installRoot: string,
    settingsDir: string,
    modFolder: string
): EnableModResult => {
    const entry = settingsEntryFor(settingsDir, modFolder);
    // Both would silently fail to match the folder the game enumerated, so they are never written.
    if (entry.includes('\\') || entry.endsWith('/') || entry.includes('"')) {
        return { kind: 'refused', reason: 'bad-entry' };
    }

    const member = enabledModsMember(text, settingsPath);
    if (typeof member === 'string') return { kind: 'refused', reason: member };

    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const wanted = foldPathCase(resolve(modFolder));

    let spliceStart: number;
    let spliceEnd: number;
    let insertion: string;
    // How many tokens the written shape adds: the entry alone when the brackets already exist, and
    // the brackets too when the member had no list at all.
    let addedTokens = 1;
    if (isListNode(member)) {
        for (const element of member.elements) {
            if (!isValueNode(element)) continue;
            const written = String(element.valueType.value).replace(/^"|"$/g, '');
            if (foldPathCase(resolveSettingsEntry(settingsDir, installRoot, written)) === wanted) {
                return { kind: 'already-enabled', entry: written };
            }
        }
        const last = member.elements[member.elements.length - 1];
        if (last) {
            spliceStart = last.position.end;
            spliceEnd = last.position.end;
            insertion = `${eol}${lineIndentAt(text, last.position.start)}"${entry}"`;
        } else {
            // An empty list keeps its own line layout: the entry goes inside the brackets, indented
            // one level past the line the list opens on.
            const listIndent = lineIndentAt(text, member.position.start);
            spliceStart = member.position.start + 1;
            spliceEnd = member.position.end - 1;
            insertion = `${eol}${listIndent}\t"${entry}"${eol}${listIndent}`;
        }
    } else if (isIdentifierNode(member)) {
        // A bare `EnabledMods` with no value at all, which the game reads as an empty set.
        const indent = lineIndentAt(text, member.position.start);
        spliceStart = member.position.end;
        spliceEnd = member.position.end;
        insertion = `${eol}${indent}[${eol}${indent}\t"${entry}"${eol}${indent}]`;
        addedTokens = 3;
    } else {
        return { kind: 'refused', reason: 'no-enabled-mods' };
    }

    if (spliceStart < 0 || spliceEnd > text.length || spliceEnd < spliceStart) {
        return { kind: 'refused', reason: 'not-equivalent' };
    }
    const edited = text.slice(0, spliceStart) + insertion + text.slice(spliceEnd);
    let editedTokens: Token[];
    try {
        editedTokens = lexer(edited);
    } catch {
        return { kind: 'refused', reason: 'not-equivalent' };
    }
    if (!addsOnlyTheEntry(lexer(text), editedTokens, entry, addedTokens)) {
        return { kind: 'refused', reason: 'not-equivalent' };
    }
    return { kind: 'enabled', text: edited, entry };
};
