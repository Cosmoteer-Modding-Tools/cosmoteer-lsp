import { Uri, commands, l10n, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { VirtualContentProvider } from '../virtual-content-provider';

/** The virtual-document scheme the rendered report is served under. */
export const POST_UPDATE_REPORT_SCHEME = 'cosmoteer-post-update';

/** What the server answers with: the report and the counts behind it. */
interface PostUpdateReportResult {
    readonly markdown: string;
    readonly summary: { readonly status: string; readonly appeared: number; readonly resolved: number };
}

/**
 * Serves the generated report as a read-only virtual document, so the built-in markdown preview can
 * render it without writing a file into the user's mod.
 */
export class PostUpdateReportContentProvider extends VirtualContentProvider {
    public constructor() {
        super(() => l10n.t('The report is no longer available. Run the command again.'));
    }
}

/**
 * Asks the server what the game update changed and opens the report in the markdown preview.
 *
 * @param client the running language client the command is sent through.
 * @param provider the content provider the rendered markdown is served from.
 */
export async function showPostUpdateReport(
    client: LanguageClient,
    provider: PostUpdateReportContentProvider
): Promise<void> {
    const result = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.postUpdateReport',
        arguments: [],
    })) as PostUpdateReportResult | null;
    if (!result) {
        void window.showInformationMessage(l10n.t('Cosmoteer: open the mod folder first.'));
        return;
    }
    // One stable uri per project, so re-running refreshes the open preview instead of stacking tabs.
    const reportUri = Uri.from({
        scheme: POST_UPDATE_REPORT_SCHEME,
        path: '/What the game update changed.md',
        query: workspace.workspaceFolders?.[0]?.uri.toString() ?? '',
    });
    provider.set(reportUri, result.markdown);
    await commands.executeCommand('markdown.showPreview', reportUri);
}
