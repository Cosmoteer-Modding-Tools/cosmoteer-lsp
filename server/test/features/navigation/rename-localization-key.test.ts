import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Position, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { keyDeclarationsOf } from '../../../src/features/completion/localization-key.index';
import { RenameService } from '../../../src/features/navigation/rename.service';
import { stringValueNodesOf } from '../../../src/features/navigation/schema-reference.navigation';
import { RenameRefusedError } from '../../../src/features/refactor/rename-localization-key';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { FIXTURES_DIR } from '../../helpers';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';

// Renaming a localization key has to move it everywhere at once: the declaration in every language
// file the mod ships, and every field that points at it. The fixture mod carries one key per shape
// the sweep has to get right, so a rename that quietly leaves half the mod behind fails here.
const service = RenameService.instance;
const token = CancellationToken.None;

const MOD_DIR = join(FIXTURES_DIR, 'localization-rename-mod');
const FOLDERS = [MOD_DIR, WORKSPACE_DATA_DIR];

const modFile = (...segments: string[]): string => join(MOD_DIR, ...segments);

/** The edits a workspace edit makes to the file whose path ends in `suffix`, in document order. */
const editsIn = (edit: WorkspaceEdit | null, suffix: string): TextEdit[] => {
    const uri = Object.keys(edit?.changes ?? {}).find((each) =>
        decodeURIComponent(each).replace(/\\/g, '/').toLowerCase().endsWith(suffix.toLowerCase())
    );
    return uri ? edit!.changes![uri] : [];
};

/** Every file a workspace edit touches, by its path suffix inside the fixture mod. */
const touchedFiles = (edit: WorkspaceEdit | null): string[] =>
    Object.keys(edit?.changes ?? {})
        .map((each) => decodeURIComponent(each).replace(/\\/g, '/'))
        .map((path) => path.slice(path.lastIndexOf('/') + 1))
        .sort();

/** The caret placed on the name a strings file declares `path` under. */
const declarationCaret = (document: AbstractNodeDocument, path: string): Position => {
    for (const declaration of keyDeclarationsOf(document)) {
        if (declaration.path !== path || !declaration.nameNode) continue;
        return { line: declaration.nameNode.position.line, character: declaration.nameNode.position.characterStart };
    }
    throw new Error(`no declaration of ${path}`);
};

/** The caret placed inside the written key `written`, `offset` characters into the key itself. */
const usageCaret = (document: AbstractNodeDocument, written: string, offset = 0): Position => {
    for (const node of stringValueNodesOf(document)) {
        if (String(node.valueType.value) !== written) continue;
        return { line: node.position.line, character: node.position.characterStart + 1 + offset };
    }
    throw new Error(`no value ${written}`);
};

/** The reason a rename was turned down, so a test can assert on the text the author reads. */
const refusal = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
    } catch (e) {
        if (e instanceof RenameRefusedError) return e.message;
        throw e;
    }
    throw new Error('expected the rename to be refused');
};

describe('localization key rename', () => {
    let en: AbstractNodeDocument;
    let de: AbstractNodeDocument;
    let partA: AbstractNodeDocument;
    let partB: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        en = await parseFilePath(modFile('strings', 'en.rules'));
        de = await parseFilePath(modFile('strings', 'de.rules'));
        partA = await parseFilePath(modFile('parts', 'a.rules'));
        partB = await parseFilePath(modFile('parts', 'b.rules'));
    });

    it('reads a strings file the same way the key index does', () => {
        const declared = [...keyDeclarationsOf(en)].filter((each) => each.text !== undefined).map((each) => each.path);
        expect(declared).toEqual([
            'Parts/Foo',
            'Parts/FooDesc',
            'PartsExtra/Foo',
            'Titles/0',
            'Titles/1',
            'Greeting',
        ]);
        // The groups above the leaves are reported too, which is what a group rename moves.
        const groups = [...keyDeclarationsOf(en)].filter((each) => each.text === undefined).map((each) => each.path);
        expect(groups).toEqual(['Parts', 'PartsExtra', 'Titles']);
    });

    it('prepareRename offers the key name a strings file declares', async () => {
        const caret = declarationCaret(en, 'Parts/Foo');
        const prepared = await service.prepareRename(en, caret, token);
        expect(prepared?.placeholder).toBe('Foo');
        expect(prepared?.range.start.character).toBe(caret.character);
        expect(prepared?.range.end.character).toBe(caret.character + 'Foo'.length);
    });

    it('renames the declaration in every language file and every field pointing at it', async () => {
        const edit = await service.rename(en, declarationCaret(en, 'Parts/Foo'), 'Bar', FOLDERS, token);
        expect(touchedFiles(edit)).toEqual(['a.rules', 'b.rules', 'de.rules', 'en.rules']);

        expect(editsIn(edit, 'strings/en.rules').map((each) => each.newText)).toEqual(['Bar']);
        expect(editsIn(edit, 'strings/de.rules').map((each) => each.newText)).toEqual(['Bar']);

        // Only the NameKey moves. SomeText is not a localization key field, so its identical text is
        // left where it is, and DescriptionKey points at another key.
        const aEdits = editsIn(edit, 'parts/a.rules');
        expect(aEdits.length).toBe(1);
        expect(aEdits[0].range.start.line).toBe(usageCaret(partA, 'Parts/Foo').line);
        expect(aEdits[0].newText).toBe('Bar');

        // b.rules writes the key once. Its reference-valued NameKey names no key of its own, and the
        // part pointing at the neighbouring group is a different key.
        const bEdits = editsIn(edit, 'parts/b.rules');
        expect(bEdits.length).toBe(1);
        expect(bEdits[0].range.start.line).toBe(usageCaret(partB, 'Parts/Foo').line);
    });

    it('rewrites a key spelled in a different case than its declaration', async () => {
        // The game resolves a key path one case-insensitive step at a time, and vanilla itself relies
        // on it, so a field written `parts/fooDesc` points at the declared `Parts/FooDesc`.
        const edit = await service.rename(en, declarationCaret(en, 'Parts/FooDesc'), 'FooInfo', FOLDERS, token);

        const aEdits = editsIn(edit, 'parts/a.rules');
        expect(aEdits.length).toBe(1);
        expect(aEdits[0].range.start.line).toBe(usageCaret(partA, 'parts/fooDesc').line);
        // Only the last segment is rewritten, so the differently spelled `parts/` part stays as it is.
        expect(aEdits[0].range.end.character - aEdits[0].range.start.character).toBe('fooDesc'.length);
    });

    it('leaves a value alone when its text does not line up with the source it was read from', async () => {
        const edit = await service.rename(en, declarationCaret(en, 'Parts/FooDesc'), 'FooInfo', FOLDERS, token);
        const verbatim = [...stringValueNodesOf(partB)].find(
            (node) => String(node.valueType.value) === 'Parts/FooDesc' && node.position.end - node.position.start !== 15
        );
        expect(verbatim).toBeDefined();
        // The plainly written key is rewritten, the verbatim one is not, so exactly one edit lands.
        expect(editsIn(edit, 'parts/b.rules').length).toBe(1);
        expect(editsIn(edit, 'parts/b.rules')[0].range.start.line).not.toBe(verbatim!.position.line);
    });

    it('does not edit a language file that does not declare the key', async () => {
        // de.rules translates Parts/Foo but not Parts/FooDesc, which is what a half-translated mod
        // looks like. It contributes nothing rather than failing the rename.
        const edit = await service.rename(en, declarationCaret(en, 'Parts/FooDesc'), 'FooInfo', FOLDERS, token);
        expect(editsIn(edit, 'strings/de.rules')).toEqual([]);
        expect(editsIn(edit, 'strings/en.rules').length).toBe(1);
    });

    it('renames a key from the field that points at it', async () => {
        const edit = await service.rename(partA, usageCaret(partA, 'Parts/Foo', 'Parts/'.length), 'Bar', FOLDERS, token);
        expect(touchedFiles(edit)).toEqual(['a.rules', 'b.rules', 'de.rules', 'en.rules']);
        expect(editsIn(edit, 'strings/en.rules').map((each) => each.newText)).toEqual(['Bar']);
    });

    it('prepareRename on a written key offers the segment, not the field name', async () => {
        const prepared = await service.prepareRename(partA, usageCaret(partA, 'Parts/Foo', 'Parts/'.length), token);
        expect(prepared?.placeholder).toBe('Foo');
        // The old behaviour offered to rename the schema field `NameKey`, which is not the author's.
        expect(prepared?.range.start.character).toBe(usageCaret(partA, 'Parts/Foo', 'Parts/'.length).character);
    });

    it('renames a group by moving the whole branch under it', async () => {
        const edit = await service.rename(en, declarationCaret(en, 'Parts'), 'Bits', FOLDERS, token);
        // Only the group's own name changes, in each language file that has the group.
        expect(editsIn(edit, 'strings/en.rules').map((each) => each.newText)).toEqual(['Bits']);
        expect(editsIn(edit, 'strings/de.rules').map((each) => each.newText)).toEqual(['Bits']);
        // Every field under the group is repointed, whatever case it wrote the prefix in.
        expect(editsIn(edit, 'parts/a.rules').length).toBe(2);
        expect(editsIn(edit, 'parts/b.rules').length).toBe(2);
        for (const each of [...editsIn(edit, 'parts/a.rules'), ...editsIn(edit, 'parts/b.rules')]) {
            expect(each.range.start.character).toBeGreaterThan(0);
            expect(each.range.end.character - each.range.start.character).toBe('Parts'.length);
        }
    });

    it('leaves a sibling group whose name merely starts the same alone', async () => {
        const edit = await service.rename(en, declarationCaret(en, 'Parts'), 'Bits', FOLDERS, token);
        const other = usageCaret(partB, 'PartsExtra/Foo');
        expect(editsIn(edit, 'parts/b.rules').some((each) => each.range.start.line === other.line)).toBe(false);
        // PartsExtra is declared right after Parts in both language files and keeps its name.
        expect(editsIn(edit, 'strings/en.rules').length).toBe(1);
        expect(editsIn(edit, 'strings/de.rules').length).toBe(1);
    });

    it('refuses a string found by its position in a list', async () => {
        const caret = usageCaret(en, 'First');
        expect(await refusal(() => service.prepareRename(en, caret, token))).toContain('position in the list');
        expect(await refusal(() => service.rename(en, caret, 'Opening', FOLDERS, token))).toContain(
            'position in the list'
        );
    });

    it('refuses a list position written into a field', async () => {
        // `Titles/0` is how the game names the first entry of a list of strings, exactly as vanilla
        // writes `FameTitles/0`. The trailing segment is a position, so it has no name to rewrite.
        const caret = usageCaret(partA, 'Titles/0', 'Titles/'.length);
        expect(await refusal(() => service.prepareRename(partA, caret, token))).toContain('not a plain name');
    });

    it('refuses anywhere in a strings file that is not a key name', async () => {
        const language = { line: 2, character: 2 };
        expect(await refusal(() => service.prepareRename(en, language, token))).toContain('caret on the name');
        const text = usageCaret(en, 'Foo part');
        expect(await refusal(() => service.prepareRename(en, text, token))).toContain('caret on the name');
    });

    it('refuses a key the base game also declares', async () => {
        // The fixture game tree declares Greeting too, and that file is not the mod's to write.
        const caret = declarationCaret(en, 'Greeting');
        const message = await refusal(() => service.rename(en, caret, 'Welcome', FOLDERS, token));
        expect(message).toContain('Greeting');
        expect(message.toLowerCase()).toContain('data/strings/en.rules');
    });

    it('refuses a name another key already uses', async () => {
        const message = await refusal(() =>
            service.rename(en, declarationCaret(en, 'Parts/Foo'), 'FooDesc', FOLDERS, token)
        );
        expect(message).toContain('Parts/FooDesc');
    });

    it('refuses a name the game would not read as one step of a key path', async () => {
        const caret = declarationCaret(en, 'Parts/Foo');
        for (const name of ['0Bad', 'Bad Name', '..', 'Parts/Foo']) {
            expect(await refusal(() => service.rename(en, caret, name, FOLDERS, token))).toContain('has to start');
        }
    });

    it('refuses a rename started outside any mod', async () => {
        const outside = await parseFilePath(join(WORKSPACE_DATA_DIR, 'strings', 'en.rules'));
        const caret = declarationCaret(outside, 'Greeting');
        expect(await refusal(() => service.rename(outside, caret, 'Welcome', FOLDERS, token))).toContain(
            'not inside a mod'
        );
    });

    it('leaves the other rename kinds alone', async () => {
        // A part id is not a localization key, so the id rename still answers for it.
        const prepared = await service.prepareRename(partA, usageCaret(partA, 'Parts/Foo', -1), token);
        expect(prepared).not.toBeNull();
    });
});
