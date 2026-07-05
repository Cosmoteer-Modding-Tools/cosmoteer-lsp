import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { documentRootClass } from '../../../src/document/schema/document-root';

const rootOf = (src: string, path: string) =>
    documentRootClass(parser(lexer(src), `file:///c%3A/game/Data/codex/${path}`).value);

describe('codex file document rooting', () => {
    // A codex page (lore entry, tutorial) is a whole-file CodexPageRules, pulled into the codex through
    // multi-source `CodexPages` concatenation the alias walk can't follow, so a folder rule roots it and
    // its fields (Entries, ShowCondition, …) resolve for completion and validation on their own.
    it('roots a codex page as CodexPageRules', () => {
        const src = `ID = fringe
TitleKey = "Lore/Fringe/Title"
TabNameKey = "Codex/Lore"
Entries
[
	{ Image { Texture { File = "./Data/factions/fringe.png" } } }
]`;
        expect(rootOf(src, 'lore/fringe/lore_fringe.rules')).toBe('Cosmoteer.Codex.CodexPageRules');
    });

    // The list-container files under codex/ hold a top-level `CodexPages` list, not `Entries`, so the
    // page rule's required-field guard leaves them unrooted rather than mis-typing them as a page.
    it('does not root a CodexPages list-container file as a page', () => {
        const src = `CodexPages
[
	&<monolith/lore_monolith.rules>
	&<fringe/lore_fringe.rules>
]`;
        expect(rootOf(src, 'lore/lore.rules')).toBeUndefined();
    });
});
