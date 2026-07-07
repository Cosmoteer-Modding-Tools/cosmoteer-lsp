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

/** First value node that is the RHS of an assignment named `field`, descending into the whole tree. */
const findValue = (node: AbstractNode, field: string): ValueNode | undefined => {
    if (isAssignmentNode(node) && node.left.name === field && isValueNode(node.right)) return node.right;
    const children =
        isDocumentNode(node) || isGroupNode(node) || isListNode(node)
            ? node.elements
            : isAssignmentNode(node)
              ? [node.right]
              : [];
    for (const child of children) {
        const found = findValue(child, field);
        if (found) return found;
    }
    return undefined;
};

/** Every leaf key path a parsed strings document declares (mirrors the index harvest, for assertions). */
const keyPaths = (container: { elements: AbstractNode[] }, prefix = ''): string[] => {
    const out: string[] = [];
    if (isAssignmentNode(container as unknown as AbstractNode) || isValueNode(container as unknown as AbstractNode)) return out;
    for (const element of container.elements) {
        let name: string | undefined;
        let value: AbstractNode | undefined;
        if (isAssignmentNode(element)) {
            name = element.left.name;
            value = element.right;
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

/** Apply a pure-insertion TextEdit (start === end) to `text`. */
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
});
