import {
    EventEmitter,
    Position,
    QuickInputButton,
    QuickPickItem,
    TextDocumentContentProvider,
    ThemeIcon,
    Uri,
    commands,
    l10n,
    window,
} from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';

/** The virtual-document scheme the rendered schema documentation is served under. */
export const SCHEMA_DOC_SCHEME = 'cosmoteer-schema-doc';

/** The server command that scaffolds a found field at the caret. */
const INSERT_SCHEMA_FIELD_COMMAND = 'cosmoteer.insertSchemaField';

/** How long typing settles before the next query goes out. */
const QUERY_DEBOUNCE_MS = 120;

/** One search hit, mirroring the server's `SchemaSearchHit`. */
interface SchemaSearchHit {
    id: string;
    kind: 'type' | 'field' | 'enum' | 'enumMember' | 'registry';
    label: string;
    owner: string;
    detail: string;
    prose?: string;
    insertable?: boolean;
    dead?: boolean;
    deprecated?: boolean;
    modContributed?: boolean;
}

/** One search answer, mirroring the server's `SchemaSearchResult`. */
interface SchemaSearchResult {
    hits: SchemaSearchHit[];
    total: number;
    truncated: boolean;
    contextClass?: string;
    contextClassName?: string;
}

/** What the insert command answers with, mirroring the server's `InsertSchemaFieldResult`. */
interface InsertSchemaFieldResult {
    inserted: boolean;
    field?: string;
    failure?: string;
}

/** A picker row that remembers which hit it came from. */
interface SchemaQuickPickItem extends QuickPickItem {
    hit: SchemaSearchHit;
}

/** The caret the picker was opened from, captured once so no query waits on the workspace index. */
interface CaretContext {
    uri: Uri;
    position: Position;
    version: number;
}

/**
 * Serves the schema documentation of a picked hit as a read-only virtual document, so the built-in
 * markdown preview renders it without writing a file into the user's mod.
 */
export class SchemaDocContentProvider implements TextDocumentContentProvider {
    private readonly contentByUri = new Map<string, string>();
    private readonly changeEmitter = new EventEmitter<Uri>();
    public readonly onDidChange = this.changeEmitter.event;

    /** Stores (or refreshes) the markdown behind a documentation uri and notifies open previews. */
    public set(uri: Uri, markdown: string): void {
        this.contentByUri.set(uri.toString(), markdown);
        this.changeEmitter.fire(uri);
    }

    public provideTextDocumentContent(uri: Uri): string {
        return (
            this.contentByUri.get(uri.toString()) ??
            l10n.t('This documentation is no longer available. Run the command again.')
        );
    }
}

/** Why an insert did nothing, in a sentence the user can act on. */
const insertFailureMessage = (failure: string | undefined, label: string): string => {
    switch (failure) {
        case 'stale':
            return l10n.t('The file changed while the search was open, so nothing was written.');
        case 'classMismatch':
            return l10n.t('{0} is not a field of the group the cursor is in, so nothing was written.', label);
        case 'noContext':
            return l10n.t('The cursor is not in a group whose type is known, so nothing was written.');
        case 'editRejected':
            return l10n.t('The editor turned down the change, so nothing was written.');
        default:
            return l10n.t('{0} could not be written at the cursor.', label);
    }
};

/** The row a hit is rendered as: the name, who declares it, and what it is followed by its prose. */
const toItem = (hit: SchemaSearchHit, insertButton: QuickInputButton): SchemaQuickPickItem => {
    const marks = [
        hit.deprecated ? l10n.t('⚠ removed') : undefined,
        hit.dead && !hit.deprecated ? l10n.t('⚠ never read') : undefined,
        hit.modContributed ? l10n.t('code mod') : undefined,
    ].filter((mark): mark is string => !!mark);
    return {
        label: hit.label,
        description: [hit.owner, ...marks].join(' · '),
        detail: hit.prose ? `${hit.detail} — ${hit.prose}` : hit.detail,
        // Load-bearing: without it VS Code applies its own fuzzy filter to the typed value and throws
        // the server's ranking away, which silently drops every hit matched on its prose alone.
        alwaysShow: true,
        buttons: hit.insertable ? [insertButton] : undefined,
        hit,
    };
};

/**
 * Opens the live schema search: a picker that queries the server on every keystroke, opens the
 * documentation of whatever is accepted, and scaffolds a field straight into the file when the
 * caret's group can legally carry it.
 *
 * @param client the running language client the requests are sent through.
 * @param provider the content provider the rendered documentation is served from.
 * @returns a promise that settles when the picker is closed.
 */
export async function showSchemaSearch(client: LanguageClient, provider: SchemaDocContentProvider): Promise<void> {
    const editor = window.activeTextEditor;
    // Read the caret once. The position rides along only on the first request, so no keystroke ever
    // waits on the workspace index the caret's class resolution needs.
    const caret: CaretContext | undefined =
        editor && editor.document.languageId === 'rules'
            ? { uri: editor.document.uri, position: editor.selection.active, version: editor.document.version }
            : undefined;

    const insertButton: QuickInputButton = {
        iconPath: new ThemeIcon('add'),
        tooltip: l10n.t('Write this field at the cursor'),
    };
    const picker = window.createQuickPick<SchemaQuickPickItem>();
    picker.placeholder = l10n.t('Search schema types, fields, and field descriptions');
    // The server already ranked the hits, and the rows carry prose the query does not appear in.
    picker.matchOnDescription = false;
    picker.matchOnDetail = false;

    let contextClassName: string | undefined;
    let queryTicket = 0;
    let debounce: ReturnType<typeof setTimeout> | undefined;

    /** The title line: what the caret is in, and how much of the result was left out. */
    const setTitle = (result: SchemaSearchResult | undefined): void => {
        const scope = contextClassName
            ? l10n.t('Cursor is in {0}', contextClassName)
            : l10n.t('Search the whole schema');
        picker.title = result?.truncated
            ? l10n.t('{0}, showing {1} of {2} matches', scope, result.hits.length, result.total)
            : scope;
    };

    const runQuery = async (query: string, withCaret: boolean): Promise<void> => {
        const ticket = ++queryTicket;
        picker.busy = true;
        try {
            const result = await client.sendRequest<SchemaSearchResult | null>('cosmoteer/schemaSearch', {
                query,
                ...(withCaret && caret
                    ? {
                          textDocument: { uri: caret.uri.toString() },
                          position: { line: caret.position.line, character: caret.position.character },
                      }
                    : {}),
            });
            // A slower earlier query must not overwrite the rows of a later one.
            if (ticket !== queryTicket) return;
            if (result?.contextClassName) contextClassName = result.contextClassName;
            picker.items = (result?.hits ?? []).map((hit) => toItem(hit, insertButton));
            setTitle(result ?? undefined);
        } catch {
            if (ticket !== queryTicket) return;
            picker.items = [];
            setTitle(undefined);
        } finally {
            if (ticket === queryTicket) picker.busy = false;
        }
    };

    const openDocumentation = async (hit: SchemaSearchHit): Promise<void> => {
        const markdown = await client
            .sendRequest<string | null>('cosmoteer/schemaSearchDetail', { id: hit.id })
            .catch(() => null);
        if (!markdown) {
            void window.showWarningMessage(l10n.t('No documentation is available for {0}.', hit.label));
            return;
        }
        // One stable uri per subject, so opening the same hit twice refreshes the preview instead of
        // stacking tabs. The entry id rides along in the query to keep two same-named hits apart.
        const documentUri = Uri.from({ scheme: SCHEMA_DOC_SCHEME, path: `/${hit.label}.md`, query: hit.id });
        provider.set(documentUri, markdown);
        await commands.executeCommand('markdown.showPreview', documentUri);
    };

    const insertField = async (hit: SchemaSearchHit): Promise<void> => {
        if (!caret) return;
        const result = (await client
            .sendRequest(ExecuteCommandRequest.type, {
                command: INSERT_SCHEMA_FIELD_COMMAND,
                arguments: [
                    {
                        uri: caret.uri.toString(),
                        position: { line: caret.position.line, character: caret.position.character },
                        id: hit.id,
                        documentVersion: caret.version,
                    },
                ],
            })
            .catch(() => null)) as InsertSchemaFieldResult | null;
        if (result?.inserted) {
            void window.showInformationMessage(l10n.t('Wrote {0} at the cursor.', result.field ?? hit.label));
            return;
        }
        void window.showWarningMessage(insertFailureMessage(result?.failure, hit.label));
    };

    picker.onDidChangeValue((value) => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void runQuery(value, false), QUERY_DEBOUNCE_MS);
    });
    picker.onDidTriggerItemButton((event) => void insertField(event.item.hit).then(() => picker.hide()));
    picker.onDidAccept(() => {
        const picked = picker.selectedItems[0];
        picker.hide();
        if (picked) void openDocumentation(picked.hit);
    });

    setTitle(undefined);
    picker.show();
    // The opening request carries the caret, so the picker starts on the class the cursor is in.
    void runQuery('', true);
    await new Promise<void>((resolve) => {
        picker.onDidHide(() => {
            if (debounce) clearTimeout(debounce);
            picker.dispose();
            resolve();
        });
    });
}
