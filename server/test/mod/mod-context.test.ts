import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode } from '../../src/core/ast/ast';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { parseFilePath } from '../../src/utils/ast.utils';
import { findModRoot, clearModRootCache } from '../../src/mod/mod-root';
import { invalidateModContext, resolveFromModContextOnly, resolveWithModContext } from '../../src/mod/mod-context';
import { ParserResultRegistrar } from '../../src/registrar/parser-result-registrar';
import { globalSettings } from '../../src/settings';
import { initWorkspace, valueOf, WORKSPACE_DATA_DIR } from '../workspace-helper';
import { FIXTURES_DIR } from '../helpers';

const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'mod');

describe('findModRoot', () => {
    it('walks up to the directory containing mod.rules', () => {
        clearModRootCache();
        const root = findModRoot(pathToFileURL(join(MOD_DIR, 'somefile.rules')).href);
        expect(root && root.replace(/\\/g, '/').toLowerCase()).toBe(MOD_DIR.replace(/\\/g, '/').toLowerCase());
    });

    it('returns null for a file not inside any mod', () => {
        clearModRootCache();
        expect(findModRoot(pathToFileURL(join(WORKSPACE_DATA_DIR, 'a.rules')).href)).toBeNull();
    });
});

describe('resolveWithModContext (effective game = vanilla + mod)', () => {
    let node: AbstractNode;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        clearModRootCache();
        invalidateModContext();
        // A node inside the mod, so findModRoot locates the mod and the super-path uses its context.
        node = await parseFilePath(join(MOD_DIR, 'somefile.rules'));
    });

    it('still resolves a vanilla super-path (RootMarker exists in the game cosmoteer.rules)', async () => {
        expect(valueOf(await resolveWithModContext('/RootMarker', node, token))).toBe(7);
    });

    it('resolves a global the mod ADDS to cosmoteer.rules via an Add action, drilling into its source', async () => {
        // `/FOO` does not exist in vanilla; the mod's `Add Name=FOO ToAdd=&<provider.rules>/Provider` adds it.
        expect(valueOf(await resolveWithModContext('/FOO/Bar', node, token))).toBe(7);
    });

    it('resolves a global declared in the mod’s own cosmoteer.rules', async () => {
        expect(valueOf(await resolveWithModContext('/GLOBAL_TWO/Bar', node, token))).toBe(7);
    });

    it('resolves a mod-added global as an action TARGET (`<cosmoteer.rules>/FOO` exists)', async () => {
        const result = await resolveWithModContext('<cosmoteer.rules>/FOO', node, token);
        expect(result).not.toBeNull();
    });

    it('returns null for a name that neither vanilla nor the mod provides', async () => {
        expect(await resolveWithModContext('/DEFINITELY_NOT_A_GLOBAL', node, token)).toBeNull();
    });

    // Cosmoteer group-merge: `MERGED = &<provider.rules>, &<provider2.rules>`. A member may live in
    // ANY of the merged files. The parser splits the comma-list into the named assignment plus a
    // bare value sibling; mod-context must search both, not just the first.
    it('resolves a member that lives in the FIRST file of a group-merge global', async () => {
        expect(valueOf(await resolveWithModContext('/MERGED/Provider/Bar', node, token))).toBe(7);
    });

    it('resolves a member that lives only in the SECOND file of a group-merge global', async () => {
        expect(valueOf(await resolveWithModContext('/MERGED/Baz/Qux', node, token))).toBe(9);
    });

    it('returns null for a member present in NONE of the merged files', async () => {
        expect(await resolveWithModContext('/MERGED/NotInEither', node, token)).toBeNull();
    });

    // Whole-file Override reached through a vanilla global: the mod's `Overrides
    // OverrideIn=<indicators/indicators.rules> Overrides=&<mod_indicators.rules>` merges `SWNoShields`
    // into the vanilla indicators file, which `&/INDICATORS` aliases. The member exists only in the
    // mod, so it resolves via the mod context. Mirrors the real SW mod's `&/INDICATORS/SWNo…` refs.
    it('resolves a vanilla member of a file reached through a vanilla global (`/INDICATORS/Scorched`)', async () => {
        expect(valueOf(await resolveWithModContext('/INDICATORS/Scorched/X', node, token))).toBe(5);
    });

    it('resolves a MOD-added member merged into a vanilla file via a whole-file Override', async () => {
        expect(valueOf(await resolveWithModContext('/INDICATORS/SWNoShields/Y', node, token))).toBe(42);
    });

    it('resolves the same mod-added member named through a DIRECT file reference', async () => {
        expect(valueOf(await resolveWithModContext('<indicators/indicators.rules>/SWNoShields/Y', node, token))).toBe(42);
    });

    it('returns null for a member that neither the vanilla file nor the mod override provides', async () => {
        expect(await resolveWithModContext('/INDICATORS/SWNotAThing', node, token)).toBeNull();
    });

    // Nested-global override: `OverrideIn=<cosmoteer.rules>/BASE_AUDIO` merges into the BASE_AUDIO
    // global, which itself aliases a whole file (`&<sounds/base_audio.rules>`). The mod-added member
    // must resolve through `&/BASE_AUDIO/…`. Mirrors the real SW mod's `<cosmoteer.rules>/COMMON_EFFECTS`.
    it('resolves a mod-added member merged into a file-aliasing GLOBAL via a nested Override target', async () => {
        expect(valueOf(await resolveWithModContext('/BASE_AUDIO/SWExtraSound/Z', node, token))).toBe(7);
    });

    it('still resolves the vanilla member of that aliased file (`/BASE_AUDIO/BaseAudio`, regression)', async () => {
        expect(await resolveWithModContext('/BASE_AUDIO/BaseAudio', node, token)).not.toBeNull();
    });
});

describe('ModContext prefers the in-editor buffer over disk (unsaved edits)', () => {
    let node: AbstractNode;
    const manifestPath = join(MOD_DIR, 'mod.rules');

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        node = await parseFilePath(join(MOD_DIR, 'somefile.rules'));
    });

    it('resolves a global added only in the unsaved manifest AST (not yet on disk)', async () => {
        // BAR is NOT in the on-disk fixture mod.rules; only this in-editor buffer adds it.
        const editedSrc =
            'Actions\n[\n\t{\n\t\tAction = Add\n\t\tAddTo = <cosmoteer.rules>\n\t\tName = BAR\n\t\tToAdd = &<provider.rules>/Provider\n\t}\n]\n';
        ParserResultRegistrar.instance.setResult(manifestPath, parser(lexer(editedSrc), manifestPath).value);
        clearModRootCache();
        invalidateModContext();
        try {
            expect(valueOf(await resolveFromModContextOnly('/BAR/Bar', node, token))).toBe(7);
        } finally {
            ParserResultRegistrar.instance.removeResult(manifestPath);
            invalidateModContext();
        }
    });
});
