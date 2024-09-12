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
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from './lexer/lexer';
import { parser } from './parser/parser';
import { ParserResultRegistrar } from './registrar/parserResultRegistrar';
import { findNodeAtPosition } from './utils/ast.utils';
import { AutoCompletionService } from './autocompletion/autocompletion.service';
import { ValidationError, Validator } from './validation/validator';
import { ValidationForReference } from './validation/validator.reference';
import { ValidationForFunctionCall } from './validation/validator.functioncall';

import * as l10n from '@vscode/l10n';

export const MAX_NUMBER_OF_PROBLEMS = 10;

if (process.env['EXTENSION_BUNDLE_PATH']) {
    console.log('l10n.config');
    l10n.config({
        fsPath: process.env['EXTENSION_BUNDLE_PATH'],
    });
}

const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
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

connection.onInitialized(() => {
    Validator.instance.registerValidation(ValidationForReference);
    Validator.instance.registerValidation(ValidationForFunctionCall);
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(
            DidChangeConfigurationNotification.type,
            undefined
        );
    }
    if (hasWorkspaceFolderCapability) {
        // TODO Get cosmooters folder
        // console.log(homedir());
        // opendir(homedir(), async (err, dir) => {
        // 	if (err) {
        // 		console.error(err);
        // 		return;
        // 	}
        // 	const data  = await dir.read();
        // 	console.log(data?.isDirectory());
        // }
        // );
        connection.workspace.onDidChangeWorkspaceFolders((_event) => {
            connection.console.log('Workspace folder change event received.');
        });
        connection.sendProgress<string>(
            { __: ['test', { _$endMarker$_: 1 }], _pr: '100' },
            100,
            'Cosmoteer Language Server is ready'
        );
    }
});

// The example settings
interface CosmoteerSettings {
    maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: CosmoteerSettings = {
    maxNumberOfProblems: MAX_NUMBER_OF_PROBLEMS,
};
let globalSettings: CosmoteerSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<CosmoteerSettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    } else {
        globalSettings = <CosmoteerSettings>(
            (change.settings.languageServerExample || defaultSettings)
        );
    }
    // Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
    // We could optimize things here and re-fetch the setting first can compare it
    // to the existing setting, but this is out of scope for this example.
    connection.languages.diagnostics.refresh();
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

connection.languages.diagnostics.on(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document !== undefined) {
        return {
            kind: DocumentDiagnosticReportKind.Full,
            items: await validateTextDocument(document),
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

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
    validateTextDocument(change.document);
});

async function validateTextDocument(
    textDocument: TextDocument
): Promise<Diagnostic[]> {
    const settings = await getDocumentSettings(textDocument.uri);
    const text = textDocument.getText();
    const tokens = lexer(text);
    const parserResult = parser(tokens);

    let problems = 0;
    const diagnostics: Diagnostic[] = [];

    ParserResultRegistrar.instance.setResult(
        textDocument.uri,
        parserResult.value
    );

    const validationErrors: ValidationError[] = [];

    for (const node of parserResult.value.elements) {
        validationErrors.push(...Validator.instance.validate(node));
    }

    for (const error of parserResult.parserErrors) {
        problems++;
        if (problems > settings.maxNumberOfProblems) break;
        const diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Error,
            range: {
                start: textDocument.positionAt(error.token.start),
                end: textDocument.positionAt(
                    error.token.end ?? error.token.start
                ),
            },
            message: error.message,
            source: 'cosmoteer-language-server',
        };
        if (
            hasDiagnosticRelatedInformationCapability &&
            error.addditionalInfo
        ) {
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
        if (
            hasDiagnosticRelatedInformationCapability &&
            error.addditionalInfo
        ) {
            for (const info of error.addditionalInfo) {
                diagnostic.relatedInformation = [
                    {
                        location: {
                            uri: textDocument.uri,
                            range: Object.assign({}, diagnostic.range),
                        },
                        message: info,
                    },
                ];
            }
        }
        diagnostics.push(diagnostic);
    }
    return diagnostics;
}

connection.onDidChangeWatchedFiles((_change) => {
    // Monitored files have change in VSCode
    connection.console.log('We received a file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
    (textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
        const parserResult = ParserResultRegistrar.instance.getResult(
            textDocumentPosition.textDocument.uri
        );
        let completions: string[] = [];
        if (parserResult) {
            const node = findNodeAtPosition(
                parserResult,
                textDocumentPosition.position
            );
            if (node) {
                completions =
                    AutoCompletionService.instance.getCompletions(node);
            }
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
