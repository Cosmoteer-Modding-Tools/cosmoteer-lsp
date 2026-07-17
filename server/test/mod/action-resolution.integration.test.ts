import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { FullNavigationStrategy } from '../../src/features/navigation/full.navigation-strategy';
import { ValidationForValue } from '../../src/features/diagnostics/validator.value';
import { ReferenceAutoCompletionStrategy } from '../../src/features/completion/strategy/reference.autocompletion-strategy';
import { AbstractNode, AbstractNodeDocument, ValueNode } from '../../src/core/ast/ast';
import { parseFilePath } from '../../src/utils/ast.utils';
import { AddBaseIndex } from '../../src/mod/add-base.index';
import { MemberInjectionIndex } from '../../src/mod/member-injection.index';
import { clearModRootCache } from '../../src/mod/mod-root';
import { invalidateModContext } from '../../src/mod/mod-context';
import { globalSettings } from '../../src/settings';
import { initWorkspace, valueOf, WORKSPACE_DATA_DIR } from '../workspace-helper';
import { FIXTURES_DIR } from '../helpers';

// End-to-end resolution of the members mod actions merge into game-tree nodes, through the real
// resolver (FullNavigationStrategy) and completion strategy over an on-disk fixture mod. The mod
// (test/fixtures/action-resolution-mod/mod.rules) patches `parts/derived_part.rules`:
//   - AddBase appends `overclock_base.rules`/Part to derived_part's Part (slot 1, since a static
//     base already sits at slot 0) -> `^/1/OVERCLOCK_MEMBER` must resolve.
//   - Overrides injects `OverriddenComp` and Add(Name) injects `AddedComp` into Part/Components.
// This is the committed counterpart of the scratchpad LSP drivers, covering the index -> resolver
// integration the extension-source unit tests only stub.
const nav = new FullNavigationStrategy();
const completion = new ReferenceAutoCompletionStrategy();
const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'action-resolution-mod');
const PART = '<./Data/parts/derived_part.rules>/Part';
const BASE_PART = '<./Data/parts/base_part.rules>/Part';

let origin: AbstractNodeDocument;
const navigate = (path: string) => nav.navigate(path, origin, join(MOD_DIR, 'consumer.rules'), token);

const pos = { line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 };
const refNode = (value: string): ValueNode => ({
    type: 'Value',
    valueType: { type: 'Reference', value },
    position: pos,
    parent: origin,
});
const complete = (value: string) =>
    completion.complete({ node: refNode(value), isInheritanceNode: false, cancellationToken: token });

beforeAll(async () => {
    await initWorkspace();
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    clearModRootCache();
    invalidateModContext();
    AddBaseIndex.instance.reset();
    MemberInjectionIndex.instance.reset();
    await AddBaseIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, MOD_DIR], token);
    await MemberInjectionIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, MOD_DIR], token);
    origin = await parseFilePath(join(MOD_DIR, 'consumer.rules'));
});

afterAll(() => {
    AddBaseIndex.instance.reset();
    MemberInjectionIndex.instance.reset();
});

describe('AddBase: `^/N` into an appended base', () => {
    it('resolves a member of the base the AddBase appends (`^/1/OVERCLOCK_MEMBER`)', async () => {
        expect(valueOf(await navigate(`&${PART}/^/1/OVERCLOCK_MEMBER`))).toBe(99);
    });

    it('still resolves the written static base at `^/0` (index is not consulted in range)', async () => {
        // `^/0` is derived_part's own written base (base_part), whose HeatTarget is unaffected.
        expect(valueOf(await navigate(`&${PART}/^/0/HeatTarget`))).toBe('HeatStorageDistribution');
    });

    it('does not resolve a bogus member on the appended base (`^/1/Bogus`)', async () => {
        expect(await navigate(`&${PART}/^/1/Bogus`)).toBeNull();
    });

    it('appends a second AddBase after the first, resolving it at `^/2/OVERCLOCK_MEMBER_2`', async () => {
        expect(valueOf(await navigate(`&${PART}/^/2/OVERCLOCK_MEMBER_2`))).toBe(77);
        // The first appended base stays at `^/1`, not shifted by the second.
        expect(valueOf(await navigate(`&${PART}/^/1/OVERCLOCK_MEMBER`))).toBe(99);
    });

    it('does not resolve a slot past the static + appended bases (`^/3/…`)', async () => {
        expect(await navigate(`&${PART}/^/3/OVERCLOCK_MEMBER`)).toBeNull();
    });

    it('ignores an Index-carrying AddBase, which is not modelled (`base_part/^/0` stays unresolved)', async () => {
        // The mod adds the same base to base_part with an explicit Index. That form is skipped, and
        // base_part's Part has no written inheritance, so `^/0` resolves to nothing.
        expect(await navigate(`&${BASE_PART}/^/0/OVERCLOCK_MEMBER`)).toBeNull();
    });
});

describe('Member injection: nested Overrides and Add(Name)', () => {
    it('resolves an Overrides-injected member (`Components/OverriddenComp`)', async () => {
        expect(valueOf(await navigate(`&${PART}/Components/OverriddenComp/ToggleOn`))).toBe(false);
    });

    it('resolves an Add(Name)-injected member (`Components/AddedComp`)', async () => {
        expect(valueOf(await navigate(`&${PART}/Components/AddedComp/ToggleOn`))).toBe(true);
    });

    it('resolves a member from an Overrides whose source is a `&<file>` reference', async () => {
        // The second Overrides merges the members of `extra_components.rules` (not an inline group).
        expect(valueOf(await navigate(`&${PART}/Components/FileOverriddenComp/ToggleOn`))).toBe(true);
    });

    it('resolves deep through an injected member (`Components/AddedComp/Type`)', async () => {
        expect(valueOf(await navigate(`&${PART}/Components/AddedComp/Type`))).toBe('StaticToggle');
    });

    it('matches injected members case-insensitively like the game (`Components/addedcomp`)', async () => {
        expect(valueOf(await navigate(`&${PART}/Components/addedcomp/ToggleOn`))).toBe(true);
    });

    it('does not resolve a member no action injects (`Components/NotInjected`)', async () => {
        expect(await navigate(`&${PART}/Components/NotInjected`)).toBeNull();
    });

    it('still resolves the node own members without the index (`Components/HeatProducer`)', async () => {
        // HeatProducer is derived_part's own component. The member index is consulted only on a miss.
        expect(await navigate(`&${PART}/Components/HeatProducer`)).not.toBeNull();
    });
});

describe('AddBase and member injection compose on the same node', () => {
    it('resolves both `^/1` and an injected component off the same Part', async () => {
        expect(valueOf(await navigate(`&${PART}/^/1/OVERCLOCK_MEMBER`))).toBe(99);
        expect(valueOf(await navigate(`&${PART}/Components/AddedComp/ToggleOn`))).toBe(true);
    });
});

describe('validation reflects the resolution (the user-facing diagnostic)', () => {
    const diag = (value: string) => ValidationForValue.callback(refNode(value), token);

    it('does not warn on an AddBase member or an injected component', async () => {
        expect(await diag(`&${PART}/^/1/OVERCLOCK_MEMBER`)).toBeUndefined();
        expect(await diag(`&${PART}/Components/AddedComp`)).toBeUndefined();
    });

    it('warns on a bogus caret member and a bogus injected component', async () => {
        expect((await diag(`&${PART}/^/1/Bogus`))?.message).toBe('Reference name is not known');
        expect((await diag(`&${PART}/Components/NotInjected`))?.message).toBe('Reference name is not known');
    });
});

describe('completion offers the appended base and injected members', () => {
    it('offers the appended base members after `^/1/`', async () => {
        const options = await complete(`&${PART}/^/1/`);
        expect(options).toContain('OVERCLOCK_MEMBER');
    });

    it('offers the appended base slots in `^/` completion (static + AddBase = 0/, 1/, 2/)', async () => {
        const options = await complete(`&${PART}/^/`);
        expect(options).toEqual(expect.arrayContaining(['0/', '1/', '2/']));
    });

    it('offers Overrides- and Add-injected members alongside the node own', async () => {
        const options = await complete(`&${PART}/Components/`);
        expect(options).toEqual(expect.arrayContaining(['OverriddenComp', 'AddedComp', 'HeatProducer']));
    });

    it('does not duplicate a member (injected names appear once)', async () => {
        const options = await complete(`&${PART}/Components/`);
        expect(options.filter((o) => o === 'AddedComp')).toHaveLength(1);
    });
});
