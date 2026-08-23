import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { filePathToUri } from '../../../../src/features/navigation/navigation-strategy';
import {
    OverrideInModApplyResult,
    OverrideInModArgs,
    OverrideInModHost,
    OverrideInModScanResult,
    overrideInMod,
} from '../../../../src/features/refactor/override-in-mod/override-in-mod.command';
import { clearBaseFileCache } from '../../../../src/features/refactor/shared-base/base-index';
import { parseModActions } from '../../../../src/mod/action-parser';
import { clearModRootCache } from '../../../../src/mod/mod-root';
import { globalSettings } from '../../../../src/settings';
import { parseText } from '../../../../src/utils/ast.utils';
import { foldPathCase } from '../../../../src/workspace/fs-cache';
import { FIXTURES_DIR } from '../../../helpers';

// The command itself, against a stand-in game install and a handful of stand-in mods, so both
// rounds and every refusal are exercised without a real game and without writing into one.
const FIXTURE = join(FIXTURES_DIR, 'override-in-mod-mod').replace(/\\/g, '/');
const DATA_DIR = `${FIXTURE}/Data`;
const CANNON = `${DATA_DIR}/parts/cannon/cannon.rules`;
const STRINGS = `${DATA_DIR}/strings/en.rules`;
const MOD_DIR = `${FIXTURE}/mod`;
const MOD_MANIFEST = `${MOD_DIR}/mod.rules`;
const OVERRIDDEN_DIR = `${FIXTURE}/overridden`;
const TWO_MANIFEST_DIR = `${FIXTURE}/twomanifest`;
const FRAGMENT_DIR = `${FIXTURE}/fragmod`;
const PLAIN_DIR = `${FIXTURE}/plainfolder`;
const WRITTEN_FRAGMENTS = `${MOD_DIR}/overrides`;

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The byte offset of a member in the fixture part, which is what the offer anchors on. */
const offsetOf = (needle: string, path = CANNON): number => read(path).indexOf(needle) + 1;

/** The key the scan hands back for a mod, which is its root path folded the way paths are matched. */
const keyOf = (modRoot: string): string => foldPathCase(modRoot);

/** A host whose edits are captured instead of applied, so the fixture manifests are never written to. */
const makeHost = (
    options: { folders?: string[]; open?: TextDocument[]; applies?: boolean; dataRoot?: string | null } = {}
): OverrideInModHost & { changes: Record<string, TextEdit[]>; announced: string[] } => ({
    changes: {},
    announced: [],
    folderPaths: async () => options.folders ?? [MOD_DIR],
    openDocuments: () => options.open ?? [],
    dataRoot: () => (options.dataRoot === null ? undefined : (options.dataRoot ?? DATA_DIR)),
    applyEdit(changes) {
        Object.assign(this.changes, changes);
        return Promise.resolve(options.applies ?? true);
    },
    filesChanged(paths) {
        this.announced.push(...paths);
    },
});

/** The command's scan round, asserting it answered with candidates. */
const scan = async (args: OverrideInModArgs, host: OverrideInModHost): Promise<OverrideInModScanResult> => {
    const result = await overrideInMod(args, host, CancellationToken.None);
    if (result.kind !== 'scan') throw new Error('expected the scan round');
    return result;
};

/** The command's apply round, asserting it answered as an apply. */
const apply = async (args: OverrideInModArgs, host: OverrideInModHost): Promise<OverrideInModApplyResult> => {
    const result = await overrideInMod(args, host, CancellationToken.None);
    if (result.kind !== 'apply') throw new Error('expected the apply round');
    return result;
};

/** The manifest as it reads once the captured edit is applied to it. */
const manifestAfter = (host: { changes: Record<string, TextEdit[]> }, manifest = MOD_MANIFEST): string => {
    const document = TextDocument.create(filePathToUri(manifest), 'rules', 0, read(manifest));
    const edits = host.changes[document.uri];
    if (!edits) throw new Error('nothing was written to the manifest');
    return TextDocument.applyEdits(document, edits);
};

let wasAllowed: boolean;
let wasPath: string;

beforeEach(() => {
    clearBaseFileCache();
    clearModRootCache();
    wasAllowed = globalSettings.allowEditingVanillaFiles;
    wasPath = globalSettings.cosmoteerPath;
    globalSettings.allowEditingVanillaFiles = false;
    // The strings check consults the game folder to find the mods' own declared folders. The fixture
    // install stands in for it so the check answers from the fixture rather than from a real game.
    globalSettings.cosmoteerPath = DATA_DIR;
    rmSync(WRITTEN_FRAGMENTS, { recursive: true, force: true });
});

afterEach(() => {
    globalSettings.allowEditingVanillaFiles = wasAllowed;
    globalSettings.cosmoteerPath = wasPath;
    clearModRootCache();
    rmSync(WRITTEN_FRAGMENTS, { recursive: true, force: true });
});

describe('the override scan round', () => {
    it('reports what would be written and which mods could take it', async () => {
        const result = await scan({ uri: CANNON, offset: offsetOf('Damage = 12') }, makeHost());
        expect(result.failure).toBeUndefined();
        expect(result.memberName).toBe('Damage');
        expect(result.target).toBe('<parts/cannon/cannon.rules>/Part/Components/Weapon');
        expect(result.body).toBe('\t\t\tDamage = 12');
        expect(result.replacesContainer).toBe(false);
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]).toMatchObject({
            name: 'mod',
            manifests: ['mod.rules'],
            alreadyOverridden: false,
        });
        expect(result.candidates[0].blocked).toBeUndefined();
    });

    it('says when the override would replace a whole group rather than one value', async () => {
        const result = await scan({ uri: CANNON, offset: offsetOf('Weapon') }, makeHost());
        expect(result.memberName).toBe('Weapon');
        expect(result.replacesContainer).toBe(true);
    });

    it('reports a mod whose manifest already overrides that member', async () => {
        const host = makeHost({ folders: [OVERRIDDEN_DIR] });
        const result = await scan({ uri: CANNON, offset: offsetOf('Damage = 12') }, host);
        expect(result.candidates[0].alreadyOverridden).toBe(true);
    });

    it('follows an Overrides map kept in a file of the mod when it looks for a duplicate', async () => {
        const host = makeHost({ folders: [OVERRIDDEN_DIR] });
        const result = await scan({ uri: CANNON, offset: offsetOf('Density = 5') }, host);
        expect(result.target).toBe('<parts/cannon/cannon.rules>/Part');
        expect(result.candidates[0].alreadyOverridden).toBe(true);
    });

    it('reports a mod shipping several manifests as a choice for its author', async () => {
        const host = makeHost({ folders: [TWO_MANIFEST_DIR] });
        const result = await scan({ uri: CANNON, offset: offsetOf('Damage = 12') }, host);
        expect(result.candidates[0].blocked).toBe('ambiguousManifest');
        expect(result.candidates[0].manifests).toEqual(['mod_0.29.rules', 'mod_0.30.rules']);
    });

    it('answers that there is no mod when the workspace holds none', async () => {
        const result = await scan({ uri: CANNON, offset: offsetOf('Damage = 12') }, makeHost({ folders: [PLAIN_DIR] }));
        expect(result.failure).toBe('noModRoot');
        expect(result.candidates).toEqual([]);
    });

    it('turns down a file that is not the game own', async () => {
        const result = await scan({ uri: MOD_MANIFEST, offset: 10 }, makeHost());
        expect(result.failure).toBe('notVanilla');
    });

    it('turns down a language strings file, which no action can touch', async () => {
        const result = await scan({ uri: STRINGS, offset: offsetOf('Cannon', STRINGS) }, makeHost());
        expect(result.failure).toBe('stringsFile');
    });

    it('turns down every shape the member analysis refuses', async () => {
        const host = makeHost();
        for (const [needle, expected] of [
            ['Scoped', 'scopeRelativeValue'],
            ['Missing', 'unrebasablePath'],
            ['Inherited', 'inheritedMember'],
            ['Twice = 2', 'shadowedName'],
        ] as const) {
            const result = await scan({ uri: CANNON, offset: offsetOf(needle) }, host);
            expect(result.failure, needle).toBe(expected);
        }
        const text = read(CANNON);
        const inList = await scan({ uri: CANNON, offset: text.indexOf('\t\t2') }, host);
        expect(inList.failure).toBe('insideList');
    });

    it('says so when the game folder is not configured', async () => {
        const result = await scan({ uri: CANNON, offset: offsetOf('Damage = 12') }, makeHost({ dataRoot: null }));
        expect(result.failure).toBe('noGamePath');
    });
});

describe('the override apply round', () => {
    it('writes the action into the mod manifest and changes nothing else', async () => {
        const host = makeHost();
        const result = await apply(
            { uri: CANNON, offset: offsetOf('Damage = 12'), mod: keyOf(MOD_DIR) },
            host
        );
        expect(result.failure).toBeUndefined();
        expect(result.manifestFsPath).toBe(MOD_MANIFEST);
        expect(result.createdFsPath).toBe('');
        expect(result.changedFiles).toEqual([MOD_MANIFEST]);
        expect(host.announced).toEqual([MOD_MANIFEST]);

        const after = manifestAfter(host);
        expect(after).toContain('Action = Overrides');
        expect(after).toContain('OverrideIn = "<parts/cannon/cannon.rules>/Part/Components/Weapon"');
        expect(after).toContain('\t\t\tDamage = 12');
        // The manifest's existing action is still there, and exactly one Overrides was added.
        const actions = parseModActions(parseText(after, MOD_MANIFEST));
        expect(actions.map((action) => action.type)).toEqual(['Add', 'Overrides']);
    });

    it('writes an entry the editor own action reader parses back to the same target', async () => {
        const host = makeHost();
        await apply({ uri: CANNON, offset: offsetOf('Icon ='), mod: keyOf(MOD_DIR) }, host);
        const actions = parseModActions(parseText(manifestAfter(host), MOD_MANIFEST));
        const overrides = actions.find((action) => action.type === 'Overrides');
        expect(String(overrides?.targets[0].valueType.value)).toBe('<parts/cannon/cannon.rules>/Part/Components');
        expect(manifestAfter(host)).toContain('Icon = "./Data/parts/cannon/sprites/icon.png"');
    });

    it('computes the insertion against the open buffer, never the bytes on disk', async () => {
        const buffer = TextDocument.create(
            filePathToUri(MOD_MANIFEST),
            'rules',
            1,
            ['ID = test.overrideinmod', 'Name = "Buffered"', 'Version = 1.0.0', ''].join('\n')
        );
        const host = makeHost({ open: [buffer] });
        const result = await apply({ uri: CANNON, offset: offsetOf('Density = 5'), mod: keyOf(MOD_DIR) }, host);
        expect(result.failure).toBeUndefined();
        const after = TextDocument.applyEdits(buffer, host.changes[buffer.uri]);
        // The buffer declares no Actions at all, so the entry arrives in a fresh list.
        expect(after).toContain('Actions\n[\n');
        expect(after).toContain('OverrideIn = "<parts/cannon/cannon.rules>/Part"');
    });

    it('keeps the map in a file of the mod when the author asked for that shape', async () => {
        const host = makeHost();
        const result = await apply(
            { uri: CANNON, offset: offsetOf('Weapon'), mod: keyOf(MOD_DIR), shape: 'file' },
            host
        );
        expect(result.failure).toBeUndefined();
        expect(result.createdFsPath).toBe(`${WRITTEN_FRAGMENTS}/cannon_Components.rules`);
        expect(existsSync(result.createdFsPath)).toBe(true);
        expect(read(result.createdFsPath)).toBe(
            'Components\n{\n\tWeapon\n\t{\n\t\tDamage = 12\n\t\tReload = 2\n\t}\n}\n'
        );
        expect(manifestAfter(host)).toContain('Overrides = &<overrides/cannon_Components.rules>/Components');
        expect(result.changedFiles).toEqual([result.createdFsPath, MOD_MANIFEST]);
    });

    it('never writes over a fragment file that is already there', async () => {
        const first = makeHost();
        const one = await apply({ uri: CANNON, offset: offsetOf('Weapon'), mod: keyOf(MOD_DIR), shape: 'file' }, first);
        const second = makeHost();
        const two = await apply({ uri: CANNON, offset: offsetOf('Icon ='), mod: keyOf(MOD_DIR), shape: 'file' }, second);
        expect(two.failure).toBeUndefined();
        expect(two.createdFsPath).not.toBe(one.createdFsPath);
        expect(read(one.createdFsPath)).toContain('Weapon');
        expect(read(two.createdFsPath)).toContain('Icon');
    });

    it('refuses a mod whose Actions come from an included fragment, rather than writing a second list', async () => {
        const host = makeHost({ folders: [FRAGMENT_DIR] });
        const result = await apply(
            { uri: CANNON, offset: offsetOf('Damage = 12'), mod: keyOf(FRAGMENT_DIR) },
            host
        );
        expect(result.failure).toBe('notEditable');
        expect(host.changes).toEqual({});
    });

    it('asks the author which manifest a version split mod gets the override in', async () => {
        const host = makeHost({ folders: [TWO_MANIFEST_DIR] });
        const result = await apply(
            { uri: CANNON, offset: offsetOf('Damage = 12'), mod: keyOf(TWO_MANIFEST_DIR) },
            host
        );
        expect(result.failure).toBe('ambiguousManifest');
        expect(result.manifests).toEqual(['mod_0.29.rules', 'mod_0.30.rules']);
        expect(host.changes).toEqual({});
    });

    it('reports a member the mod already overrides instead of writing it twice', async () => {
        const host = makeHost({ folders: [OVERRIDDEN_DIR] });
        const result = await apply(
            { uri: CANNON, offset: offsetOf('Damage = 12'), mod: keyOf(OVERRIDDEN_DIR) },
            host
        );
        expect(result.failure).toBe('alreadyOverridden');
        expect(host.changes).toEqual({});
    });

    it('refuses a mod that is no longer in the workspace', async () => {
        const host = makeHost();
        const result = await apply(
            { uri: CANNON, offset: offsetOf('Damage = 12'), mod: keyOf(OVERRIDDEN_DIR) },
            host
        );
        expect(result.failure).toBe('unknownMod');
        expect(host.changes).toEqual({});
    });

    it('reports an edit the client turned down', async () => {
        const host = makeHost({ applies: false });
        const result = await apply({ uri: CANNON, offset: offsetOf('Damage = 12'), mod: keyOf(MOD_DIR) }, host);
        expect(result.failure).toBe('editRejected');
        expect(result.changedFiles).toEqual([]);
    });

    it('writes nothing at all for a refused member', async () => {
        const host = makeHost();
        for (const needle of ['Scoped', 'Missing', 'Inherited', 'Twice = 2']) {
            const result = await apply({ uri: CANNON, offset: offsetOf(needle), mod: keyOf(MOD_DIR) }, host);
            expect(result.failure, needle).toBeTruthy();
        }
        expect(host.changes).toEqual({});
        expect(existsSync(WRITTEN_FRAGMENTS)).toBe(false);
    });
});
