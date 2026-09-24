import { CancellationToken, CodeLens, CodeLensProvider, Position, Range, TextDocument, l10n } from 'vscode';

/** Whether a document is a mod manifest (`mod.rules` or a version-specific `mod_*.rules`). */
const isManifestDocument = (document: TextDocument): boolean =>
    /^mod(_[^/\\]*)?\.rules$/i.test(document.fileName.replace(/\\/g, '/').split('/').pop() ?? '');

/**
 * Places a "Show mod overview" CodeLens at the top of a mod manifest, so the report of what the
 * manifest does (its actions, their resolution status, and the mod's unreachable files) is one
 * click away while editing it.
 */
export class ModOverviewCodeLensProvider implements CodeLensProvider {
    /**
     * Provides the single overview lens for a manifest document.
     *
     * @param document the `.rules` document to check.
     * @param _token cancellation token (unused, the check is trivially fast).
     * @returns the lens on the first line, or nothing for a non-manifest file.
     */
    public provideCodeLenses(document: TextDocument, _token: CancellationToken): CodeLens[] {
        if (!isManifestDocument(document)) return [];
        const start = new Position(0, 0);
        return [
            new CodeLens(new Range(start, start), {
                title: l10n.t('Show mod overview'),
                command: 'cosmoteer.showModOverview',
                arguments: [document.uri],
            }),
        ];
    }
}
