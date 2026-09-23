import { CancellationToken, CodeLens, CodeLensProvider, Position, Range, TextDocument, l10n } from 'vscode';

/**
 * Places a "Show part wiring" CodeLens above each root-level `Part` group, next to the grid editor
 * lens, so the report of what the part still needs before the game can build it is one click away.
 *
 * The provider is a light line scan rather than a parse: the server does the real work when the
 * command fires, and a lens on a non-part `Part` line is harmless (the request answers nothing and
 * the command warns).
 */
export class PartWiringCodeLensProvider implements CodeLensProvider {
    /** Matches an unindented `Part` declaration line (bare, inheriting, or with an inline brace). */
    private static readonly PART_LINE = /^Part\s*($|:|\{)/;

    /**
     * Provides a wiring lens for each root-level part declaration in the document.
     *
     * @param document the `.rules` document to scan.
     * @param _token cancellation token (unused, the scan is trivially fast).
     * @returns one CodeLens per root `Part` line.
     */
    public provideCodeLenses(document: TextDocument, _token: CancellationToken): CodeLens[] {
        const lenses: CodeLens[] = [];
        for (let line = 0; line < document.lineCount; line++) {
            if (!PartWiringCodeLensProvider.PART_LINE.test(document.lineAt(line).text)) continue;
            const position = new Position(line, 0);
            lenses.push(
                new CodeLens(new Range(position, position), {
                    title: l10n.t('Show part wiring'),
                    command: 'cosmoteer.showPartWiring',
                    arguments: [document.uri, position],
                })
            );
        }
        return lenses;
    }
}
