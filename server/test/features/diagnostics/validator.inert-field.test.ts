import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateInertFields } from '../../../src/features/diagnostics/validator.inert-field';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const PART_PATH = workspaceFile('parts', 'inert_part.rules');
const token = CancellationToken.None;

const findings = async (text: string): Promise<string[]> =>
    (await validateInertFields(parser(lexer(text), PART_PATH).value, token)).map((error) => error.message);

/** A part holding one component, which is what gives the members inside it a class to resolve to. */
const part = (component: string): string =>
    ['Part', '{', '\tID = inert_part', '\tComponents', '\t{', component, '\t}', '}', ''].join('\n');

// The game reads a converter's quantity shorthands inside the branch the storage shorthand opened,
// so writing one beside the list form reaches nothing at all.
describe('a field the group switches off', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('is faded when the sibling that would switch it on is not written', async () => {
        const messages = await findings(
            part(
                [
                    '\t\tconverter',
                    '\t\t{',
                    '\t\t\tType = ResourceConverter',
                    '\t\t\tFrom [ { Storage = ammo; Quantity = 1 } ]',
                    '\t\t\tTo [ { Storage = preloader; Quantity = 1 } ]',
                    '\t\t\tMinFromQuantityForConversion = 1',
                    '\t\t}',
                ].join('\n')
            )
        );
        expect(messages).toEqual([
            "'MinFromQuantityForConversion' has no effect unless 'FromStorage' is written in the same group.",
        ]);
    });

    it('is left alone once that sibling is written', async () => {
        expect(
            await findings(
                part(
                    [
                        '\t\tconverter',
                        '\t\t{',
                        '\t\t\tType = ResourceConverter',
                        '\t\t\tFromStorage = ammo',
                        '\t\t\tMinFromQuantityForConversion = 1',
                        '\t\t}',
                    ].join('\n')
                )
            )
        ).toEqual([]);
    });

    it('is left alone when the group inherits, since a base can supply the sibling', async () => {
        expect(
            await findings(
                part(
                    [
                        '\t\tconverter : <./Data/parts/base_converter.rules>/Converter',
                        '\t\t{',
                        '\t\t\tType = ResourceConverter',
                        '\t\t\tMinFromQuantityForConversion = 1',
                        '\t\t}',
                    ].join('\n')
                )
            )
        ).toEqual([]);
    });

    it('carries a remove fix over the whole assignment', async () => {
        const text = part(
            [
                '\t\tconverter',
                '\t\t{',
                '\t\t\tType = ResourceConverter',
                '\t\t\tTo [ { Storage = preloader } ]',
                '\t\t\tToQuantity = 2',
                '\t\t}',
            ].join('\n')
        );
        const [error] = await validateInertFields(parser(lexer(text), PART_PATH).value, token);
        expect(error?.unnecessary).toBe(true);
        expect(text.slice(error!.data!.remove!.start, error!.data!.remove!.end)).toBe('ToQuantity = 2');
    });

    it('is left alone when a reference in the file reads the name', async () => {
        const text = [
            'SHARED = &/Part/Components/converter/ToQuantity',
            part(
                [
                    '\t\tconverter',
                    '\t\t{',
                    '\t\t\tType = ResourceConverter',
                    '\t\t\tTo [ { Storage = preloader } ]',
                    '\t\t\tToQuantity = 2',
                    '\t\t}',
                ].join('\n')
            ),
        ].join('\n');
        expect(await findings(text)).toEqual([]);
    });
});
