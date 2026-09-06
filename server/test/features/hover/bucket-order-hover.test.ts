import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { bucketOrderHover } from '../../../src/features/hover/bucket-order-hover';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { findNodeAtPosition } from '../../../src/utils/ast.utils';
import { FIXTURES_DIR } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'bucket-mod');
const EFFECT = join(MOD_DIR, 'effect.rules');

/** The hover for the value of a field in the effect fixture. */
const hoverFor = async (field: string): Promise<string | null> => {
    const text = readFileSync(EFFECT, 'utf8');
    const document = parser(lexer(text), filePathToUri(EFFECT)).value;
    const offset = text.indexOf('= ', text.indexOf(`${field} =`)) + 2;
    const before = text.slice(0, offset).split('\n');
    const node = findNodeAtPosition(document, { line: before.length - 1, character: before[before.length - 1].length });
    return node ? bucketOrderHover(node, [pathToFileURL(MOD_DIR).href], token) : null;
};

describe('media effect bucket draw order on hover', () => {
    beforeAll(async () => {
        await initWorkspace();
        SchemaIdIndex.instance.reset();
    });

    afterAll(() => SchemaIdIndex.instance.reset());

    it('names the list, the place in it, and what the bucket draws between', async () => {
        const hover = await hoverFor('Bucket');
        expect(hover).toContain('`LowerBuckets`');
        expect(hover).toContain('#2 of 3');
        expect(hover).toContain('draws over `BulletLower1`');
        expect(hover).toContain('under `Lower1`');
    });

    it('says so when a list holds one bucket only', async () => {
        expect(await hoverFor('PenetratingBucket')).toContain('the only bucket in this list');
    });

    it('answers nothing for a field that is not a bucket', async () => {
        expect(await hoverFor('Type')).toBeNull();
    });
});
