import { describe, expect, it } from 'vitest';
import { isListNode } from '../../../../src/core/ast/ast';
import { findActionsList, parseModActions } from '../../../../src/mod/action-parser';
import {
    addManyActionText,
    manifestActionInsert,
    shipPartsTargetPath,
} from '../../../../src/features/refactor/register-part/manifest-action.emitter';
import { parseText } from '../../../../src/utils/ast.utils';

// What a mod writes when it may not edit the ship itself. The entry has to round-trip through the
// server's own action parser, which is what proves the game will read it as an AddMany.
const MANIFEST = 'c:/mods/example/mod.rules';
const DATA_ROOT = 'c:/game/Data';
const TERRAN = 'c:/game/Data/ships/terran/terran.rules';

/** Applies one insert to the manifest text, the way the command's single edit does. */
const applied = (text: string, entry: { before: string; after: string; offset: number }, body: string): string =>
    text.slice(0, entry.offset) + entry.before + body + entry.after + text.slice(entry.offset);

describe('the manifest action emitter', () => {
    it('expresses a ship Parts target against the game data root, with forward slashes', () => {
        expect(shipPartsTargetPath(DATA_ROOT, TERRAN, 'Terran')).toBe('<ships/terran/terran.rules>/Terran/Parts');
    });

    it('emits an entry the action parser reads back as one AddMany with its target and list source', () => {
        const text = ['Actions', '[', addManyActionText('<a.rules>/A/Parts', '&<parts/x.rules>/Part', '\t'), ']', ''].join(
            '\n'
        );
        const actions = parseModActions(parseText(text, MANIFEST));
        expect(actions).toHaveLength(1);
        expect(actions[0].type).toBe('AddMany');
        expect(actions[0].targets.map((node) => String(node.valueType.value))).toEqual(['<a.rules>/A/Parts']);
        expect(actions[0].sources).toHaveLength(1);
        const source = actions[0].sources[0];
        expect(isListNode(source) && source.elements).toHaveLength(1);
        expect(actions[0].presentFields.has('addto')).toBe(true);
        expect(actions[0].presentFields.has('manytoadd')).toBe(true);
    });

    it('appends into an existing Actions list, keeping the last entry indentation and line ending', () => {
        const text = ['Actions', '[', '\t{', '\t\tAction = Remove', '\t\tRemove = "<a.rules>/A"', '\t}', ']', ''].join(
            '\r\n'
        );
        const insert = manifestActionInsert(text, parseText(text, MANIFEST), '\r\n');
        expect(insert.kind).toBe('append');
        if (insert.kind === 'unusable') throw new Error('the manifest should have been appendable');
        expect(insert.indent).toBe('\t');
        const body = addManyActionText('<a.rules>/A/Parts', '&<parts/x.rules>/Part', insert.indent, '\r\n');
        const rewritten = applied(text, insert, body);
        expect(rewritten.includes('\n\r')).toBe(false);
        const actions = parseModActions(parseText(rewritten, MANIFEST));
        expect(actions.map((action) => action.type)).toEqual(['Remove', 'AddMany']);
    });

    it('opens the first entry of an empty Actions list on its own line', () => {
        const text = 'Actions\n[\n]\n';
        const insert = manifestActionInsert(text, parseText(text, MANIFEST));
        if (insert.kind === 'unusable') throw new Error('an empty list should have been appendable');
        const rewritten = applied(text, insert, addManyActionText('<a.rules>/A/Parts', '&<x.rules>/Part', insert.indent));
        expect(parseModActions(parseText(rewritten, MANIFEST))).toHaveLength(1);
    });

    it('writes a fresh top-level Actions list when the manifest declares none', () => {
        const text = 'ID = test.mod\nName = "Test"\n';
        const insert = manifestActionInsert(text, parseText(text, MANIFEST));
        expect(insert.kind).toBe('createList');
        if (insert.kind === 'unusable') throw new Error('a manifest without Actions should get one');
        const rewritten = applied(text, insert, addManyActionText('<a.rules>/A/Parts', '&<x.rules>/Part', insert.indent));
        const document = parseText(rewritten, MANIFEST);
        expect(findActionsList(document)).toBeDefined();
        expect(parseModActions(document)).toHaveLength(1);
        // The manifest's own fields survive, which a fresh list appended at the end must not disturb.
        expect(rewritten.startsWith(text)).toBe(true);
    });

    it('refuses a manifest whose Actions is not a list rather than writing a second one', () => {
        // An included fragment is pulled in whole, and a second `Actions` beside it is a duplicate
        // member the game would read as an error.
        const text = 'ID = test.mod\nActions : &<launcher.rules>/Actions\n';
        expect(manifestActionInsert(text, parseText(text, MANIFEST)).kind).toBe('unusable');
    });
});
