import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import { Completion } from '../../../src/features/completion/autocompletion.service';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';

const token = CancellationToken.None;

const labels = (cs: Completion[]): string[] => cs.map((c) => (typeof c === 'string' ? c : c.label));

/** Completions at the byte offset of `marker` (its first occurrence) in `src`. */
const completionsAt = async (src: string, marker: string, uri = 'file:///part.rules'): Promise<Completion[]> => {
    const document = parser(lexer(src), uri).value;
    return schemaFieldNameCompletions(document, src.indexOf(marker), token);
};

// A part whose base components reference per-mode ids through proxies: `MissilesPrereq` and
// `CommonReloadResetTrigger` are expected from a mode's component set, `IsOperational` is declared.
const PART = `
Part
{
    Components
    {
        IsOperational
        {
            Type = MultiToggle
            Mode = All
        }
        MissilesPrereqProxy
        {
            Type = ToggleProxy
            ComponentID = MissilesPrereq
        }
        ReloadResetProxy
        {
            Type = TriggerProxy
            ComponentID = CommonReloadResetTrigger
        }
        CrossPartProxy
        {
            Type = ToggleProxy
            PartLocation = [0, -1]
            ComponentID = LoadedAmmo
        }
        Consumer
        {
            Type = ResourceConsumer
            OverridePriorityKey = SomeSharedKey
        }
        Tracker
        {
            Type = ValueGraphics
            GetColorFrom = ConstructionTracker
        }
        <CURSOR>
    }
}
`;

describe('component-name completion: dangling part-wide references', () => {
    it('offers ids referenced by proxies but declared nowhere in the part', async () => {
        const names = labels(await completionsAt(PART, '<CURSOR>'));
        expect(names).toContain('MissilesPrereq');
        expect(names).toContain('CommonReloadResetTrigger');
    });

    it('does not offer declared, cross-part, non-sibling, or runtime-injected ids', async () => {
        const names = labels(await completionsAt(PART, '<CURSOR>'));
        // Declared in the same container.
        expect(names).not.toContain('IsOperational');
        // A cross-part proxy's target lives in another part.
        expect(names).not.toContain('LoadedAmmo');
        // OverridePriorityKey is an opaque label, not a component reference.
        expect(names).not.toContain('SomeSharedKey');
        // ConstructionTracker is injected by the engine at runtime.
        expect(names).not.toContain('ConstructionTracker');
    });

    it('scaffolds the accepted name as a component block primed for its Type', async () => {
        const completions = await completionsAt(PART, '<CURSOR>');
        const suggestion = completions.find((c) => typeof c !== 'string' && c.label === 'MissilesPrereq');
        expect(suggestion).toBeDefined();
        expect(typeof suggestion !== 'string' && suggestion?.insertText).toBe('MissilesPrereq\n{\n\tType = $0\n}');
    });

    it('does not leak component names into an untyped component group inside the container', async () => {
        const src = PART.replace('<CURSOR>', 'NewComponent\n        {\n            <INNER>\n        }');
        const names = labels(await completionsAt(src, '<INNER>'));
        expect(names).not.toContain('MissilesPrereq');
        // The untyped group still gets the `Type` discriminator flow.
        expect(names).toContain('Type');
    });
});

describe('component-name completion: mode fragment scope via reverse include', () => {
    afterEach(() => {
        ReverseIncludeIndex.instance.reset();
    });

    // A components fragment pulled in by a part's `ToggledComponents` (vanilla's missile-launcher
    // mode pattern): the proxy contract lives in the part file, so completing a name inside the
    // fragment must look through the includer.
    it('offers a proxy target expected by the including part file', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'compname-'));
        try {
            const partText = `
Part
{
    Components
    {
        MissilesPrereqProxy
        {
            Type = ToggleProxy
            ComponentID = MissilesPrereq
        }
        FlareComponents
        {
            Type = ToggledComponents
            Components = &<flare.rules>/Components
        }
    }
}
`;
            const fragText = `
Components
{
    MineStorage
    {
        Type = ResourceStorage
    }

}
`;
            writeFileSync(join(dir, 'part.rules'), partText);
            const fragPath = join(dir, 'flare.rules');
            writeFileSync(fragPath, fragText);

            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);

            const fragUri = pathToFileURL(fragPath).href;
            const document = parser(lexer(fragText), fragUri).value;
            // Complete on the blank line after MineStorage, inside the Components container.
            const offset = fragText.indexOf('\n\n') + 1;
            const names = labels(await schemaFieldNameCompletions(document, offset, token));
            expect(names).toContain('MissilesPrereq');
            // Declared in the part file itself, so not dangling.
            expect(names).not.toContain('FlareComponents');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
