import { commands, ExtensionContext, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { SCHEMA_DOC_SCHEME, SchemaDocContentProvider, showSchemaSearch } from './schema-search';

/**
 * Registers the schema search: one command that searches every schema type, field, enum member and
 * `Type=` registry plus the field documentation, opens a hit's documentation as a markdown preview,
 * and can write a found field straight into the group the cursor is in.
 *
 * The palette id deliberately differs from the server's executeCommand id
 * `cosmoteer.insertSchemaField`, because the language client auto-registers that one as a plain
 * no-feedback forwarder.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the search runs against.
 */
export function registerSchemaSearch(context: ExtensionContext, client: LanguageClient): void {
    const provider = new SchemaDocContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(SCHEMA_DOC_SCHEME, provider),
        commands.registerCommand('cosmoteer.searchSchema', async () => {
            await showSchemaSearch(client, provider);
        })
    );
}
