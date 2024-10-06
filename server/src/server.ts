import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    DocumentDiagnosticReportKind,
    type DocumentDiagnosticReport,
    CancellationToken,
    CancellationTokenSource,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from './lexer/lexer';
import { parser } from './parser/parser';
import { ParserResultRegistrar } from './registrar/parserResultRegistrar';
import { findNodeAtPosition } from './utils/ast.utils';
import { AutoCompletionService } from './autocompletion/autocompletion.service';
import { ValidationError, Validator } from './validation/validator';
import { ValidationForValue } from './validation/validator.value';
import { ValidationForFunctionCall } from './validation/validator.functioncall';

import * as l10n from '@vscode/l10n';
import { CosmoteerWorkspaceService } from './workspace/cosmoteer-workspace.service';
import { ValidationForAssignment } from './validation/validator.assignment';
import { ValidationForMath } from './validation/validator.math';
import { CancellationError } from './utils/cancellation';

export const MAX_NUMBER_OF_PROBLEMS = 10;

if (process.env['EXTENSION_BUNDLE_PATH']) {
    l10n.config({
        fsPath: process.env['EXTENSION_BUNDLE_PATH'],
    });
}

const connection = createConnection(ProposedFeatures.all);
CosmoteerWorkspaceService.instance.setConnection(connection);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize(async (params: InitializeParams) => {
    const capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );
    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Full,
            completionProvider: {
                resolveProvider: true,
            },
            diagnosticProvider: {
                interFileDependencies: true,
                workspaceDiagnostics: false,
            },
        },
    };
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true,
            },
        };
    }

    return result;
});

connection.onInitialized(async () => {
    Validator.instance.registerValidation(ValidationForValue);
    Validator.instance.registerValidation(ValidationForFunctionCall);
    Validator.instance.registerValidation(ValidationForAssignment);
    Validator.instance.registerValidation(ValidationForMath);
    const workspaceFolders = await connection.workspace.getWorkspaceFolders();

    if (workspaceFolders) {
        const settings = (await connection.workspace.getConfiguration({
            scopeUri: workspaceFolders[0].uri,
            section: 'cosmoteerLSPRules',
        })) as CosmoteerSettings;
        globalSettings = settings ?? defaultSettings;
        if (settings?.cosmoteerPath) {
            await CosmoteerWorkspaceService.instance.initialize(
                settings.cosmoteerPath,
                await connection.window.createWorkDoneProgress()
            );
        } else {
            connection.window
                .showErrorMessage(
                    l10n.t(
                        'Cosmoteer path not set, please set it in the extensions settings for Cosmoteer Rules Configuration. If you dont see this setting, than please restart vscode. This is required for the language server to work correctly.'
                    ),
                    {
                        title: 'Open Settings',
                        command: 'workbench.action.openSettings',
                    }
                )
                .then(() => {
                    connection.sendRequest('cosmoteer/openSettings', {
                        items: [
                            {
                                scopeUri: workspaceFolders[0].uri,
                                section: 'cosmoteerLSPRules',
                            },
                        ],
                    });
                });
        }
    }

    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders((_event) => {
            if (globalSettings.trace.server === 'verbose') {
                connection.console.log('Workspace folder change event received.');
            }
        });
    }
});

// documents.onDidChangeContent((change) => {
//     validateTextDocument(change.document);
// });

// The example settings
interface CosmoteerSettings {
    maxNumberOfProblems: number;
    cosmoteerPath: string;
    trace: {
        server: 'off' | 'messages' | 'verbose';
    };
    ignorePaths: string[];
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: CosmoteerSettings = {
    maxNumberOfProblems: MAX_NUMBER_OF_PROBLEMS,
    cosmoteerPath: '',
    trace: {
        server: 'off',
    },
    ignorePaths: [],
};
export let globalSettings: CosmoteerSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<CosmoteerSettings>> = new Map();

connection.onDidChangeConfiguration(async (change) => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    }
    if (change.settings?.cosmoteerLSPRules)
        globalSettings = <CosmoteerSettings>(change.settings?.cosmoteerLSPRules || defaultSettings);
    const workspaceFolders = await connection.workspace.getWorkspaceFolders();
    if ((change.settings?.cosmoteerLSPRules as CosmoteerSettings)?.cosmoteerPath && workspaceFolders) {
        CosmoteerWorkspaceService.instance.initialize(
            change.settings.cosmoteerLSPRules.cosmoteerPath,
            await connection.window.createWorkDoneProgress()
        );
    }
    if (change.settings?.cosmoteerLSPRules !== defaultSettings) connection.languages.diagnostics.refresh();
});

function getDocumentSettings(resource: string): Thenable<CosmoteerSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'cosmoteerLSPRules',
        });
        documentSettings.set(resource, result);
    }
    return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
    documentSettings.delete(e.document.uri);
});

const tokenSource = new CancellationTokenSource();

documents.onDidOpen(async (e) => {
    await connection.sendDiagnostics({
        uri: e.document.uri,
        version: e.document.version,
        diagnostics: await validateTextDocument(e.document, tokenSource.token),
    });
});

connection.languages.diagnostics.on(async (params, cancelToken) => {
    const document = documents.get(params.textDocument.uri);
    if (document !== undefined) {
        return {
            kind: DocumentDiagnosticReportKind.Full,
            items: await validateTextDocument(document, cancelToken),
            resultId: params.textDocument.uri,
        } satisfies DocumentDiagnosticReport;
    } else {
        // We don't know the document. We can either try to read it from disk
        // or we don't report problems for it.
        return {
            kind: DocumentDiagnosticReportKind.Full,
            items: [],
        } satisfies DocumentDiagnosticReport;
    }
});

async function validateTextDocument(textDocument: TextDocument, cancelToken: CancellationToken): Promise<Diagnostic[]> {
    const settings = await getDocumentSettings(textDocument.uri);
    const text = textDocument.getText();
    const tokens = lexer(text);
    if (cancelToken.isCancellationRequested) return [];
    const parserResult = parser(tokens, textDocument.uri);
    if (cancelToken.isCancellationRequested) return [];
    if (settings.trace.server === 'verbose') {
        console.dir(parserResult);
    }
    let problems = 0;
    const diagnostics: Diagnostic[] = [];

    ParserResultRegistrar.instance.setResult(textDocument.uri, parserResult.value);

    for (const error of parserResult.parserErrors) {
        problems++;
        if (problems > settings.maxNumberOfProblems) break;
        const diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Error,
            range: {
                start: textDocument.positionAt(error.token.start),
                end: textDocument.positionAt(error.token.end ?? error.token.start),
            },
            message: error.message,
            source: 'cosmoteer-language-server',
        };
        if (hasDiagnosticRelatedInformationCapability && error.addditionalInfo) {
            for (const info of error.addditionalInfo) {
                diagnostic.relatedInformation = [
                    {
                        location: {
                            uri: textDocument.uri,
                            range: Object.assign({}, diagnostic.range),
                        },
                        message: info.message,
                    },
                ];
            }
        }
        diagnostics.push(diagnostic);
    }

    let validationErrors: ValidationError[] = [];
    try {
        const pormises: Promise<ValidationError[]>[] = [];

        for (const node of parserResult.value.elements) {
            pormises.push(Validator.instance.validate(node, cancelToken));
        }
        validationErrors = (await Promise.all(pormises)).flat();
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
    }

    for (const error of validationErrors) {
        problems++;
        if (problems > settings.maxNumberOfProblems) break;
        const diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Error,
            range: {
                start: textDocument.positionAt(error.node.position.start),
                end: textDocument.positionAt(error.node.position.end),
            },
            message: error.message,
            source: 'cosmoteer-language-server',
        };
        if (hasDiagnosticRelatedInformationCapability && error.addditionalInfo) {
            diagnostic.relatedInformation = [
                {
                    location: {
                        uri: textDocument.uri,
                        range: Object.assign({}, diagnostic.range),
                    },
                    message: error.addditionalInfo,
                },
            ];
        }
        diagnostics.push(diagnostic);
    }
    return diagnostics;
}

connection.onDidChangeWatchedFiles((_change) => {
    // Monitored files have change in VSCode
    if (globalSettings.trace.server === 'verbose') {
        connection.console.log('We received a file change event');
    }
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
    async (textDocumentPosition: TextDocumentPositionParams, cancellationToken): Promise<CompletionItem[]> => {
        const parserResult = ParserResultRegistrar.instance.getResult(textDocumentPosition.textDocument.uri);
        let completions: string[] = [];
        try {
            if (parserResult) {
                const node = findNodeAtPosition(parserResult, textDocumentPosition?.position);
                if (node) {
                    completions = await AutoCompletionService.instance.getCompletions(node, cancellationToken);
                }
            }
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        }
        return completions.map<CompletionItem>((completion) => ({
            label: completion,
            kind: CompletionItemKind.Reference,
        }));
    }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    return item;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();