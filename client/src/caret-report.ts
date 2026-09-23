import {
    CodeLensProvider,
    ExtensionContext,
    Position,
    Uri,
    commands,
    l10n,
    languages,
    window,
    workspace,
} from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { VirtualContentProvider } from './virtual-content-provider';
import { ModOverviewCodeLensProvider } from './mod-overview/mod-overview';
import { PartWiringCodeLensProvider } from './part-wiring/part-wiring';
import { COSMOTEER_METHOD } from '../../shared/lsp-methods';

/** The few things one caret-driven report differs in, everything else about them being the same. */
interface CaretReportKind {
    /** The command the report is bound to. */
    command: string;
    /** The server request the rendered markdown is asked for with. */
    method: string;
    /** The virtual-document scheme the report is served under. */
    scheme: string;
    /** The file name the preview tab carries. */
    documentName: string;
    /**
     * The warning shown when the server has no report to give. Read when the command runs rather
     * than when this table is built, so it is localized against the bundle that has loaded by then.
     */
    missing: () => string;
    /** The sentence shown for a preview whose stored markdown is gone, read just as late. */
    gone: () => string;
    /** True for a report about a whole file, which is asked for without a position. */
    wholeFile?: boolean;
    /** A lens offering the report, for the reports narrow enough to be worth one. */
    codeLens?: () => CodeLensProvider;
}

/**
 * Every report that renders what the server knows about the thing the cursor sits in. Only the
 * reports that apply to a narrow, rare place carry a lens: a group or a reference is far too common
 * for one, so those run from the palette only.
 */
const CARET_REPORTS: readonly CaretReportKind[] = [
    {
        command: 'cosmoteer.showModOverview',
        method: COSMOTEER_METHOD.modOverview,
        scheme: 'cosmoteer-mod-overview',
        documentName: 'Mod Overview.md',
        missing: () => l10n.t('No mod overview available: the file is not inside a mod with a mod.rules.'),
        gone: () => l10n.t('The mod overview is no longer available. Run the command again.'),
        wholeFile: true,
        codeLens: () => new ModOverviewCodeLensProvider(),
    },
    {
        command: 'cosmoteer.showPartWiring',
        method: COSMOTEER_METHOD.partWiring,
        scheme: 'cosmoteer-part-wiring',
        documentName: 'Part Wiring.md',
        missing: () => l10n.t('No part wiring available: the cursor is not inside a part.'),
        gone: () => l10n.t('The part wiring report is no longer available. Run the command again.'),
        codeLens: () => new PartWiringCodeLensProvider(),
    },
    {
        command: 'cosmoteer.showEffectiveGroup',
        method: COSMOTEER_METHOD.effectiveGroup,
        scheme: 'cosmoteer-effective-group',
        documentName: 'What The Game Loads.md',
        missing: () => l10n.t('No report available: the cursor is not inside a readable group.'),
        gone: () => l10n.t('The effective-group report is no longer available. Run the command again.'),
    },
    {
        command: 'cosmoteer.diffAgainstBase',
        method: COSMOTEER_METHOD.baseDiff,
        scheme: 'cosmoteer-base-diff',
        documentName: 'What This Group Changes.md',
        missing: () => l10n.t('No comparison available: this group does not derive from a file the game ships.'),
        gone: () => l10n.t('The comparison is no longer available. Run the command again.'),
    },
    {
        command: 'cosmoteer.explainReference',
        method: COSMOTEER_METHOD.explainReference,
        scheme: 'cosmoteer-reference-trace',
        documentName: 'What This Reference Points At.md',
        missing: () => l10n.t('No report available: the cursor is not on a reference.'),
        gone: () => l10n.t('The reference report is no longer available. Run the command again.'),
    },
];

/**
 * Requests a report for the position under the caret and opens it in the markdown preview.
 *
 * @param client the running language client the request is sent through.
 * @param provider the content provider the rendered markdown is served from.
 * @param report the request, scheme, document name and missing-report warning of this command.
 * @param uri the file's uri, or undefined to use the active editor.
 * @param position the position to report on, or undefined to use the cursor.
 * @returns nothing, once the preview is open or the warning has been shown.
 */
const showCaretReport = async (
    client: LanguageClient,
    provider: VirtualContentProvider,
    report: CaretReportKind,
    uri?: Uri,
    position?: Position
): Promise<void> => {
    const editor = window.activeTextEditor;
    const targetUri = uri ?? editor?.document.uri;
    const targetPosition = report.wholeFile ? undefined : (position ?? editor?.selection.active);
    if (!targetUri || (!targetPosition && !report.wholeFile)) return;
    const markdown = await client.sendRequest<string | null>(report.method, {
        textDocument: { uri: targetUri.toString() },
        position: targetPosition && { line: targetPosition.line, character: targetPosition.character },
    });
    if (!markdown) {
        void window.showWarningMessage(report.missing());
        return;
    }
    // One stable uri per (file, line), so re-running refreshes the open preview instead of stacking
    // new tabs. The source file and line ride along in the query for reference.
    const reportUri = Uri.from({
        scheme: report.scheme,
        path: `/${report.documentName}`,
        query: targetPosition ? `${targetUri.toString()}#${targetPosition.line}` : targetUri.toString(),
    });
    provider.set(reportUri, markdown);
    await commands.executeCommand('markdown.showPreview', reportUri);
};

/**
 * Registers every caret-driven report: its virtual-document scheme, the command that renders it and,
 * where the table asks for one, the lens that offers it.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the reports are built by.
 * @returns nothing.
 */
export function registerCaretReports(context: ExtensionContext, client: LanguageClient): void {
    for (const report of CARET_REPORTS) {
        const provider = new VirtualContentProvider(report.gone);
        context.subscriptions.push(
            workspace.registerTextDocumentContentProvider(report.scheme, provider),
            commands.registerCommand(report.command, async (uri?: Uri, position?: Position) => {
                await showCaretReport(client, provider, report, uri, position);
            })
        );
        if (report.codeLens) {
            context.subscriptions.push(
                languages.registerCodeLensProvider({ scheme: 'file', language: 'rules' }, report.codeLens())
            );
        }
    }
}
