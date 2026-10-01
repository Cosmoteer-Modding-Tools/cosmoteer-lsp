import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    collectPartComponentIds,
    invalidateComponentIdCache,
} from '../../../src/features/diagnostics/validator.schema-sibling';
import { ReverseIncludeIndex } from '../../../src/mod/reverse-include.index';

const token = CancellationToken.None;

// Finding the parts that include a fragment reads every file naming it, which used to run again on
// every keystroke in the fragment. The includers only change when another file does, so an edit to
// the fragment keeps them and any other change drops them.
describe('the cross-file roots of a part-wide component union', () => {
    afterEach(() => ReverseIncludeIndex.instance.reset());

    it('survive an edit to the document itself and not a change to another file', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'compids-'));
        try {
            writeFileSync(
                join(dir, 'part.rules'),
                'Part\n{\n\tComponents\n\t{\n\t\tFromIncluder { Type = UIToggle }\n\t\tModes\n\t\t{\n\t\t\tType = ToggledComponents\n\t\t\tComponents = &<frag.rules>/Components\n\t\t}\n\t}\n}\n'
            );
            const fragPath = join(dir, 'frag.rules');
            const fragText = 'Components\n{\n\tOwn { Type = UIToggle }\n}\n';
            writeFileSync(fragPath, fragText);
            const fragUri = pathToFileURL(fragPath).href;
            // Every keystroke parses a new tree, which the per-tree memo never answers for.
            const idsOfFreshParse = async (): Promise<Set<string>> =>
                (await collectPartComponentIds(parser(lexer(fragText), fragUri).value, token)).all;

            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);
            expect(await idsOfFreshParse()).toContain('fromincluder');

            // The includer is gone from the index, but only the fragment itself was edited.
            ReverseIncludeIndex.instance.reset();
            invalidateComponentIdCache(fragUri);
            expect(await idsOfFreshParse()).toContain('fromincluder');

            invalidateComponentIdCache(pathToFileURL(join(dir, 'part.rules')).href);
            expect(await idsOfFreshParse()).not.toContain('fromincluder');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
