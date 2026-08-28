import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { join } from 'path';
import { readFileSync } from 'fs';
import { parseText } from '../../../src/utils/ast.utils';
import { buildPartGridEdit } from '../../../src/features/part-editor/grid-edit.service';
import { buildPartGridData } from '../../../src/features/part-editor/part-grid-data.service';
import { countReadersOf } from '../../../src/features/part-editor/reference-writeback';
import { GridMutation, PartGridEditResult } from '../../../src/features/part-editor/part-grid.types';
import { FIXTURES_DIR } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

// A part that says its geometry is a named constant means it. A grid edit follows the reference to
// the declaration and writes the number there, in whichever file of this mod declares it, instead of
// pasting a literal over the reference and unbinding the two.
const token = CancellationToken.None;
const derivedPath = join(FIXTURES_DIR, 'part-editor', 'derived_part.rules');
const modDir = join(FIXTURES_DIR, 'part-editor-refmod');
const partPath = join(modDir, 'ref_part.rules');
const constantsPath = join(modDir, 'constants.rules');
const squarePath = join(modDir, 'square_part.rules');

/** Applies LSP text edits to a source string. */
const applyEdits = (
    text: string,
    edits: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>
): string => {
    const toOffset = (position: { line: number; character: number }): number => {
        let line = 0;
        let offset = 0;
        while (line < position.line) {
            offset = text.indexOf('\n', offset) + 1;
            line++;
        }
        return offset + position.character;
    };
    const resolved = edits
        .map((edit) => ({ start: toOffset(edit.range.start), end: toOffset(edit.range.end), newText: edit.newText }))
        .sort((a, b) => b.start - a.start);
    let result = text;
    for (const { start, end, newText } of resolved) {
        result = result.slice(0, start) + newText + result.slice(end);
    }
    return result;
};

/** Runs one mutation against a fixture part and hands back the raw result. */
const mutate = async (path: string, mutation: GridMutation): Promise<PartGridEditResult> => {
    const text = readFileSync(path, 'utf-8');
    return buildPartGridEdit(parseText(text, path), text, path, 0, mutation, token);
};

/** The text of a file after a result's edits for it are applied. */
const edited = (result: PartGridEditResult, path: string): string =>
    applyEdits(readFileSync(path, 'utf-8'), result.edit!.changes![path] ?? []);

describe('grid edits through references', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('writes a rect component into the constant it is declared by, and leaves the rest alone', async () => {
        // `SaveRect = [0, 0, &~/SIZE/0, &~/SIZE/1]`: widening it writes `SIZE`, and the three
        // components the drag did not change produce no edit at all.
        const result = await mutate(derivedPath, {
            op: 'setRect',
            layerId: 'SaveRect',
            rect: { x: 0, y: 0, width: 3, height: 2 },
        });
        expect(result.status, result.message).toBe('ok');
        expect(result.edit!.changes![derivedPath]).toHaveLength(1);
        const text = edited(result, derivedPath);
        expect(text).toContain('SIZE = [3, 2]');
        expect(text).toContain('SaveRect = [0, 0, &~/SIZE/0, &~/SIZE/1]');
        expect(result.note).toContain('derived_part.rules');
    });

    it('follows a whole-value reference into another file of the same mod', async () => {
        const result = await mutate(partPath, {
            op: 'setRect',
            layerId: 'SaveRect',
            rect: { x: 0, y: 0, width: 4, height: 2 },
        });
        expect(result.status, result.message).toBe('ok');
        // The part's own file is untouched: the sentence it wrote still holds, the number moved.
        expect(result.edit!.changes![partPath] ?? []).toHaveLength(0);
        expect(edited(result, constantsPath)).toContain('SIZE_RECT = [0, 0, 4, 2]');
        expect(result.note).toBeTruthy();
    });

    it('moves a component cell through the constant that declares it', async () => {
        // The port has to render before it can be dragged at all, so the payload is asserted too.
        const text = readFileSync(partPath, 'utf-8');
        const data = (await buildPartGridData(parseText(text, partPath), 0, 1, token))!;
        const port = data.layers.find((layer) => layer.id === 'Components/port/Location');
        expect((port as { cell?: unknown }).cell).toEqual({ x: 0, y: 1 });

        const result = await mutate(partPath, {
            op: 'setCell',
            layerId: 'Components/port/Location',
            cell: { x: 1, y: 1 },
        });
        expect(result.status, result.message).toBe('ok');
        expect(edited(result, constantsPath)).toContain('PORT_CELL = [1, 1]');
        expect(edited(result, partPath)).toContain('Location = &<./constants.rules>/PORT_CELL');
    });

    it('reads and resizes a Size written as a reference', async () => {
        // A part sized from a constant renders at that size rather than falling back to one cell,
        // and resizing it writes the constant.
        const text = readFileSync(partPath, 'utf-8');
        const data = (await buildPartGridData(parseText(text, partPath), 0, 1, token))!;
        expect(data.size.width).toBe(1);
        expect(data.size.height).toBe(2);

        const result = await mutate(partPath, { op: 'setSize', size: { width: 3, height: 2 } });
        expect(result.status, result.message).toBe('ok');
        expect(result.edit!.changes![partPath] ?? []).toHaveLength(0);
        expect(edited(result, constantsPath)).toContain('SIZE = [3, 2]');
    });

    it('changes every field the declaration drives, and says how many read it', async () => {
        // `SIZE` is both the part's `Size` and the width and height of its `PhysicalRect`. Widening
        // the rect is a statement about `SIZE`, so the part's own size follows it, which is what the
        // file already said. The note counts the readers so the reach of the drag is visible.
        const result = await buildPartGridEdit(
            parseText(readFileSync(partPath, 'utf-8'), partPath),
            readFileSync(partPath, 'utf-8'),
            partPath,
            0,
            { op: 'setRect', layerId: 'PhysicalRect', rect: { x: 0, y: 0, width: 4, height: 2 } },
            token,
            { countReaders: (declaration, uri) => countReadersOf(declaration, uri, [modDir], token) }
        );
        expect(result.status, result.message).toBe('ok');
        const constants = edited(result, constantsPath);
        expect(constants).toContain('SIZE = [4, 2]');
        // Three sites read it: the part's Size and both components of its PhysicalRect.
        expect(result.note).toContain('3');
    });

    it('writes one number once when a tuple reads the same declaration twice', async () => {
        // A square part sized `[&SQUARE, &SQUARE]` asks for the same number twice. That is one edit,
        // not a conflict.
        const square = readFileSync(squarePath, 'utf-8');
        const result = await buildPartGridEdit(
            parseText(square, squarePath),
            square,
            squarePath,
            0,
            { op: 'setSize', size: { width: 3, height: 3 } },
            token
        );
        expect(result.status, result.message).toBe('ok');
        expect(result.edit!.changes![constantsPath]).toHaveLength(1);
        expect(edited(result, constantsPath)).toContain('SQUARE = 3');
    });

    it('refuses a tuple whose two components are one declaration asked for different numbers', async () => {
        const square = readFileSync(squarePath, 'utf-8');
        const result = await buildPartGridEdit(
            parseText(square, squarePath),
            square,
            squarePath,
            0,
            { op: 'setSize', size: { width: 3, height: 4 } },
            token
        );
        expect(result.status).toBe('error');
        expect(result.message).toContain('cannot differ');
    });

    it('names the files the view is read from, so a change in one of them re-renders', async () => {
        // The part states its size, its rect and a port cell as references into `constants.rules`.
        // Editing any of them changes the picture without touching the part's own file, so the host
        // has to watch that file too.
        const text = readFileSync(partPath, 'utf-8');
        const data = (await buildPartGridData(parseText(text, partPath), 0, 1, token))!;
        expect(data.dependsOn.some((uri) => uri.endsWith('constants.rules'))).toBe(true);
        expect(data.dependsOn.some((uri) => uri.endsWith('ref_part.rules'))).toBe(false);
    });

    it('refuses a declaration that lives outside this mod', async () => {
        const result = await mutate(partPath, {
            op: 'setCell',
            layerId: 'Components/far/Location',
            cell: { x: 1, y: 1 },
        });
        expect(result.status).toBe('error');
        expect(result.message).toContain('outside this mod');
    });

    it('writes the reader count into the note when the host supplies one', async () => {
        const text = readFileSync(derivedPath, 'utf-8');
        const result = await buildPartGridEdit(
            parseText(text, derivedPath),
            text,
            derivedPath,
            0,
            { op: 'setRect', layerId: 'SaveRect', rect: { x: 0, y: 0, width: 3, height: 2 } },
            token,
            { countReaders: async () => 4 }
        );
        expect(result.status, result.message).toBe('ok');
        expect(result.note).toContain('4');
    });
});
