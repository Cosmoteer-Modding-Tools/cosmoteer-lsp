import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';
import { ReverseIncludeIndex } from '../../../src/mod/reverse-include.index';
import { invalidateSchemaContextCache } from '../../../src/document/schema/schema-context';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;

// A fragment file has no root of its own: the emitter beside it pulls it in with
// `Def = &<…>`, which is a `group<ParticleSystemDef>` slot, so the reverse-include index is what
// gives the fragment its class. That is the shape a shot file, a buff file or an action-wired
// override has too, and the top level of all of them used to be the one place the schema went
// blind while hover and completion typed it.
const EMITTER = ['Type = Particles', 'Def = &<body_def.rules>', ''].join('\n');

/** Writes the emitter and a fragment beside it, then validates the fragment as the server would. */
const fragmentFindings = async (fragment: string): Promise<string[]> => {
    const dir = mkdtempSync(join(tmpdir(), 'fragment-root-'));
    try {
        writeFileSync(join(dir, 'emitter.rules'), EMITTER);
        writeFileSync(join(dir, 'body_def.rules'), fragment);
        ReverseIncludeIndex.instance.reset();
        await ReverseIncludeIndex.instance.ensureBuilt([dir], token);
        invalidateSchemaContextCache();
        const path = join(dir, 'body_def.rules');
        const document = parser(lexer(readFileSync(path, 'utf8')), pathToFileURL(path).href).value;
        return (await validateSchema(document, token)).map((error) => error.message);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

describe('validateSchema over a fragment rooted by the file that includes it', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    afterEach(() => {
        ReverseIncludeIndex.instance.reset();
        invalidateSchemaContextCache();
    });

    it('flags a top-level enum value the included class does not have', async () => {
        const findings = await fragmentFindings(
            ['DeleteMode = NotAMode', 'EmitPerOneShot = 4', 'InitCapacity = 8', ''].join('\n')
        );
        expect(findings).toHaveLength(1);
        expect(findings[0]).toContain('NotAMode');
        expect(findings[0]).toContain('ParticleDeleteMode');
    });

    it('flags a fraction written into a top-level whole-number field', async () => {
        const findings = await fragmentFindings(
            ['DeleteMode = Fast', 'EmitPerOneShot = 2.5', 'InitCapacity = 8', ''].join('\n')
        );
        expect(findings).toHaveLength(1);
        expect(findings[0]).toContain('whole number');
    });

    it('says nothing about the same fields written correctly', async () => {
        expect(
            await fragmentFindings(['DeleteMode = Fast', 'EmitPerOneShot = 4', 'InitCapacity = 8', ''].join('\n'))
        ).toEqual([]);
    });

    it('says nothing when the including class owns only a minority of the fragment', async () => {
        // The include roots the file, but its content is some other shape entirely, so the class is
        // a mis-root rather than the fragment's own. Judging its members against that class is how a
        // false positive gets born, so the fit check refuses it and every member stays unjudged.
        expect(
            await fragmentFindings(
                ['DeleteMode = NotAMode', 'Range = 300', 'Duration = 5', 'HitInterval = 0.1', ''].join('\n')
            )
        ).toEqual([]);
    });
});
