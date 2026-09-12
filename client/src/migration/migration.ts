import { commands, ExtensionContext, l10n, Uri, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { DiffPreviewFile, DiffPreviewProvider, showDiffPreview, showPatchPreview } from '../preview/diff-preview';

/**
 * Bringing a mod up to the current game version: the whole workspace from the palette, or one
 * deprecation across every file from the lightbulb. The server computes and applies the rewrite, and
 * this side asks what to include, shows the rewrite as a diff and reports what happened.
 */

/**
 * The command the server's "apply this deprecation to the whole mod" fix carries. The server does not
 * claim it, so the editor runs this instead and the rewrite is shown as a diff before it happens.
 */
export const MIGRATE_SYMBOL_LOCAL_COMMAND = 'cosmoteer.migrateSymbolFromAction';

/** Mirror of the server's bulk-migration arguments (see server features/migration/migrate-symbol.ts). */
interface MigrateSymbolArgs {
    symbol: string;
    uri: string;
    dryRun?: boolean;
}

/** Mirror of the server's migration summary (see server features/migration/migrate-workspace.ts). */
interface MigrationSummary {
    files: number;
    fixes: number;
    byVersion: Record<string, number>;
    manual: Array<{ uri: string; line: number; message: string }>;
    deadFieldsRemoved: number;
    unparsable: number;
    /** Present only for a dry run, which changes nothing and answers with what it would have done. */
    preview?: {
        diff: string;
        changed: Array<{ fsPath: string; after: string }>;
        omitted: number;
        diffTruncated: boolean;
    };
}

/**
 * Show what a migration would do without doing it: the editor's own side-by-side diff over the files
 * it would rewrite, and a message saying what the view leaves out. A whole-mod migration can cover
 * more files than one message can carry, so the server caps what it sends and the counts here come
 * from the full run rather than from the capped view.
 *
 * @param summary the dry run's summary, whose `preview` carries the changes.
 * @param provider the content provider the rewritten contents are served from.
 * @param apply what to run when the user asks for the change. Absent for the whole-workspace
 * migration, which runs its own palette command.
 * @returns once the diff is open and the message shown.
 */
async function showMigrationPreview(
    summary: MigrationSummary,
    provider: DiffPreviewProvider,
    apply?: () => Promise<void>
): Promise<void> {
    const preview = summary.preview;
    if (!preview) return;
    if (summary.files === 0) {
        window.showInformationMessage(l10n.t('Cosmoteer migration: everything is already up to date.'));
        return;
    }
    const title = l10n.t('Migration preview');
    const changed: DiffPreviewFile[] = preview.changed.map((file) => ({ ...file, created: false }));
    if (changed.length > 0) await showDiffPreview(provider, 'migration', changed, title);
    else await showPatchPreview(provider, 'migration', preview.diff);

    const parts = [l10n.t('{0} fixes in {1} files', summary.fixes, summary.files)];
    if (summary.manual.length > 0) parts.push(l10n.t('{0} findings need manual review', summary.manual.length));
    if (preview.omitted > 0) parts.push(l10n.t('{0} more files are not shown', preview.omitted));
    if (preview.diffTruncated) parts.push(l10n.t('the diff stops short of the last files'));
    const choice = await window.showInformationMessage(
        l10n.t('Cosmoteer migration preview: {0}. Nothing was changed.', parts.join(', ')),
        l10n.t('Apply migrations')
    );
    if (!choice) return;
    if (apply) await apply();
    else await commands.executeCommand('cosmoteer.migrateMod');
}

/**
 * Render the migration outcome: a one-line information message, with a details view (a markdown
 * report listing per-version counts and every manual-review finding) behind a button.
 *
 * @param summary the server's migration summary.
 */
async function showMigrationSummary(summary: MigrationSummary): Promise<void> {
    if (summary.fixes === 0 && summary.deadFieldsRemoved === 0 && summary.manual.length === 0) {
        window.showInformationMessage(l10n.t('Cosmoteer migration: everything is already up to date.'));
        return;
    }
    const pieces: string[] = [];
    if (summary.fixes > 0) pieces.push(l10n.t('applied {0} fixes in {1} files', summary.fixes, summary.files));
    if (summary.deadFieldsRemoved > 0) pieces.push(l10n.t('removed {0} dead fields', summary.deadFieldsRemoved));
    if (summary.manual.length > 0) pieces.push(l10n.t('{0} findings need manual review', summary.manual.length));
    if (summary.unparsable > 0) pieces.push(l10n.t('skipped {0} files with parse errors', summary.unparsable));
    const details = l10n.t('Show Details');
    const picked = await window.showInformationMessage(l10n.t('Cosmoteer migration: {0}.', pieces.join(', ')), details);
    if (picked !== details) return;
    const doc = await workspace.openTextDocument({ content: migrationReport(summary), language: 'markdown' });
    await window.showTextDocument(doc, { preview: true });
}

/**
 * The markdown details report for a migration run: fixes grouped by the game version that made each
 * change, the optional dead-field cleanup, and a clickable list of manual-review findings.
 *
 * @param summary the server's migration summary.
 * @returns the report as markdown text.
 */
function migrationReport(summary: MigrationSummary): string {
    const lines: string[] = ['# Cosmoteer migration report', ''];
    lines.push(l10n.t('Applied {0} fixes in {1} files.', summary.fixes, summary.files), '');
    const versions = Object.entries(summary.byVersion).sort(([a], [b]) =>
        a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true })
    );
    for (const [version, count] of versions) {
        lines.push(
            `- ${version === '' ? l10n.t('pre-changelog game versions') : l10n.t('game version {0}', version)}: ${count}`
        );
    }
    if (summary.deadFieldsRemoved > 0) {
        lines.push('', l10n.t('Removed {0} fields the game never reads.', summary.deadFieldsRemoved));
    }
    if (summary.unparsable > 0) {
        lines.push('', l10n.t('Skipped {0} files with parse errors (never edited mechanically).', summary.unparsable));
    }
    if (summary.manual.length > 0) {
        lines.push('', `## ${l10n.t('Needs manual review')}`, '');
        for (const finding of summary.manual) {
            const file = Uri.parse(finding.uri).fsPath;
            lines.push(`- ${file}:${finding.line} ${finding.message}`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * Registers the whole-workspace migration and the one-symbol migration the lightbulb offers.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the commands run through.
 * @param provider the content provider the rewritten files are served from.
 */
export function registerMigration(
    context: ExtensionContext,
    client: LanguageClient,
    provider: DiffPreviewProvider
): void {
    // Workspace migration: one command that upgrades every rules file to the current game version
    // (deprecation-registry renames, deletions, and rewrites). The server computes and applies the
    // WorkspaceEdit, so this wrapper only asks about the optional dead-field cleanup and renders
    // the returned summary. A distinct command id from the server's executeCommand id, because the
    // language client auto-registers that one as a plain no-feedback forwarder.
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.migrateMod', async () => {
            const choice = await window.showQuickPick(
                [
                    {
                        label: l10n.t('Preview the migration'),
                        description: l10n.t('Show every change as a diff without writing anything'),
                        removeDeadFields: false,
                        dryRun: true,
                    },
                    {
                        label: l10n.t('Apply migrations'),
                        description: l10n.t('Rename, rewrite, or remove fields changed by game updates'),
                        removeDeadFields: false,
                        dryRun: false,
                    },
                    {
                        label: l10n.t('Apply migrations and remove dead fields'),
                        description: l10n.t('Additionally remove fields the game never reads'),
                        removeDeadFields: true,
                        dryRun: false,
                    },
                ],
                { placeHolder: l10n.t('Migrate every rules file of this workspace to the current game version') }
            );
            if (!choice) return;
            const summary = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.migrateWorkspace',
                arguments: [{ removeDeadFields: choice.removeDeadFields, dryRun: choice.dryRun }],
            })) as MigrationSummary | null;
            if (!summary) {
                window.showInformationMessage(l10n.t('Cosmoteer migration: no workspace folder is open.'));
                return;
            }
            if (summary.preview) {
                await showMigrationPreview(summary, provider);
                return;
            }
            await showMigrationSummary(summary);
        }),
        // The command the server's whole-mod deprecation fix carries. The server does not claim it,
        // so the editor runs this and the author reads the rewrite as a diff before it happens.
        commands.registerCommand(MIGRATE_SYMBOL_LOCAL_COMMAND, async (args?: MigrateSymbolArgs) => {
            if (!args?.symbol || !args.uri) return;
            const run = async (dryRun: boolean) =>
                (await client.sendRequest(ExecuteCommandRequest.type, {
                    command: 'cosmoteer.migrateSymbol',
                    arguments: [{ symbol: args.symbol, uri: args.uri, dryRun }],
                })) as MigrationSummary | null;
            const preview = await run(true);
            if (!preview) {
                window.showInformationMessage(l10n.t('Cosmoteer migration: no workspace folder is open.'));
                return;
            }
            // Nothing to rewrite is the normal answer for a deprecation written once, and it has to
            // be said, or the fix looks like it did nothing.
            if (preview.files === 0) {
                window.showInformationMessage(
                    preview.manual.length > 0
                        ? l10n.t(
                              'Cosmoteer: {0} findings need manual review, nothing can be changed mechanically.',
                              preview.manual.length
                          )
                        : l10n.t('Cosmoteer: nothing else in this mod needs that change.')
                );
                return;
            }
            await showMigrationPreview(preview, provider, async () => {
                const summary = await run(false);
                if (summary) await showMigrationSummary(summary);
            });
        })
    );
}
