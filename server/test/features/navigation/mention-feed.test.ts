import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { MentionIndex } from '../../../src/features/navigation/mention.index';
import { FIXTURES_DIR } from '../../helpers';

const token = CancellationToken.None;
const folder = join(FIXTURES_DIR, 'reachability-mod');
const deadFile = join(folder, 'orphan', 'dead.rules');

describe('MentionIndex disk-text feed', () => {
    beforeEach(() => MentionIndex.instance.reset());

    it('keeps a pre-fed entry through the first folder bind and answers from it', async () => {
        const info = statSync(deadFile);
        MentionIndex.instance.ingestDiskText(deadFile, info.size, info.mtimeMs, readFileSync(deadFile, 'utf-8'));
        const paths = await MentionIndex.instance.candidateFiles('Dead', [folder], token);
        expect(paths).toBeDefined();
        expect(paths!.some((p) => p.replace(/\\/g, '/').endsWith('orphan/dead.rules'))).toBe(true);
    });

    it('re-reads a fed entry whose on-disk identity is stale instead of trusting it', async () => {
        MentionIndex.instance.ingestDiskText(deadFile, 1234567, 42, 'FabricatedWordNotOnDisk');
        const fabricated = await MentionIndex.instance.candidateFiles('FabricatedWordNotOnDisk', [folder], token);
        expect(fabricated).toEqual([]);
        const real = await MentionIndex.instance.candidateFiles('Dead', [folder], token);
        expect(real!.some((p) => p.replace(/\\/g, '/').endsWith('orphan/dead.rules'))).toBe(true);
    });
});
