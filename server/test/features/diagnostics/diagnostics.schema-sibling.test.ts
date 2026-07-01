import { describe, expect, it } from 'vitest';
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
