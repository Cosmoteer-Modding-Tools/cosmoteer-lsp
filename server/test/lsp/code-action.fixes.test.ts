import { describe, expect, it } from 'vitest';
import { Diagnostic } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    fixAllAction,
    fixOffsetsAreCurrent,
    quotedLikeSource,
    textFixActions,
} from '../../src/lsp/handlers/code-action.handlers';
import { ValidationErrorData } from '../../src/features/diagnostics/validator';

const URI = 'file:///c%3A/mod/parts/qf_part.rules';

const document = (text: string) => TextDocument.create(URI, 'rules', 1, text);

/** A finding underlining `span` of `doc`, carrying the quick-fix payload the validator produced. */
const finding = (doc: TextDocument, span: { start: number; end: number }, data: ValidationErrorData): Diagnostic => ({
    range: { start: doc.positionAt(span.start), end: doc.positionAt(span.end) },
    message: 'finding',
    data,
});

// The client keeps a diagnostic's range in step with the edits the author makes but never touches
// the byte offsets its `data` carries, so a fix that trusts those offsets deletes whatever moved
// into them. Every offset-driven fix has to notice that before it writes anything.
describe('a fix whose offsets the buffer has moved past', () => {
    const SOURCE = 'Part\n{\n\tType = Thruster\n\tFlammable = false\n}\n';
    const span = { start: SOURCE.indexOf('Flammable'), end: SOURCE.indexOf('false') + 'false'.length };

    it('offers the removal while the file still reads the way it was validated', () => {
        const doc = document(SOURCE);
        const diagnostic = finding(doc, span, { remove: { title: "Remove 'Flammable'", ...span } });
        const [action] = textFixActions(doc, URI, diagnostic);
        expect(action.title).toBe("Remove 'Flammable'");
        const [edit] = action.edit!.changes![URI];
        expect(doc.getText(edit.range)).toContain('Flammable');
    });

    it('refuses the removal after a line is typed above the finding', () => {
        const edited = 'Part\n{\n\tName = "x"\n\tType = Thruster\n\tFlammable = false\n}\n';
        const doc = document(edited);
        // The client moved the range along with the insertion. The payload still holds the old bytes.
        const moved = {
            start: edited.indexOf('Flammable'),
            end: edited.indexOf('false') + 'false'.length,
        };
        const diagnostic = finding(doc, moved, { remove: { title: "Remove 'Flammable'", ...span } });
        expect(textFixActions(doc, URI, diagnostic)).toEqual([]);
    });

    it('refuses a rewrite after a line is typed above the finding', () => {
        const edited = 'Part\n{\n\tName = "x"\n\tType = Thruster\n\tFlammable = false\n}\n';
        const doc = document(edited);
        const moved = {
            start: edited.indexOf('Flammable'),
            end: edited.indexOf('false') + 'false'.length,
        };
        const diagnostic = finding(doc, moved, {
            rewrite: { title: 'Change it', edits: [{ ...span, newText: 'TypeCategories [non_flammable]' }] },
        });
        expect(textFixActions(doc, URI, diagnostic)).toEqual([]);
    });

    it('refuses a removal whose span no longer holds the name the fix is titled after', () => {
        const doc = document(SOURCE);
        const elsewhere = { start: SOURCE.indexOf('Type'), end: SOURCE.indexOf('Thruster') + 'Thruster'.length };
        const diagnostic = finding(doc, elsewhere, { remove: { title: "Remove 'Flammable'", ...elsewhere } });
        expect(textFixActions(doc, URI, diagnostic)).toEqual([]);
    });

    // A renamed enum value carries both a replacement and a rewrite saying the same thing, which
    // put two lightbulbs with the same title in front of the author.
    it('offers a rewrite that only restates the did-you-mean fix once', () => {
        const text = 'Part\n{\n\tMode = Contnuous\n}\n';
        const doc = document(text);
        const at = { start: text.indexOf('Contnuous'), end: text.indexOf('Contnuous') + 'Contnuous'.length };
        const diagnostic = finding(doc, at, {
            quickFix: { title: "Change to 'Continuous'", newText: 'Continuous' },
            rewrite: { title: "Change to 'Continuous'", edits: [{ ...at, newText: 'Continuous' }] },
        });
        const titles = textFixActions(doc, URI, diagnostic).map((action) => action.title);
        expect(titles).toEqual(["Change to 'Continuous'"]);
    });

    it('still allows a fix that writes at an offset of its own rather than at the finding', () => {
        const doc = document(SOURCE);
        const diagnostic = finding(doc, { start: 0, end: 4 }, {});
        expect(fixOffsetsAreCurrent(doc, diagnostic, [{ start: 20, end: 20 }])).toBe(true);
    });
});

// A file usually carries the same deprecation and the same dead members many times over, so the
// deterministic fixes are also offered as one edit the author applies in a single step.
describe('the fix-all action', () => {
    const SOURCE = 'Part\n{\n\tA = 1\n\tB = 2\n\tC = 3\n}\n';

    /** A removal finding on the member named `name`. */
    const removalOf = (doc: TextDocument, name: string): Diagnostic => {
        const span = { start: SOURCE.indexOf(`${name} =`), end: SOURCE.indexOf(`${name} =`) + 5 };
        return finding(doc, span, { remove: { title: `Remove '${name}'`, ...span } });
    };

    it('merges every deterministic fix of the file into one edit', () => {
        const doc = document(SOURCE);
        const context = { diagnostics: [removalOf(doc, 'A'), removalOf(doc, 'C')] };
        const [action] = fixAllAction(doc, URI, context);
        expect(action.kind).toBe('source.fixAll');
        expect(TextDocument.applyEdits(doc, action.edit!.changes![URI])).toBe('Part\n{\n\tB = 2\n}\n');
    });

    it('leaves a did-you-mean guess out, since a fix-all must not guess', () => {
        const doc = document(SOURCE);
        const span = { start: SOURCE.indexOf('A ='), end: SOURCE.indexOf('A =') + 1 };
        const guess = finding(doc, span, { quickFix: { title: "Change to 'B'", newText: 'B' } });
        expect(fixAllAction(doc, URI, { diagnostics: [guess] })).toEqual([]);
    });

    it('is offered only when the client asks for a kind that covers it', () => {
        const doc = document(SOURCE);
        const diagnostics = [removalOf(doc, 'A')];
        expect(fixAllAction(doc, URI, { diagnostics, only: ['quickfix'] })).toEqual([]);
        expect(fixAllAction(doc, URI, { diagnostics, only: ['source'] })).toHaveLength(1);
        expect(fixAllAction(doc, URI, { diagnostics, only: ['source.fixAll'] })).toHaveLength(1);
    });
});

// A suggestion is a bare name, and the range it replaces is the whole written value. Dropping the
// author's quotes turns a string into something the game reads as a different kind of value.
describe('a did-you-mean fix on a quoted value', () => {
    it('keeps the quotes of an asset filename', () => {
        const text = 'Part\n{\n\tFile = "icno.png"\n}\n';
        const doc = document(text);
        const start = text.indexOf('"icno.png"');
        const diagnostic = finding(doc, { start, end: start + '"icno.png"'.length }, {
            quickFix: { title: "Change to 'icon.png'", newText: 'icon.png' },
        });
        const [action] = textFixActions(doc, URI, diagnostic);
        expect(action.edit!.changes![URI][0].newText).toBe('"icon.png"');
    });

    it('keeps the quotes of a localization key', () => {
        const text = 'Part\n{\n\tNameKey = "Parts/QfPar"\n}\n';
        const doc = document(text);
        const start = text.indexOf('"Parts/QfPar"');
        const diagnostic = finding(doc, { start, end: start + '"Parts/QfPar"'.length }, {
            quickFix: { title: "Change to 'Parts/QfPart'", newText: 'Parts/QfPart' },
        });
        const [action] = textFixActions(doc, URI, diagnostic);
        expect(action.edit!.changes![URI][0].newText).toBe('"Parts/QfPart"');
    });

    it('keeps the quotes around a suggestion carrying a space', () => {
        expect(quotedLikeSource('"Big Laser"', 'Big Cannon')).toBe('"Big Cannon"');
    });

    it('keeps a raw string raw', () => {
        expect(quotedLikeSource('@"sprites/icno.png"', 'sprites/icon.png')).toBe('@"sprites/icon.png"');
    });

    it('leaves an unquoted value unquoted, which is what a function name is', () => {
        expect(quotedLikeSource('roud', 'round')).toBe('round');
    });

    // The unknown-function fix underlines the name alone, inside a value that can itself be quoted,
    // so the replacement must stay a bare name there.
    it('writes a bare name for a function inside a quoted expression', () => {
        const text = 'Part\n{\n\tX = "roud((&A), 2)"\n}\n';
        const doc = document(text);
        const start = text.indexOf('roud');
        const diagnostic = finding(doc, { start, end: start + 'roud'.length }, {
            quickFix: { title: 'Change to "round"', newText: 'round' },
        });
        const [action] = textFixActions(doc, URI, diagnostic);
        expect(action.edit!.changes![URI][0].newText).toBe('round');
    });

    it('does not quote a suggestion that already carries its own quotes', () => {
        expect(quotedLikeSource('"a"', '"b"')).toBe('"b"');
    });
});
