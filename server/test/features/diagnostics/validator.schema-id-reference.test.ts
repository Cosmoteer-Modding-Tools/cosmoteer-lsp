import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateCrossFileIdReferences } from '../../../src/features/diagnostics/validator.schema-id-reference';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';

// End-to-end test of the opt-in cross-file id-reference validator. A temp folder holds the
// authoritative `PartToggles` declaration list (the same field-name harvest the real index
// uses); each part document is parsed in memory and validated against that folder. The index
// singleton is reset before every test so it rebuilds from the folder passed in.
const parse = (src: string, uri = 'file:///part.rules') => parser(lexer(src), uri).value;
const token = CancellationToken.None;

/** A part with a single `UIToggle` component referencing `toggleId` via `ToggleID`. */
const partWithToggle = (toggleId: string, uri?: string) =>
    parse(
        `Part\n{\n\tID = my_part\n\tComponents\n\t[\n\t\tPowerToggle\n\t\t{\n\t\t\tType = UIToggle\n\t\t\tToggleID = "${toggleId}"\n\t\t}\n\t]\n}`,
        uri
    );

describe('validateCrossFileIdReferences', () => {
    let workspaceUri: string;
    let emptyUri: string;
    let tmpRoot: string;

    beforeAll(() => {
        tmpRoot = mkdtempSync(join(tmpdir(), 'idref-'));
        const declDir = join(tmpRoot, 'data', 'gui', 'game', 'parts');
        mkdirSync(declDir, { recursive: true });
        // Authoritative declaration list: two toggles harvested by the `PartToggles` field name.
        writeFileSync(
            join(declDir, 'part_toggles.rules'),
            'PartToggles\n[\n\t{\n\t\tToggleID = "on_off"\n\t}\n\t{\n\t\tToggleID = "fire_mode"\n\t}\n]\n'
        );
        workspaceUri = pathToFileURL(join(tmpRoot, 'data')).href;
        const emptyDir = join(tmpRoot, 'empty');
        mkdirSync(emptyDir, { recursive: true });
        emptyUri = pathToFileURL(emptyDir).href;
    });

    afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

    beforeEach(() => SchemaIdIndex.instance.reset());

    it('does not flag a toggle id that is declared in the project', async () => {
        const errors = await validateCrossFileIdReferences(partWithToggle('on_off'), [workspaceUri], token);
        expect(errors).toHaveLength(0);
    });

    it('flags a typo and suggests the closest declared toggle id', async () => {
        const errors = await validateCrossFileIdReferences(partWithToggle('on_of'), [workspaceUri], token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain("'on_of'");
        expect(errors[0].severity).toBe('warning');
        expect(errors[0].data?.quickFix?.newText).toBe('on_off');
    });

    it('does not flag when the class has no declarations in the project (no coverage to judge)', async () => {
        const errors = await validateCrossFileIdReferences(partWithToggle('on_of'), [emptyUri], token);
        expect(errors).toHaveLength(0);
    });

    it('ignores an empty reference value', async () => {
        const errors = await validateCrossFileIdReferences(partWithToggle(''), [workspaceUri], token);
        expect(errors).toHaveLength(0);
    });

    it('does not validate a mod.rules document', async () => {
        const doc = partWithToggle('on_of', 'file:///mod.rules');
        const errors = await validateCrossFileIdReferences(doc, [workspaceUri], token);
        expect(errors).toHaveLength(0);
    });

    it('does not flag the part\'s own non-GUI reference fields (e.g. its PartRules ID)', async () => {
        // The part's own `ID = my_part` resolves to a PartRules reference, which is NOT in the
        // GUI allowlist, so it must never be flagged even though it is undeclared.
        const errors = await validateCrossFileIdReferences(partWithToggle('on_off'), [workspaceUri], token);
        expect(errors.map((e) => e.message)).toEqual([]);
    });
});
