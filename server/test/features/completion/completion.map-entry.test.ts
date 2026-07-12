import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import { Completion } from '../../../src/features/completion/autocompletion.service';

// A map written in its entry-list form has class-less entry groups whose members are the map's
// entry names: the engine defaults `Key`/`Value`, or the `[KeyValuePairNames]` spellings like the
// roof decal upgrades' `Old`/`New`. Completion inside an empty entry offers exactly those.
const token = CancellationToken.None;
const parse = (src: string) => parser(lexer(src), 'file:///data/ships/terran/x.rules').value;
const labelsOf = (cs: Completion[]) => cs.map((c) => (typeof c === 'string' ? c : c.label));

describe('map entry-form completion', () => {
    it('offers the custom entry names inside an empty entry group', async () => {
        const SRC = 'MyShip : <../base_ship.rules>\n{\n\tID = test.ship\n\tNameKey = Ships_Test\n\tRoofs\n\t{\n\t\tRoofDecalUpgrades\n\t\t[\n\t\t\t{\n\t\t\t\t\n\t\t\t}\n\t\t]\n\t}\n}\n';
        const doc = parse(SRC);
        const labels = labelsOf(await schemaFieldNameCompletions(doc, SRC.indexOf('{\n\t\t\t\t\n') + 3, token));
        expect(labels).toContain('Old');
        expect(labels).toContain('New');
        // The wrapper must not leak generic Key/Value beside the custom spellings.
        expect(labels).not.toContain('Key');
    });

    it('does not repeat an entry name already written', async () => {
        const SRC = 'MyShip : <../base_ship.rules>\n{\n\tID = test.ship\n\tNameKey = Ships_Test\n\tRoofs\n\t{\n\t\tRoofDecalUpgrades\n\t\t[\n\t\t\t{\n\t\t\t\tOld = plain01\n\t\t\t\t\n\t\t\t}\n\t\t]\n\t}\n}\n';
        const doc = parse(SRC);
        const labels = labelsOf(await schemaFieldNameCompletions(doc, SRC.indexOf('plain01') + 9, token));
        expect(labels).toContain('New');
        expect(labels).not.toContain('Old');
    });
});
