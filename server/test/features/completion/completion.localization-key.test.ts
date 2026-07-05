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
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../../src/core/ast/ast';
import { fieldOfValueNode } from '../../../src/features/completion/autocompletion.schema';
import { isLocalizationKeyType } from '../../../src/document/schema/schema';
import { LocalizationKeyIndex } from '../../../src/features/completion/localization-key.index';
import { Completion } from '../../../src/features/completion/autocompletion.service';

const token = CancellationToken.None;
const parse = (src: string, uri: string) => parser(lexer(src), uri).value;
const labelsOf = (cs: Completion[]) => cs.map((c) => (typeof c === 'string' ? c : c.label));

/** First value node that is the RHS of an assignment named `field`, searching depth-first. */
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

// A resource whole-file root (`/resources/` + a top-level `ID`) resolves to `ResourceRules`, whose
// `NameKey` is a `KeyString` (localization key) and `QuantityDisplayFormat` a plain string.
const RESOURCE = `
ID = iron
NameKey = "Resources/Iron"
QuantityDisplayFormat = "{0}"
`;
const RESOURCE_URI = pathToFileURL(join(tmpdir(), 'data', 'resources', 'iron.rules')).href;

describe('localization key field classification', () => {
    it('marks a KeyString field as a localization key and a plain string field as not', async () => {
        const doc = parse(RESOURCE, RESOURCE_URI);
        const nameField = await fieldOfValueNode(findValue(doc, 'NameKey')!, token);
        const plainField = await fieldOfValueNode(findValue(doc, 'QuantityDisplayFormat')!, token);
        expect(isLocalizationKeyType(nameField?.valueType)).toBe(true);
        expect(isLocalizationKeyType(plainField?.valueType)).toBe(false);
    });
});

describe('localization key index', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'loc-keys-'));
        mkdirSync(join(dir, 'strings'), { recursive: true });
        mkdirSync(join(dir, 'parts'), { recursive: true });
        // Two languages share the same key tree — keys must be de-duplicated across them.
        const en = `__Name = "English"\n__DebugOnly = false\nMisc { Okay = "Okay" Cancel = "Cancel" }\nParts { Foo = "Foo Part" }\n`;
        const de = `__Name = "Deutsch"\n__DebugOnly = false\nMisc { Okay = "OK" Cancel = "Abbrechen" }\nParts { Foo = "Foo-Teil" }\n`;
        writeFileSync(join(dir, 'strings', 'en.rules'), en);
        writeFileSync(join(dir, 'strings', 'de.rules'), de);
        // A non-strings file: its field names must never be harvested as keys.
        writeFileSync(join(dir, 'parts', 'foo.rules'), `Part { NameKey = "Parts/Foo" }\n`);
        LocalizationKeyIndex.instance.reset();
    });

    afterEach(() => {
        LocalizationKeyIndex.instance.reset();
        rmSync(dir, { recursive: true, force: true });
    });

    it('harvests slash-joined leaf key paths, de-duplicated across languages, skipping meta keys', async () => {
        const labels = labelsOf(await LocalizationKeyIndex.instance.allKeyCompletions([pathToFileURL(dir).href], token));
        expect(labels).toContain('Misc/Okay');
        expect(labels).toContain('Misc/Cancel');
        expect(labels).toContain('Parts/Foo');
        // De-duplicated: the shared key appears once despite two language files.
        expect(labels.filter((l) => l === 'Misc/Okay')).toHaveLength(1);
        // `__`-prefixed engine directives are not keys.
        expect(labels).not.toContain('__Name');
        expect(labels).not.toContain('__DebugOnly');
        // The non-strings part file contributes nothing.
        expect(labels).not.toContain('Part');
        expect(labels).not.toContain('NameKey');
    });

    it('offers keys on a KeyString field value and nothing on a plain string field', async () => {
        const doc = parse(RESOURCE, RESOURCE_URI);
        const folders = [pathToFileURL(dir).href];
        const onKeyField = labelsOf(
            await LocalizationKeyIndex.instance.keyCompletionsForNode(findValue(doc, 'NameKey')!, folders, token)
        );
        const onPlainField = await LocalizationKeyIndex.instance.keyCompletionsForNode(
            findValue(doc, 'QuantityDisplayFormat')!,
            folders,
            token
        );
        expect(onKeyField).toContain('Parts/Foo');
        expect(onPlainField).toHaveLength(0);
    });
});
