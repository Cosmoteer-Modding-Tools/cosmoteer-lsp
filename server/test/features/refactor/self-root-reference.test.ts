import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { selfRootReferenceCodeAction } from '../../../src/features/refactor/self-root-reference';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { parseText } from '../../../src/utils/ast.utils';
import { FIXTURES_DIR } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;
const SELF = join(FIXTURES_DIR, 'self-ref', 'self.rules');

/** The offer for the caret on a marker in a file on disk. */
const offerIn = async (path: string, marker: string) => {
    const uri = filePathToUri(path);
    const text = readFileSync(path, 'utf8');
    const offset = text.indexOf(marker);
    if (offset < 0) throw new Error(`marker ${marker} not in ${path}`);
    const document = TextDocument.create(uri, 'rules', 0, text);
    return selfRootReferenceCodeAction(parseText(text, uri), document, document.positionAt(offset), uri, token);
};

describe('writing a reference to its own file as a self-rooted one', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('offers the ~ form for a reference naming the file it is written in', async () => {
        const action = await offerIn(SELF, '&<self.rules>/Root/Leaf');
        expect(action?.title).toContain('&~/Root/Leaf');
        expect(action?.edit?.changes?.[filePathToUri(SELF)]?.[0].newText).toBe('&~/Root/Leaf');
    });

    it('is not offered for a reference naming another file', async () => {
        expect(await offerIn(SELF, '&<other.rules>/Other/Leaf')).toBeUndefined();
    });

    it('is not offered for a reference naming a whole file', async () => {
        // `Whole = &<self.rules>` names the file itself, which `~` alone cannot stand for.
        expect(await offerIn(SELF, 'Whole = &<self.rules>')).toBeUndefined();
    });

    it('is not offered for a reference that resolves to nothing', async () => {
        expect(await offerIn(SELF, '&<self.rules>/NoSuchThing')).toBeUndefined();
    });
});
