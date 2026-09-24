import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../../src/core/ast/ast';
import { LocalizationKeyIndex } from '../../../src/features/completion/localization-key.index';
import { localizationKeyHover } from '../../../src/features/hover/localization-key-hover';
import { validateLocalizationKeys } from '../../../src/features/diagnostics/validator.localization-key';
import { insertEditForFile, buildInsertLocalizationKeyEdit } from '../../../src/features/diagnostics/localization-key-insert';
import { clearModRootCache } from '../../../src/mod/mod-root';

const token = CancellationToken.None;
const parse = (src: string, uri: string) => parser(lexer(src), uri).value;

/**
 * Find the first value node that is the RHS of an assignment named `field`, descending into the whole tree.
 * @param node the node to search from.
 * @param field the assignment name to look for.
 * @returns the assigned value node, or undefined when no such assignment exists.
 */
const findValue = (node: AbstractNode, field: string): ValueNode | undefined => {
    if (isAssignmentNode(node) && node.left.name === field && isValueNode(node.right)) return node.right;
    const children =
        isDocumentNode(node) || isGroupNode(node) || isListNode(node)
            ? node.elements
            : isAssignmentNode(node) && node.right
              ? [node.right]
              : [];
    for (const child of children) {
        const found = findValue(child, field);
        if (found) return found;
    }
    return undefined;
};

/**
 * Collect every leaf key path a parsed strings document declares, mirroring the index harvest for assertions.
 * @param container the document or group node to walk.
 * @param prefix the slash-joined key path accumulated from the enclosing groups.
 * @returns the leaf key paths, skipping `__`-prefixed engine directives.
 */
const keyPaths = (container: { elements: AbstractNode[] }, prefix = ''): string[] => {
    const out: string[] = [];
    if (isAssignmentNode(container as unknown as AbstractNode) || isValueNode(container as unknown as AbstractNode)) return out;
    for (const element of container.elements) {
        let name: string | undefined;
        let value: AbstractNode | undefined;
        if (isAssignmentNode(element)) {
            name = element.left.name;
            value = element.right ?? undefined;
        } else if (isGroupNode(element) && element.identifier) {
            name = element.identifier.name;
            value = element;
        }
        if (!name || name.startsWith('__') || !value) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (isGroupNode(value)) out.push(...keyPaths(value, path));
        else if (isValueNode(value)) out.push(path);
    }
    return out;
};

/**
 * Apply a pure-insertion TextEdit (start === end) to `text`.
 * @param text the document text to insert into.
 * @param edit the insertion edit, whose range start is the insertion point.
 * @returns the text with `edit.newText` inserted.
 */
const applyInsert = (text: string, edit: { range: { start: { line: number; character: number } }; newText: string }) => {
    const lines = text.split('\n');
    let offset = 0;
    for (let i = 0; i < edit.range.start.line; i++) offset += lines[i].length + 1;
    offset += edit.range.start.character;
    return text.slice(0, offset) + edit.newText + text.slice(offset);
};

// A resource whole-file root (`/resources/` + top-level `ID`) → `ResourceRules`, whose `NameKey` /
// `DescriptionKey` are `KeyString` fields and `QuantityDisplayFormat` a plain string.
const RESOURCE_DIR = join(tmpdir(), 'loc-feat', 'data', 'resources');

describe('localization key hover and validation', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'loc-feat-'));
        mkdirSync(join(dir, 'strings'), { recursive: true });
        const en = `__Name = "English"\n__DebugOnly = false\nMisc { Okay = "Okay" }\nParts { Foo = "Foo Part" }\n`;
        const de = `__Name = "Deutsch"\n__DebugOnly = false\nMisc { Okay = "OK" }\nParts { Foo = "Foo-Teil" }\n`;
        writeFileSync(join(dir, 'strings', 'en.rules'), en);
        writeFileSync(join(dir, 'strings', 'de.rules'), de);
        LocalizationKeyIndex.instance.reset();
    });

    afterEach(() => {
        LocalizationKeyIndex.instance.reset();
        rmSync(dir, { recursive: true, force: true });
    });

    const resourceDoc = (body: string): AbstractNodeDocument =>
        parse(`ID = iron\n${body}\n`, pathToFileURL(join(RESOURCE_DIR, 'iron.rules')).href);

    it('hovers a localization key with each language’s text, and ignores a plain string field', async () => {
        const doc = resourceDoc('NameKey = "Parts/Foo"\nQuantityDisplayFormat = "{0}"');
        const folders = [pathToFileURL(dir).href];
        const hover = await localizationKeyHover(findValue(doc, 'NameKey')!, folders, token);
        expect(hover).toContain('Parts/Foo');
        expect(hover).toContain('Foo Part');
        expect(hover).toContain('Foo-Teil');
        expect(await localizationKeyHover(findValue(doc, 'QuantityDisplayFormat')!, folders, token)).toBeNull();
    });

    it('shows one hover line per language when a second English strings file redeclares a key', async () => {
        // The base game splits English strings across files, and a mod can redeclare a vanilla key.
        // Hover must show one line per language, not one per source file.
        writeFileSync(join(dir, 'strings', 'en-extra.rules'), `__Name = "English"\nParts { Foo = "Foo Part" }\n`);
        LocalizationKeyIndex.instance.reset();
        const doc = resourceDoc('NameKey = "Parts/Foo"');
        const hover = await localizationKeyHover(findValue(doc, 'NameKey')!, [pathToFileURL(dir).href], token);
        expect(hover!.match(/Foo Part/g)).toHaveLength(1);
        expect(hover).toContain('Foo-Teil');
    });

    it('shows the later (mod) value for a language that overrides a key, as the game renders it', async () => {
        // A later strings file wins in-game (the mod loads after the game Data tree). The texts iterate
        // in that order, so the overriding value is the one hover shows, one English line, not two.
        writeFileSync(join(dir, 'strings', 'zz-override.rules'), `__Name = "English"\nParts { Foo = "Foo Part (modded)" }\n`);
        LocalizationKeyIndex.instance.reset();
        const doc = resourceDoc('NameKey = "Parts/Foo"');
        const hover = await localizationKeyHover(findValue(doc, 'NameKey')!, [pathToFileURL(dir).href], token);
        expect(hover).toContain('Foo Part (modded)');
        expect(hover!.match(/English/g)).toHaveLength(1);
    });

    it('hover reports a key that no strings file declares', async () => {
        const doc = resourceDoc('NameKey = "Parts/Ghost"');
        const hover = await localizationKeyHover(findValue(doc, 'NameKey')!, [pathToFileURL(dir).href], token);
        expect(hover).toContain('Parts/Ghost');
        expect(hover?.toLowerCase()).toContain('not found');
    });

    it('flags a missing localization key with an insert payload, and passes a present one', async () => {
        const doc = resourceDoc('NameKey = "Parts/Foo"\nDescriptionKey = "Parts/Missing"');
        const errors = await validateLocalizationKeys(doc, [pathToFileURL(dir).href], token);
        expect(errors).toHaveLength(1);
        expect(errors[0].node).toBe(findValue(doc, 'DescriptionKey'));
        expect(errors[0].severity).toBe('warning');
        expect(errors[0].data?.insertLocalizationKey?.key).toBe('Parts/Missing');
    });

    it('matches keys case-insensitively, like the game', async () => {
        const doc = resourceDoc('NameKey = "parts/FOO"');
        expect(await validateLocalizationKeys(doc, [pathToFileURL(dir).href], token)).toHaveLength(0);
    });
});

describe('localization key insertion edit', () => {
    const uri = 'file:///strings/en.rules';

    it('adds a leaf to an existing group', () => {
        const text = `Misc\n{\n\tOkay = "Okay"\n}\n`;
        const edit = insertEditForFile(parse(text, uri), text, 'Misc/New')!;
        expect(edit).not.toBeNull();
        expect(keyPaths(parse(applyInsert(text, edit), uri))).toContain('Misc/New');
    });

    it('creates a new top-level group chain', () => {
        const text = `Misc\n{\n\tOkay = "Okay"\n}\n`;
        const edit = insertEditForFile(parse(text, uri), text, 'Parts/Weapons/Laser')!;
        expect(edit).not.toBeNull();
        const paths = keyPaths(parse(applyInsert(text, edit), uri));
        expect(paths).toContain('Parts/Weapons/Laser');
        expect(paths).toContain('Misc/Okay'); // untouched
    });

    it('returns null when the key already exists', () => {
        const text = `Misc\n{\n\tOkay = "Okay"\n}\n`;
        expect(insertEditForFile(parse(text, uri), text, 'Misc/Okay')).toBeNull();
    });

    it('adds a leaf to a nested group in front of its indented closing brace', () => {
        const text = `Lore\n{\n\tX\n\t{\n\t\tTitle = "T"\n\t}\n}\n`;
        const edit = insertEditForFile(parse(text, uri), text, 'Lore/X/Lore1')!;
        expect(applyInsert(text, edit)).toBe(`Lore\n{\n\tX\n\t{\n\t\tTitle = "T"\n\t\tLore1 = ""\n\t}\n}\n`);
    });

    it('gives a nested group whose brace shares a line with its members a line of its own', () => {
        const text = `Lore\n{\n\tX { Title = "T" }\n}\n`;
        const edit = insertEditForFile(parse(text, uri), text, 'Lore/X/Lore1')!;
        expect(applyInsert(text, edit)).toBe(`Lore\n{\n\tX { Title = "T" \n\t\tLore1 = ""\n\t}\n}\n`);
    });

    // A strings file written with `\r\n` or with spaces used to come back mixed, which turns one
    // added key into a whole-file change in the author's diff.
    it('writes the line ending the file already uses', () => {
        const text = `Misc\r\n{\r\n\tOkay = "Okay"\r\n}\r\n`;
        const edit = insertEditForFile(parse(text, uri), text, 'Misc/New')!;
        expect(edit.newText).toBe('\tNew = ""\r\n');
    });

    it('writes the indentation the file already uses', () => {
        const text = `Misc\n{\n    Okay = "Okay"\n}\n`;
        const edit = insertEditForFile(parse(text, uri), text, 'Misc/New')!;
        expect(edit.newText).toBe('    New = ""\n');
    });

    it('indents a new group chain the way the file indents', () => {
        const text = `Misc\n{\n    Okay = "Okay"\n}\n`;
        const edit = insertEditForFile(parse(text, uri), text, 'Parts/Weapons/Laser')!;
        expect(edit.newText).toBe('Parts\n{\n    Weapons\n    {\n        Laser = ""\n    }\n}\n');
    });
});

describe('insert into all the mod’s language files', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'loc-mod-'));
        writeFileSync(join(root, 'mod.rules'), `Author = "me"\n`);
        mkdirSync(join(root, 'strings'), { recursive: true });
        mkdirSync(join(root, 'parts'), { recursive: true });
        writeFileSync(join(root, 'strings', 'en.rules'), `__Name = "English"\nParts { Foo = "Foo" }\n`);
        writeFileSync(join(root, 'strings', 'de.rules'), `__Name = "Deutsch"\nParts { Foo = "Foo" }\n`);
        writeFileSync(join(root, 'parts', 'p.rules'), `Part { NameKey = "Parts/New" }\n`);
        clearModRootCache();
    });

    afterEach(() => {
        clearModRootCache();
        rmSync(root, { recursive: true, force: true });
    });

    it('produces one edit per language file, each inserting the key', async () => {
        const partUri = pathToFileURL(join(root, 'parts', 'p.rules')).href;
        const edit = await buildInsertLocalizationKeyEdit(partUri, 'Parts/New', token);
        expect(edit).not.toBeNull();
        const changed = Object.entries(edit!.changes!);
        expect(changed).toHaveLength(2);
        for (const [fileUri, edits] of changed) {
            expect(fileUri.toLowerCase()).toContain('strings');
            expect(edits[0].newText).toContain('New = ""');
        }
    });

    // `Cosmoteer.Localization.Strings` reaches a language file twice, and both paths spell the
    // extension out: the language picker enumerates `*.rules` in each strings folder, and loading a
    // language opens `<folder>/<id>.rules`. A `.txt` next to them is prose the game never reads, so
    // the quick fix must not put a key the player will never see into it.
    it('leaves a .txt in the strings folder alone, whatever it holds', async () => {
        const language = `__Name = "Francais"\n__DebugOnly = false\nParts { Foo = "Foo" }\n`;
        writeFileSync(join(root, 'strings', 'fr.txt'), language);
        writeFileSync(join(root, 'strings', 'notes.txt'), `prose about the mod\n`);
        const partUri = pathToFileURL(join(root, 'parts', 'p.rules')).href;
        const edit = await buildInsertLocalizationKeyEdit(partUri, 'Parts/New', token);
        const changed = Object.keys(edit!.changes!);
        expect(changed).toHaveLength(2);
        expect(changed.some((fileUri) => fileUri.toLowerCase().endsWith('.txt'))).toBe(false);
    });

    // Only the language picker reads `__Name`, so a mod file that adds strings to a language the
    // base game already offers needs none. Gating the insert on the marker would skip those files.
    it('writes into a language file that declares no __Name', async () => {
        writeFileSync(join(root, 'strings', 'fr.rules'), `Parts { Foo = "Foo" }\n`);
        const partUri = pathToFileURL(join(root, 'parts', 'p.rules')).href;
        const edit = await buildInsertLocalizationKeyEdit(partUri, 'Parts/New', token);
        const changed = Object.keys(edit!.changes!);
        expect(changed).toHaveLength(3);
        expect(changed.some((fileUri) => fileUri.toLowerCase().endsWith('fr.rules'))).toBe(true);
    });
});

describe('a strings folder whose declared spelling differs in case', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'loc-case-'));
        // The manifest names the folder `Strings`, the folder on disk is `strings`. Windows and
        // macOS open the same folder either way, which is why a mod ships like this and works.
        writeFileSync(join(root, 'mod.rules'), `Author = "me"\nStringsFolder = "Strings"\n`);
        mkdirSync(join(root, 'strings'), { recursive: true });
        mkdirSync(join(root, 'parts'), { recursive: true });
        writeFileSync(join(root, 'strings', 'en.rules'), `__Name = "English"\nParts { Foo = "Foo" }\n`);
        writeFileSync(join(root, 'strings', 'de.rules'), `__Name = "Deutsch"\nParts { Foo = "Foo" }\n`);
        writeFileSync(join(root, 'parts', 'p.rules'), `Part { NameKey = "Parts/New" }\n`);
        clearModRootCache();
    });

    afterEach(() => {
        clearModRootCache();
        rmSync(root, { recursive: true, force: true });
    });

    // Each language file has to be written once. Reaching the same file under two spellings puts
    // two edits at the same place into the one workspace edit, and the key lands in the file twice.
    it('writes each language file once', async () => {
        const partUri = pathToFileURL(join(root, 'parts', 'p.rules')).href;
        const edit = await buildInsertLocalizationKeyEdit(partUri, 'Parts/New', token);
        const changed = Object.keys(edit!.changes!);
        expect(changed).toHaveLength(2);
        expect(new Set(changed.map((fileUri) => fileUri.toLowerCase())).size).toBe(2);
    });
});

describe('a strings file whose branch lives in a referenced fragment', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'loc-frag-'));
        mkdirSync(join(dir, 'strings'), { recursive: true });
        // The shape the extract quick fix leaves behind: the language keeps the member and the
        // branch moves into a fragment beside it. `Strings.TryFindString` looks a key up with
        // `OTFile.TryFindAtPath`, which walks through the reference, so the game still renders
        // `Lore/Merchant_Raiders/Lore1` and knows nothing of `Merchant_Raiders/Lore1`.
        writeFileSync(
            join(dir, 'strings', 'en.rules'),
            `__Name = "English"\n__DebugOnly = false\nMisc { Okay = "Okay" }\nLore = &<lore.rules>\n`
        );
        writeFileSync(join(dir, 'strings', 'lore.rules'), `Merchant_Raiders { Lore1 = "They came at dawn." }\n`);
        LocalizationKeyIndex.instance.reset();
    });

    afterEach(() => {
        LocalizationKeyIndex.instance.reset();
        rmSync(dir, { recursive: true, force: true });
    });

    const folders = (): string[] => [pathToFileURL(dir).href];

    const resourceDoc = (body: string): AbstractNodeDocument =>
        parse(`ID = iron\n${body}\n`, pathToFileURL(join(RESOURCE_DIR, 'iron.rules')).href);

    it('passes the key at the path the game resolves it under', async () => {
        const doc = resourceDoc('NameKey = "Lore/Merchant_Raiders/Lore1"');
        expect(await validateLocalizationKeys(doc, folders(), token)).toHaveLength(0);
    });

    it('flags the key at the fragment’s own path, which the game cannot find', async () => {
        const doc = resourceDoc('NameKey = "Merchant_Raiders/Lore1"');
        const errors = await validateLocalizationKeys(doc, folders(), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].data?.insertLocalizationKey?.key).toBe('Merchant_Raiders/Lore1');
    });

    it('offers the key under the referring path and not under the fragment’s own', async () => {
        const offered = (await LocalizationKeyIndex.instance.allKeyCompletions(folders(), token)).map((completion) =>
            typeof completion === 'string' ? completion : completion.label
        );
        expect(offered).toContain('Lore/Merchant_Raiders/Lore1');
        expect(offered).not.toContain('Merchant_Raiders/Lore1');
    });

    it('hovers the text the fragment holds', async () => {
        const doc = resourceDoc('NameKey = "Lore/Merchant_Raiders/Lore1"');
        const hover = await localizationKeyHover(findValue(doc, 'NameKey')!, folders(), token);
        expect(hover).toContain('They came at dawn.');
    });

    it('counts the fragment as part of its language, not as a language of its own', async () => {
        const coverage = await LocalizationKeyIndex.instance.coverageUnder(dir, folders(), token);
        expect(coverage.map((entry) => entry.language)).toEqual(['English']);
        expect([...coverage[0].keys]).toContain('Lore/Merchant_Raiders/Lore1');
    });
});

describe('the key list when one strings file dwarfs the others', () => {
    let dir: string;
    const CAP = 500;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'loc-cap-'));
        mkdirSync(join(dir, 'game', 'strings'), { recursive: true });
        mkdirSync(join(dir, 'mod', 'strings'), { recursive: true });
        // Stands in for the game's own table, which the walk reaches first and which alone holds
        // more keys than the server is allowed to send.
        const bulk = Array.from({ length: 600 }, (_, index) => `\tKey${index} = "Text ${index}"`).join('\n');
        writeFileSync(
            join(dir, 'game', 'strings', 'en.rules'),
            `__Name = "English"\n__DebugOnly = false\nBase\n{\n${bulk}\n}\n`
        );
        writeFileSync(
            join(dir, 'mod', 'strings', 'en.rules'),
            `__Name = "English"\nParts { LaserBlaster = "Laser Blaster" }\n`
        );
        LocalizationKeyIndex.instance.reset();
    });

    afterEach(() => {
        LocalizationKeyIndex.instance.reset();
        rmSync(dir, { recursive: true, force: true });
    });

    it('puts the mod’s own keys inside the window the server is allowed to send', async () => {
        const offered = await LocalizationKeyIndex.instance.allKeyCompletions([pathToFileURL(dir).href], token);
        const shipped = offered
            .slice(0, CAP)
            .map((completion) => (typeof completion === 'string' ? completion : completion.label));
        expect(shipped).toContain('Parts/LaserBlaster');
        expect(shipped).toContain('Base/Key0');
    });
});

describe('the text shown beside a key every language declares', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'loc-detail-'));
        mkdirSync(join(dir, 'strings'), { recursive: true });
        // `de.rules` sorts first, so an index-order read annotates every key with the German text.
        writeFileSync(join(dir, 'strings', 'de.rules'), `__Name = "Deutsch"\nMisc { Okay = "In Ordnung" }\n`);
        writeFileSync(join(dir, 'strings', 'en.rules'), `__Name = "English"\nMisc { Okay = "Okay" }\n`);
        LocalizationKeyIndex.instance.reset();
    });

    afterEach(() => {
        LocalizationKeyIndex.instance.reset();
        rmSync(dir, { recursive: true, force: true });
    });

    it('annotates the key with the English text, the spelling the mod is written from', async () => {
        const offered = await LocalizationKeyIndex.instance.allKeyCompletions([pathToFileURL(dir).href], token);
        const item = offered.find(
            (completion) => typeof completion !== 'string' && completion.label === 'Misc/Okay'
        );
        expect(item).toBeDefined();
        expect(typeof item !== 'string' && item!.detail).toBe('Okay');
    });
});

describe('a strings key whose value aliases another key', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'loc-alias-'));
        mkdirSync(join(dir, 'strings'), { recursive: true });
        // Vanilla's own idiom, from `Data/strings/en.rules`: an unrooted `&Name` names a member of
        // the group the reference sits in, and `&~/Path` reads from the file root.
        writeFileSync(
            join(dir, 'strings', 'en.rules'),
            `__Name = "English"\n__DebugOnly = false\nGameSetupScreen\n{\n\tCantStartTip = &CantReadyTip\n\tCantReadyTip = "You need to add at least one ship to your fleet."\n}\nQuick { Tip = &~/GameSetupScreen/CantReadyTip }\n`
        );
        writeFileSync(
            join(dir, 'strings', 'de.rules'),
            `__Name = "Deutsch"\n__DebugOnly = false\nGameSetupScreen\n{\n\tCantStartTip = "Du brauchst mindestens ein Schiff."\n\tCantReadyTip = "Du brauchst mindestens ein Schiff."\n}\n`
        );
        LocalizationKeyIndex.instance.reset();
    });

    afterEach(() => {
        LocalizationKeyIndex.instance.reset();
        rmSync(dir, { recursive: true, force: true });
    });

    const folders = (): string[] => [pathToFileURL(dir).href];

    const resourceDoc = (body: string): AbstractNodeDocument =>
        parse(`ID = iron\n${body}\n`, pathToFileURL(join(RESOURCE_DIR, 'iron.rules')).href);

    it('hovers the aliased sentence, not the reference the file spells', async () => {
        const doc = resourceDoc('NameKey = "GameSetupScreen/CantStartTip"');
        const hover = await localizationKeyHover(findValue(doc, 'NameKey')!, folders(), token);
        expect(hover).toContain('You need to add at least one ship to your fleet.');
        expect(hover).not.toContain('&CantReadyTip');
        expect(hover).toContain('Du brauchst mindestens ein Schiff.');
    });

    it('follows a file-rooted alias as well', async () => {
        const doc = resourceDoc('NameKey = "Quick/Tip"');
        const hover = await localizationKeyHover(findValue(doc, 'NameKey')!, folders(), token);
        expect(hover).toContain('You need to add at least one ship to your fleet.');
        expect(hover).not.toContain('&~/');
    });

    it('keeps the aliased key in the key set, so nothing reports it as missing', async () => {
        const doc = resourceDoc('NameKey = "GameSetupScreen/CantStartTip"\nDescriptionKey = "Quick/Tip"');
        expect(await validateLocalizationKeys(doc, folders(), token)).toHaveLength(0);
    });
});

describe('a key written in a case the strings file does not use', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'loc-case-'));
        mkdirSync(join(dir, 'strings'), { recursive: true });
        writeFileSync(
            join(dir, 'strings', 'en.rules'),
            `__Name = "English"\n__DebugOnly = false\nParts { Foo = "Foo Part" }\n`
        );
        writeFileSync(
            join(dir, 'strings', 'de.rules'),
            `__Name = "Deutsch"\n__DebugOnly = false\nParts { Foo = "Foo-Teil" }\n`
        );
        LocalizationKeyIndex.instance.reset();
    });

    afterEach(() => {
        LocalizationKeyIndex.instance.reset();
        rmSync(dir, { recursive: true, force: true });
    });

    it('hovers the text the game resolves, agreeing with the validator that stays silent', async () => {
        // Vanilla asks for `Doodads/Asteroidgold_S` while the strings spell `AsteroidGold_S`, so the
        // two features must not answer differently about the same string.
        const doc = parse('ID = iron\nNameKey = "parts/FOO"\n', pathToFileURL(join(RESOURCE_DIR, 'iron.rules')).href);
        const folders = [pathToFileURL(dir).href];
        expect(await validateLocalizationKeys(doc, folders, token)).toHaveLength(0);
        const hover = await localizationKeyHover(findValue(doc, 'NameKey')!, folders, token);
        expect(hover).toContain('Foo Part');
        expect(hover).toContain('Foo-Teil');
        expect(hover?.toLowerCase()).not.toContain('not found');
    });
});
