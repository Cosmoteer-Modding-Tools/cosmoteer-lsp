import { CancellationToken, CodeLens, CodeLensProvider, Position, Range, TextDocument, l10n } from 'vscode';

/**
 * Places a "Preview shader" CodeLens above every `Shader = "….shader"` assignment in a `.rules` file,
 * so a material's shader can be opened in the live WebGL preview with one click. The lens carries the
 * position of the assignment, which the server uses to find the enclosing material and resolve its
 * shader, texture, and constants.
 *
 * The provider is a light line scan rather than a parse: the server does the real work when the
 * command fires, and a missed or extra lens is harmless.
 */
export class ShaderPreviewCodeLensProvider implements CodeLensProvider {
    /** Matches a `Shader = "x.shader"` assignment line, capturing nothing (the position is enough). */
    private static readonly SHADER_LINE = /^\s*Shader\s*=\s*"?[^"\n]+\.shader/;

    /**
     * Provides a preview lens for each shader assignment in the document.
     *
     * @param document the `.rules` document to scan.
     * @param _token cancellation token (unused, the scan is trivially fast).
     * @returns one CodeLens per `Shader = …` line.
     */
    public provideCodeLenses(document: TextDocument, _token: CancellationToken): CodeLens[] {
        const lenses: CodeLens[] = [];
        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;
            if (!ShaderPreviewCodeLensProvider.SHADER_LINE.test(text)) continue;
            const position = new Position(line, text.length - text.trimStart().length);
            lenses.push(
                new CodeLens(new Range(position, position), {
                    title: l10n.t('Preview shader'),
                    command: 'cosmoteer.previewShader',
                    arguments: [document.uri, position],
                })
            );
        }
        return lenses;
    }
}
