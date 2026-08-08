import * as path from 'path';
import {
    workspace,
    ExtensionContext,
    l10n,
    commands,
    languages,
    window,
    Position,
    Uri,
    TextDocument,
    MarkdownString,
    ConfigurationTarget,
    ProgressLocation,
} from 'vscode';

import {
    ExecuteCommandRequest,
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';
import { SharedDiagnosticCollectionProvider } from './diagnostic-collection';
import { ShaderPreviewCodeLensProvider } from './shader-preview/codelens';
import { ShaderPreviewPanel } from './shader-preview/preview-panel';
import { PartGridCodeLensProvider } from './part-editor/codelens';
import { PartGridEditorPanel } from './part-editor/editor-panel';
import {
    MOD_OVERVIEW_SCHEME,
    ModOverviewCodeLensProvider,
    ModOverviewContentProvider,
    showModOverview,
} from './mod-overview/mod-overview';
import {
    SHARED_BASE_DIFF_SCHEME,
    SharedBaseDiffProvider,
    showSharedBaseDiff,
    showSharedBasePatch,
    SharedBasePreviewFile,
} from './shared-base/preview';
import { ApplyCleanup, openDocumentPaths, saveAndTidy, setPreviewScheme } from './shared-base/apply-cleanup';

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
    // The server is implemented in node
    const serverModule = context.asAbsolutePath(path.join('out', 'server', 'src', 'server.mjs'));

    const bundle = l10n.uri ? { EXTENSION_BUNDLE_PATH: l10n.uri?.fsPath } : undefined;

    const serverOptions: ServerOptions = {
        run: {
            module: serverModule,
            options: {
                env: {
                    ...bundle,
                },
            },
            transport: TransportKind.ipc,
        },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: {
                env: {
                    ...bundle,
                },
            },
        },
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'rules' },
            // `.shader` files get semantic-token highlighting (and future shader features) from the
            // same server. The server branches on the URI extension.
            { scheme: 'file', language: 'cosmoteer-shader' },
        ],
        synchronize: {
            // Notify the server about file changes to '.clientrc files contained in the workspace
            fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
        },
        progressOnInitialization: true,
        // The server answers open files through the pull model and pushes the whole-mod pass for the
        // rest, so both models write to the Problems panel. One collection for both keeps a file
        // that moves between them from being listed twice.
        diagnosticCollectionProvider: new SharedDiagnosticCollectionProvider(),
        middleware: {
            // Server hovers can end with an "Open in decompiler" command link (opt-in via
            // `decompiler.showInHover`). VS Code only executes command links from trusted
            // markdown, and the protocol has no way to mark it, so trust exactly that one
            // command here on the converted hover.
            provideHover: async (document, position, token, next) => {
                const hover = await next(document, position, token);
                for (const content of hover?.contents ?? []) {
                    if (content instanceof MarkdownString) {
                        content.isTrusted = { enabledCommands: [OPEN_IN_DECOMPILER_COMMAND] };
                    }
                }
                return hover;
            },
        },
    };

    claimShaderFiles(context);

    client = new LanguageClient('cosmoteer lsp', 'Cosmoteer Language Server', serverOptions, clientOptions);

    client.onRequest('cosmoteer/openSettings', async (params) => {
        await commands.executeCommand('workbench.action.openSettings2', params);
    });

    // Whole-mod validation is on by default, which is work the user never asked for. Tell them once,
    // the first time it actually costs something, and offer the switch right there.
    client.onNotification('cosmoteer/workspaceValidated', async (params: WorkspaceValidatedParams) => {
        await showWorkspaceValidationNotice(context, params);
    });

    // Live shader preview: a CodeLens above each `Shader = …` and a command that opens the WebGL
    // preview for the material at a position (the lens passes it, the palette uses the cursor).
    context.subscriptions.push(
        languages.registerCodeLensProvider({ scheme: 'file', language: 'rules' }, new ShaderPreviewCodeLensProvider()),
        commands.registerCommand('cosmoteer.previewShader', async (uri?: Uri, position?: Position) => {
            const editor = window.activeTextEditor;
            const targetUri = uri ?? editor?.document.uri;
            const targetPosition = position ?? editor?.selection.active;
            if (!targetUri || !targetPosition) return;
            await ShaderPreviewPanel.show(context, client, targetUri, targetPosition);
        })
    );

    // Part grid editor: a CodeLens above each root `Part` group and a command that opens the
    // interactive grid editor for the part at a position (the lens passes it, the palette uses the
    // cursor).
    context.subscriptions.push(
        languages.registerCodeLensProvider({ scheme: 'file', language: 'rules' }, new PartGridCodeLensProvider()),
        commands.registerCommand('cosmoteer.editPartGrid', async (uri?: Uri, position?: Position) => {
            const editor = window.activeTextEditor;
            const targetUri = uri ?? editor?.document.uri;
            const targetPosition = position ?? editor?.selection.active;
            if (!targetUri || !targetPosition) return;
            await PartGridEditorPanel.show(context, client, targetUri, targetPosition);
        })
    );

    // Mod overview: a CodeLens on a mod manifest and a command that render what the manifest does
    // (its actions with resolution status, and the mod's unreachable files) as a markdown preview.
    const modOverviewProvider = new ModOverviewContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(MOD_OVERVIEW_SCHEME, modOverviewProvider),
        languages.registerCodeLensProvider({ scheme: 'file', language: 'rules' }, new ModOverviewCodeLensProvider()),
        commands.registerCommand('cosmoteer.showModOverview', async (uri?: Uri) => {
            await showModOverview(client, modOverviewProvider, uri);
        })
    );

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
                        label: l10n.t('Apply migrations'),
                        description: l10n.t('Rename, rewrite, or remove fields changed by game updates'),
                        removeDeadFields: false,
                    },
                    {
                        label: l10n.t('Apply migrations and remove dead fields'),
                        description: l10n.t('Additionally remove fields the game never reads'),
                        removeDeadFields: true,
                    },
                ],
                { placeHolder: l10n.t('Migrate every rules file of this workspace to the current game version') }
            );
            if (!choice) return;
            const summary = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.migrateWorkspace',
                arguments: [{ removeDeadFields: choice.removeDeadFields }],
            })) as MigrationSummary | null;
            if (!summary) {
                window.showInformationMessage(l10n.t('Cosmoteer migration: no workspace folder is open.'));
                return;
            }
            await showMigrationSummary(summary);
        })
    );

    // Code mod schema: a command that re-reads every mod assembly and merges the types it declares
    // into the schema, so a mod's own `Type=` discriminators and fields resolve. The server loads
    // the cached result at startup on its own, so this is for picking up a mod that was just built
    // or installed. A distinct command id from the server's executeCommand id, for the same reason
    // as the migration above.
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.buildModSchemaFromMods', async () => {
            const summary = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.buildModSchema',
                arguments: [],
            })) as ModSchemaSummary | null;
            if (!summary) {
                window.showInformationMessage(l10n.t('Cosmoteer code mod schema: no workspace folder is open.'));
                return;
            }
            if (summary.disabled) {
                window.showInformationMessage(
                    l10n.t(
                        'Cosmoteer code mod schema: code mod support is turned off (cosmoteerLSPRules.codeMods.enabled).'
                    )
                );
                return;
            }
            if (summary.types === 0) {
                window.showInformationMessage(
                    l10n.t('Cosmoteer code mod schema: no code mod assemblies found, nothing to add.')
                );
                return;
            }
            window.showInformationMessage(
                l10n.t(
                    'Cosmoteer code mod schema: added {0} types and {1} discriminators from {2} assemblies.',
                    summary.types,
                    summary.discriminators,
                    summary.assemblies
                )
            );
        })
    );

    // Shared base extraction: a command that sweeps the mod for fields several files write word for
    // word and turns the set the user picks into a base file all of them inherit, the way the game's
    // own data and the larger mods are written. The server ranks the extractions, writes the base file
    // and applies the multi-file edit, so this wrapper only offers the plans and renders the returned
    // summary. A distinct command id from the server's executeCommand id, for the same reason as the
    // migration above.
    const sharedBaseDiffProvider = new SharedBaseDiffProvider();
    setPreviewScheme(SHARED_BASE_DIFF_SCHEME);
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(SHARED_BASE_DIFF_SCHEME, sharedBaseDiffProvider),
        commands.registerCommand('cosmoteer.extractSharedBaseFiles', async () => {
            const scan = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.extractSharedBase',
                arguments: [{}],
            })) as SharedBaseScanResult | null;
            if (!scan) {
                window.showInformationMessage(l10n.t('Cosmoteer shared base: the search could not be completed.'));
                return;
            }
            if (scan.plans.length === 0) {
                window.showInformationMessage(
                    l10n.t(
                        'Cosmoteer shared base: nothing worth extracting in {0} files, no group repeats another one word for word.',
                        scan.filesScanned
                    )
                );
                return;
            }
            const plan = await pickSharedBasePlan(scan.plans);
            if (plan) await previewAndApplySharedBase(plan, sharedBaseDiffProvider);
        }),
        // The command the server's lightbulb refactoring carries. The server does not declare it, so
        // the editor runs this rather than forwarding it, and the rewrite gets a real diff.
        commands.registerCommand(EXTRACT_SHARED_BASE_LOCAL_COMMAND, async (plan?: SharedBasePlan) => {
            if (plan) await previewAndApplySharedBase(plan, sharedBaseDiffProvider);
        })
    );

    return client.start();
}

/** What the server reports after a whole-mod validation pass (see server.ts `announceWorkspaceValidation`). */
interface WorkspaceValidatedParams {
    files: number;
    fresh: number;
    elapsedMs: number;
    scope: 'allFiles' | 'modRulesReachable';
}

/** Remembers that the whole-mod validation notice has been shown, so it is shown exactly once. */
const WORKSPACE_VALIDATION_NOTICE_KEY = 'cosmoteer.workspaceValidationNoticeShown';

/**
 * Tell the user once that the whole mod is validated, not just their open tabs, and let them switch
 * it off without going looking for the setting.
 *
 * The server only reports a pass that actually did work, so a project where this is instant never
 * produces the notice at all — and the flag stays unset, so the first genuinely large project the
 * user opens is still the one that tells them.
 *
 * @param context the extension context, whose global state remembers that the notice was shown.
 * @param params what the pass covered.
 * @returns once the user answered or dismissed the notice.
 */
async function showWorkspaceValidationNotice(
    context: ExtensionContext,
    params: WorkspaceValidatedParams
): Promise<void> {
    if (context.globalState.get<boolean>(WORKSPACE_VALIDATION_NOTICE_KEY)) return;
    await context.globalState.update(WORKSPACE_VALIDATION_NOTICE_KEY, true);

    const openFilesOnly = l10n.t('Only open files');
    const settingsAction = l10n.t('Settings');
    const message =
        params.scope === 'modRulesReachable'
            ? l10n.t(
                  'Cosmoteer: the Problems panel now covers your whole mod, not just open files. {0} files the mod.rules actions load were validated, and the results are cached, so later starts are fast.',
                  params.files
              )
            : l10n.t(
                  'Cosmoteer: the Problems panel now covers your whole workspace, not just open files. {0} files were validated, and the results are cached, so later starts are fast.',
                  params.files
              );
    const choice = await window.showInformationMessage(message, openFilesOnly, settingsAction);
    if (choice === openFilesOnly) {
        await workspace
            .getConfiguration('cosmoteerLSPRules')
            .update('diagnostics.validateWholeWorkspace', false, ConfigurationTarget.Global);
    } else if (choice === settingsAction) {
        await commands.executeCommand('workbench.action.openSettings2', {
            query: 'cosmoteerLSPRules.diagnostics.validateWholeWorkspace',
        });
    }
}

/** Mirror of the server's code mod schema summary (see server features/mod-schema/mod-schema.ts). */
interface ModSchemaSummary {
    assemblies: number;
    types: number;
    discriminators: number;
    fromCache: boolean;
    unreadable: string[];
    /** Set when `codeMods.enabled` is off, so the command says so instead of "nothing found". */
    disabled?: boolean;
}

// The command id schema-hover "Open in decompiler" links invoke. The language client registers
// the VS Code command itself from the server's `executeCommandProvider` capability and forwards
// invocations to the server (which finds and spawns the decompiler), so the extension must not
// register it too. This constant only feeds the `enabledCommands` trust list in the hover
// middleware and must match the server's decompiler-link module.
const OPEN_IN_DECOMPILER_COMMAND = 'cosmoteer.openInDecompiler';

/**
 * The command the server's lightbulb refactoring carries. The server deliberately does not claim it,
 * so the editor resolves it here and the rewrite can be shown as a real diff before it happens.
 */
const EXTRACT_SHARED_BASE_LOCAL_COMMAND = 'cosmoteer.extractSharedBaseFromAction';

/** Mirror of the server's migration summary (see server features/migration/migrate-workspace.ts). */
interface MigrationSummary {
    files: number;
    fixes: number;
    byVersion: Record<string, number>;
    manual: Array<{ uri: string; line: number; message: string }>;
    deadFieldsRemoved: number;
    unparsable: number;
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
        lines.push(`- ${version === '' ? l10n.t('pre-changelog game versions') : l10n.t('game version {0}', version)}: ${count}`);
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

/** Which duplication a plan came from, and so whether it writes a new base file or extends one. */
type SharedBaseTier = 'sharedBase' | 'cloneFamily' | 'existingBase';

/** Mirror of the server's serialized extraction plan (see server features/refactor/shared-base/plan.types.ts). */
interface SharedBasePlan {
    id: string;
    tier: SharedBaseTier;
    className: string;
    groupName: string;
    fields: string[];
    participants: Array<{ uri: string; fsPath: string; offset: number }>;
    donor: { uri: string; fsPath: string; offset: number };
    baseFsPath: string;
    inheritedRef?: string;
    savedBytes: number;
    /** The server's ready-made one-line description, so both clients word a plan the same way. */
    label: string;
}

/** Mirror of the server's sweep answer (see server features/refactor/shared-base/shared-base.command.ts). */
interface SharedBaseScanResult {
    kind: 'scan';
    plans: SharedBasePlan[];
    filesScanned: number;
}

/** Mirror of the server's extraction answer (same module). */
interface SharedBaseApplyResult {
    kind: 'apply';
    created: string;
    /** Every file the workspace edit changed, so they can be saved and tidied away. */
    changedFiles: string[];
    tier: SharedBaseTier;
    files: number;
    fields: number;
    removedBytes: number;
    failure?: SharedBaseFailure;
}

/** Mirror of the server's preview answer (same module). */
interface SharedBasePreviewResult {
    kind: 'preview';
    diff: string;
    /** The changed files with their rewritten contents, capped by the server. */
    changed: SharedBasePreviewFile[];
    /** How many changed files did not fit in {@link SharedBasePreviewResult.changed}. */
    omitted: number;
    baseFsPath: string;
    tier: SharedBaseTier;
    files: number;
    fields: number;
    removedBytes: number;
    failure?: SharedBaseFailure;
}

/** Why an extraction did not happen, as the server words it. */
type SharedBaseFailure = 'planStale' | 'baseFileExists' | 'notEditable' | 'editRejected';

/**
 * Offer the sweep's extractions and let the user pick one to look at.
 *
 * @param plans the plans the sweep reported, already ranked by how much duplication each removes.
 * @returns the picked plan, or undefined when the user backed out.
 */
async function pickSharedBasePlan(plans: SharedBasePlan[]): Promise<SharedBasePlan | undefined> {
    const picked = await window.showQuickPick(
        plans.map((plan) => ({
            label: plan.label,
            description: plan.className,
            detail: l10n.t(
                '{0}, removes {1} bytes of duplicated source',
                workspace.asRelativePath(plan.baseFsPath),
                plan.savedBytes
            ),
            plan,
        })),
        {
            placeHolder: l10n.t('Move fields several files of this mod repeat word for word into one shared base file'),
            matchOnDetail: true,
        }
    );
    return picked?.plan;
}

/**
 * The whole extraction exchange: work out what the plan would do, show it as a real diff, and apply
 * it only once the user says so. Shared by the palette command and the lightbulb, which the
 * middleware reroutes here so both get the editor's own diff rather than a patch to read.
 *
 * @param plan the plan to preview and apply.
 * @param provider the content provider the rewritten files are served from.
 * @returns once the extraction happened or the user backed out.
 */
async function previewAndApplySharedBase(plan: SharedBasePlan, provider: SharedBaseDiffProvider): Promise<void> {
    // Captured before the preview, not after: the diff opens the real file on its left-hand side, so
    // by the time it is on screen those files count as open and the tidy-up would leave them behind.
    const openBefore = openDocumentPaths();
    const preview = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.extractSharedBase',
        arguments: [{ plan, preview: true }],
    })) as SharedBasePreviewResult | null;
    if (!preview || preview.failure) {
        window.showWarningMessage(
            preview?.failure
                ? sharedBaseFailureMessage(preview.failure)
                : l10n.t('Cosmoteer shared base: the preview could not be built, nothing was changed.')
        );
        return;
    }
    const title = l10n.t('Shared base: {0}', path.basename(preview.baseFsPath));
    if (preview.changed.length > 0) await showSharedBaseDiff(provider, plan.id, preview.changed, title);
    else await showSharedBasePatch(provider, plan.id, preview.diff);

    if (!(await confirmSharedBaseRewrite(preview))) return;
    const result = await window.withProgress(
        { location: ProgressLocation.Notification, title: l10n.t('Extracting {0}', path.basename(preview.baseFsPath)) },
        async () =>
            (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.extractSharedBase',
                arguments: [{ plan }],
            })) as SharedBaseApplyResult | null
    );
    if (!result) {
        window.showWarningMessage(l10n.t('Cosmoteer shared base: the extraction failed, nothing was changed.'));
        return;
    }
    // A workspace edit over hundreds of files leaves every one of them open and unsaved, which is
    // not a state to hand back to anybody.
    const cleanup = result.failure ? undefined : await saveAndTidy(result.changedFiles, openBefore);
    await showSharedBaseSummary(result, cleanup);
}

/**
 * Have the user confirm the rewrite whose diff is now open beside the editor. Worth its click
 * because applying a plan writes or extends a file and edits every file that inherits it.
 *
 * @param preview the server's account of what the rewrite would do.
 * @returns true when the user asked for it to happen.
 */
async function confirmSharedBaseRewrite(preview: SharedBasePreviewResult): Promise<boolean> {
    const extract = l10n.t('Extract');
    const baseName = path.basename(preview.baseFsPath);
    const confirmed = await window.showInformationMessage(
        preview.tier === 'existingBase'
            ? l10n.t('Move {0} fields into {1}, the base those {2} files already inherit?', preview.fields, baseName, preview.files)
            : l10n.t('Create {0} and rewrite {1} files to inherit it?', baseName, preview.files),
        {
            modal: true,
            detail:
                preview.omitted > 0
                    ? l10n.t(
                          'The open diff shows {0} of the changed files. In total {1} fields leave {2} files, removing {3} bytes of duplicated source.',
                          preview.changed.length,
                          preview.fields,
                          preview.files,
                          preview.removedBytes
                      )
                    : l10n.t(
                          'The open diff is the whole change: {0} fields leave {1} files, removing {2} bytes of duplicated source.',
                          preview.fields,
                          preview.files,
                          preview.removedBytes
                      ),
        },
        extract
    );
    return confirmed === extract;
}

/**
 * Render the extraction outcome: a one-line information message, with the new base file behind a
 * button, or the reason nothing was changed.
 *
 * @param result the server's extraction summary.
 */
async function showSharedBaseSummary(result: SharedBaseApplyResult, cleanup?: ApplyCleanup): Promise<void> {
    if (result.failure) {
        window.showWarningMessage(sharedBaseFailureMessage(result.failure));
        return;
    }
    if (cleanup?.unsaved.length) {
        window.showWarningMessage(
            l10n.t(
                'Cosmoteer shared base: {0} files could not be saved and are still open with their changes. Save them yourself or undo.',
                cleanup.unsaved.length
            )
        );
    }
    const open = l10n.t('Open Base File');
    const tidied = cleanup?.saved
        ? ` ${l10n.t('{0} files saved, {1} tabs closed.', cleanup.saved, cleanup.closed)}`
        : '';
    const picked = await window.showInformationMessage(
        (result.tier === 'existingBase'
            ? l10n.t(
                  'Cosmoteer shared base: moved {1} fields into {0}, out of {2} files, removed {3} bytes.',
                  workspace.asRelativePath(result.created),
                  result.fields,
                  result.files,
                  result.removedBytes
              )
            : l10n.t(
                  'Cosmoteer shared base: created {0}, moved {1} fields out of {2} files, removed {3} bytes.',
                  workspace.asRelativePath(result.created),
                  result.fields,
                  result.files,
                  result.removedBytes
              )) + tidied,
        open
    );
    if (picked !== open) return;
    const doc = await workspace.openTextDocument(Uri.file(result.created));
    await window.showTextDocument(doc, { preview: true });
}

/**
 * Say why an extraction did not happen, one message per reason the server reports, each naming what
 * the user can do about it.
 *
 * @param failure the server's reason.
 * @returns the message to show.
 */
function sharedBaseFailureMessage(failure: SharedBaseFailure): string {
    switch (failure) {
        case 'planStale':
            return l10n.t(
                'Cosmoteer shared base: those files no longer write the same fields, so nothing was changed. Run the command again to search the current text.'
            );
        case 'baseFileExists':
            return l10n.t(
                'Cosmoteer shared base: a file of that name already sits next to those files, so nothing was changed. Rename or remove it and run the command again.'
            );
        case 'notEditable':
            return l10n.t(
                'Cosmoteer shared base: the base file could not be written, so nothing was changed. Check that its folder is writable.'
            );
        case 'editRejected':
            return l10n.t(
                'Cosmoteer shared base: the editor turned down the rewrite, so the base file was removed again and nothing was changed.'
            );
    }
}

/**
 * Cosmoteer `.shader` files are HLSL, but VS Code's built-in ShaderLab support also claims the
 * `.shader` extension (for Unity), so in a mixed setup a shader can open as `shaderlab`, which means
 * no Cosmoteer highlighting and no server features (our language never activates for it). Since this
 * extension only activates in a Cosmoteer project (a workspace with `.rules` files), we reassign such
 * files to the Cosmoteer Shader language on open so the user does not have to pick it by hand.
 *
 * It is deliberately conservative: it only reassigns files that opened under a generic claimant
 * (`shaderlab` or `plaintext`), never a language the user chose themselves, and it honours the
 * `cosmoteerLSPRules.associateShaderFiles` opt-out for anyone editing Unity shaders in the same window.
 *
 * @param context the extension context, used to dispose the open-document listener on shutdown.
 */
function claimShaderFiles(context: ExtensionContext): void {
    // The languages a `.shader` file may open under that we are willing to override.
    const GENERIC_CLAIMANTS = new Set(['shaderlab', 'plaintext']);
    const claim = (document: TextDocument): void => {
        if (!workspace.getConfiguration('cosmoteerLSPRules').get<boolean>('associateShaderFiles', true)) return;
        if (!document.fileName.toLowerCase().endsWith('.shader')) return;
        if (document.languageId === 'cosmoteer-shader' || !GENERIC_CLAIMANTS.has(document.languageId)) return;
        void languages.setTextDocumentLanguage(document, 'cosmoteer-shader');
    };
    workspace.textDocuments.forEach(claim);
    context.subscriptions.push(workspace.onDidOpenTextDocument(claim));
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
