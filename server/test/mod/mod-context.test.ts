import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument } from '../../src/core/ast/ast';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { parseFilePath } from '../../src/utils/ast.utils';
import { findModRoot, clearModRootCache } from '../../src/mod/mod-root';
import { invalidateModContext, resolveFromModContextOnly, resolveWithModContext } from '../../src/mod/mod-context';
import { FullNavigationStrategy } from '../../src/features/navigation/full.navigation-strategy';
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

    // `OTGroupNode` keys its children with InvariantCultureIgnoreCase, so the game finds a global
    // whatever case the reference spells it in.
    it('matches a mod-added global ignoring case, the way the game looks nodes up', async () => {
        expect(valueOf(await resolveWithModContext('/foo/Bar', node, token))).toBe(7);
    });

    // The `Add` that creates this member lives in an included action fragment, not in the manifest
    // itself. A later action into the member is only valid because that fragment ran first.
    it('resolves a member an action fragment adds to a vanilla file', async () => {
        expect(valueOf(await resolveWithModContext('<indicators/indicators.rules>/FragmentAdded/Bar', node, token))).toBe(
            7
        );
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

    // A file-root `Add` (`AddTo=<indicators/indicators.rules> Name=SWAddedIndicator`) puts the member
    // in the same place a whole-file Override would, so both spellings of the reference must find it:
    // the direct file path, and the vanilla global that aliases the file.
    it('resolves a MOD-added member of a vanilla file through the vanilla global that aliases it', async () => {
        expect(await resolveWithModContext('/INDICATORS/SWAddedIndicator', node, token)).not.toBeNull();
    });

    it('resolves that same file-root addition named through a DIRECT file reference', async () => {
        expect(await resolveWithModContext('<indicators/indicators.rules>/SWAddedIndicator', node, token)).not.toBeNull();
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

// A mod-added global reached through a first hop vanilla CAN resolve: the alias value, the
// inheritance base and the list element all point at `/FOO`, so continuing the path past them fails
// unless the nested hop falls back to the mod context the way the outermost one does.
describe('nested hops resolve through the mod context', () => {
    const navigation = new FullNavigationStrategy();
    let document: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        clearModRootCache();
        invalidateModContext();
        document = (await parseFilePath(join(MOD_DIR, 'nested_refs.rules'))) as AbstractNodeDocument;
    });

    // The return type is inferred rather than written as `unknown`: `valueOf` takes the node shapes
    // navigation answers, and `unknown` is assignable to none of them.
    const navigate = (path: string) => navigation.navigate(path, document.elements[0], document.uri, token);

    it('continues past an alias whose value is a mod-added global (`ALIAS = &/FOO` then `&ALIAS/Bar`)', async () => {
        expect(valueOf(await navigate('&ALIAS/Bar'))).toBe(7);
    });

    it('finds a member through an inheritance base that is a mod-added global (`BASE : &/FOO`)', async () => {
        expect(valueOf(await navigate('&BASE/Bar'))).toBe(7);
    });

    it('continues past a list element that is a mod-added global (`&ELEMENTS/0/Bar`)', async () => {
        expect(valueOf(await navigate('&ELEMENTS/0/Bar'))).toBe(7);
    });

    it('still answers nothing for a member none of them provides', async () => {
        expect(await navigate('&ALIAS/NotAThing')).toBeNull();
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
