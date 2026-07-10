import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateSchemaSiblingReferences } from '../../../src/features/diagnostics/validator.schema-sibling';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;
const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;
const validate = (src: string) => validateSchemaSiblingReferences(parse(src), token);

// A part whose Components container holds a MultiToggle (`IsOperational`) and a TurretWeapon whose
// `OperationalToggle = ID<PartComponent>` field names a sibling component.
const part = (toggleValue: string) => `Part
{
	Components
	{
		IsOperational
		{
			Type = MultiToggle
			Mode = All
		}
		Turret
		{
			Type = TurretWeapon
			OperationalToggle = ${toggleValue}
		}
	}
}`;

describe('schema sibling-reference existence validation', () => {
    it('accepts a reference to an existing sibling component', async () => {
        await initWorkspace();
        expect(await validate(part('IsOperational'))).toHaveLength(0);
    });

    it('flags a reference to a non-existent sibling, with a did-you-mean fix', async () => {
        await initWorkspace();
        const errors = await validate(part('IsOperationl')); // typo
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toMatch(/No component named 'IsOperationl'/);
        expect(errors[0].severity).toBe('warning');
        expect((errors[0].data as any)?.quickFix?.newText).toBe('IsOperational');
    });

    it('does not flag mod.rules manifests', async () => {
        await initWorkspace();
        const doc = parser(lexer(part('Nope')), 'file:///mod.rules').value;
        expect(await validateSchemaSiblingReferences(doc, token)).toHaveLength(0);
    });

    it('skips non-identifier values (paths/references/expressions)', async () => {
        await initWorkspace();
        // A `&`/path value is not a bare sibling id — must not be flagged by this pass.
        expect(await validate(part('&IsOperational'))).toHaveLength(0);
    });

    // A network router names components in `[from, to, cost]` tuples; the engine resolves those
    // part-wide like any other component id.
    const router = (from: string) => `Part
{
	Components
	{
		Port_Down { Type = MultiToggle; Mode = All }
		HeatSink { Type = MultiToggle; Mode = All }
		Router
		{
			Type = NetworkRouter
			RouteGenerators
			[
				{
					Type = Bidirectional
					Routes
					[
						[${from}, HeatSink, 0]
					]
				}
			]
		}
	}
}`;

    it('accepts a route tuple referencing existing components', async () => {
        await initWorkspace();
        expect(await validate(router('Port_Down'))).toHaveLength(0);
    });

    it('flags a route tuple referencing a non-existent component, with a did-you-mean fix', async () => {
        await initWorkspace();
        const errors = await validate(router('Port_Dwn')); // typo
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toMatch(/No component named 'Port_Dwn'/);
        expect((errors[0].data as any)?.quickFix?.newText).toBe('Port_Down');
    });

    it('does not flag the numeric cost slot of a route tuple', async () => {
        await initWorkspace();
        // The `0` cost is an int slot; only the reference slots are checked.
        expect(await validate(router('Port_Down'))).toHaveLength(0);
    });

    describe('override-patch files resolve against their merge target', () => {
        let modDir: string;
        const patch = (toggle: string) =>
            `Part\n{\n\tComponents\n\t{\n\t\tTurret\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t\tOperationalToggle = ${toggle}\n\t\t}\n\t}\n}`;

        beforeAll(async () => {
            modDir = await mkdtemp(join(tmpdir(), 'cosmo-ovr-'));
            // The manifest merges patch.rules into the fixture workspace's base part, which is where
            // the referenced `IsOperational` component is declared.
            await writeFile(
                join(modDir, 'mod.rules'),
                'ID = test.override\nName = "t"\nActions\n[\n\t{\n\t\tAction = Overrides\n\t\tOverrideIn = "<./Data/parts/base_part.rules>"\n\t\tOverrides = &<patch.rules>\n\t}\n]\n'
            );
            await writeFile(join(modDir, 'patch.rules'), patch('IsOperational'));
        });
        afterAll(async () => {
            await rm(modDir, { recursive: true, force: true });
        });

        it('accepts a reference to a component only the override target declares', async () => {
            await initWorkspace();
            const uri = pathToFileURL(join(modDir, 'patch.rules')).href;
            const doc = parser(lexer(patch('IsOperational')), uri).value;
            expect(await validateSchemaSiblingReferences(doc, token)).toHaveLength(0);
        });

        it('still flags a component neither the patch nor the target declares', async () => {
            await initWorkspace();
            const uri = pathToFileURL(join(modDir, 'patch.rules')).href;
            const doc = parser(lexer(patch('IsOperationl')), uri).value;
            const errors = await validateSchemaSiblingReferences(doc, token);
            expect(errors).toHaveLength(1);
            expect(errors[0].message).toMatch(/No component named 'IsOperationl'/);
        });
    });

    it('skips a cross-part proxy whose ComponentID targets an adjacent part', async () => {
        await initWorkspace();
        // A `ResourceStorageProxy` with `PartLocation`/`PartCriteria` reaches into the neighbouring
        // part (e.g. a railgun's ammo part), so `LoadedAmmo` is declared there, not here. It must not
        // be flagged as a missing local component.
        const src = `Part
{
	Components
	{
		IsOperational
		{
			Type = MultiToggle
			Mode = All
		}
		AmmoProxy
		{
			Type = ResourceStorageProxy
			ResourceType = bullet
			PartLocation = [0, 4]
			PartCriteria { Category = railgun_ammo }
			ComponentID = LoadedAmmo
		}
	}
}`;
        expect(await validate(src)).toHaveLength(0);
    });
});
