import { CancellationToken, CodeLens, CodeLensProvider, Position, Range, TextDocument, l10n } from 'vscode';

/**
 * Places an "Edit part grid" CodeLens above a root-level `Part` group in a `.rules` file, so the
 * interactive grid editor can be opened with one click. The lens carries the position of the group,
 * which the server uses to locate the part and build the grid payload.
 *
 * The provider is a light line scan rather than a parse: the server does the real work when the
 * command fires, and a lens on a non-part `Part` line is harmless (the editor reports "no part").
 */
export class PartGridCodeLensProvider implements CodeLensProvider {
    /** Matches an unindented `Part` declaration line (bare, inheriting, or with an inline brace). */
    private static readonly PART_LINE = /^Part\s*($|:|\{)/;

    /**
     * Provides an edit lens for each root-level part declaration in the document.
     *
     * @param document the `.rules` document to scan.
     * @param _token cancellation token (unused, the scan is trivially fast).
     * @returns one CodeLens per root `Part` line.
     */
    public provideCodeLenses(document: TextDocument, _token: CancellationToken): CodeLens[] {
        const lenses: CodeLens[] = [];
        for (let line = 0; line < document.lineCount; line++) {
            if (!PartGridCodeLensProvider.PART_LINE.test(document.lineAt(line).text)) continue;
            const position = new Position(line, 0);
            lenses.push(
                new CodeLens(new Range(position, position), {
                    title: l10n.t('Edit part grid'),
                    command: 'cosmoteer.editPartGrid',
                    arguments: [document.uri, position],
                })
            );
        }
        return lenses;
    }
}
