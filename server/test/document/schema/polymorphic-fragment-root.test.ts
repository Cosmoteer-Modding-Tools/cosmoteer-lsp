import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ReverseIncludeIndex } from '../../../src/mod/reverse-include.index';
import { invalidateSchemaContextCache } from '../../../src/document/schema/schema-context';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import { Completion } from '../../../src/features/completion/autocompletion.service.types';

// A component split into its own file is pulled in by a `Components` member, whose declared type is
// the component registry rather than one class. The slot alone cannot say which component this is,
// so the file's own `Type=` picks it, inside that registry and nowhere else.
const token = CancellationToken.None;
const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Field names offered at the top level of a fragment a part's `Components` map includes. */
const fragmentFieldNames = async (fragment: string): Promise<string[]> => {
    const dir = mkdtempSync(join(tmpdir(), 'poly-root-'));
    dirs.push(dir);
    const partDir = join(dir, 'parts', 'my_part');
    mkdirSync(partDir, { recursive: true });
    writeFileSync(
        join(partDir, 'my_part.rules'),
        'Part\n{\n\tID = my_part\n\tComponents\n\t{\n\t\tIncluded = &<component.rules>\n\t}\n}\n'
    );
    writeFileSync(join(partDir, 'component.rules'), fragment);
    ReverseIncludeIndex.instance.reset();
    await ReverseIncludeIndex.instance.ensureBuilt([dir], token);
    invalidateSchemaContextCache();
    const path = join(partDir, 'component.rules');
    const source = readFileSync(path, 'utf8');
    const document = parser(lexer(source), pathToFileURL(path).href).value;
    const offered: Completion[] = await schemaFieldNameCompletions(document, source.length - 1, token);
    return offered.map((completion) => (typeof completion === 'string' ? completion : completion.label));
};

describe('a fragment included into a component map', () => {
    it('is typed by the component its own Type names', async () => {
        expect(await fragmentFieldNames('Type = StaticValue\n')).toContain('Value');
    });

    // `SetValue` is a particle-data updater, not a component, so the slot's registry does not declare
    // it. Picking the class by the word alone would type the whole file as something it is not.
    it('stays untyped when the Type belongs to another registry', async () => {
        expect(await fragmentFieldNames('Type = SetValue\n')).toEqual([]);
    });
});
