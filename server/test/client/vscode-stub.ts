/**
 * Enough of the editor's own module for a client file to be imported outside the extension host.
 *
 * The client's real tests (`client/src/test/**`) run inside a VS Code window, which is right for
 * anything that drives the editor but far too heavy for a module whose whole job is deciding what to
 * do with an answer. Those modules were untestable until now, and two fixes shipped without a check
 * because of it. The vitest config maps `vscode` here so they can be imported directly.
 *
 * Only what a test actually needs lives here. A member this does not carry is a member no test has
 * reached yet, and adding it is one line.
 */

/** One diagnostic collection, recording what was set and cleared so a test can read it back. */
export class FakeDiagnosticCollection {
    public readonly entries = new Map<string, unknown[]>();
    public clears = 0;

    /**
     * Records a set, the way the editor's own collection would hold it.
     *
     * @param uri the file the diagnostics belong to.
     * @param diagnostics what to show for it.
     */
    public set(uri: { toString(): string }, diagnostics: unknown[]): void {
        this.entries.set(uri.toString(), diagnostics);
    }

    /** Records a clear of the whole collection. */
    public clear(): void {
        this.clears++;
        this.entries.clear();
    }

    /** Drops the collection, which a test only needs so a disposal path can run. */
    public dispose(): void {
        this.entries.clear();
    }
}

/** The collections handed out by {@link languages.createDiagnosticCollection}, newest last. */
export const createdCollections: FakeDiagnosticCollection[] = [];

/** What the editor was asked to show the user, in order. */
export const shownMessages: Array<{ kind: 'info' | 'warning' | 'error'; message: string }> = [];

/** The commands an activation registered, by id, so a test can invoke one the way the editor does. */
export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

/** Resets everything this module records, so one test cannot read another's calls. */
export const resetStub = (): void => {
    createdCollections.length = 0;
    shownMessages.length = 0;
    registeredCommands.clear();
    createdPanels.length = 0;
    appliedEdits.length = 0;
    openDocuments.length = 0;
    applyEditAnswer.applied = true;
    window.activeTextEditor = undefined;
    workspace.workspaceFolders = undefined;
};

export const languages = {
    createDiagnosticCollection: (): FakeDiagnosticCollection => {
        const collection = new FakeDiagnosticCollection();
        createdCollections.push(collection);
        return collection;
    },
};

export const window = {
    showInformationMessage: (message: string): Promise<undefined> => {
        shownMessages.push({ kind: 'info', message });
        return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string): Promise<undefined> => {
        shownMessages.push({ kind: 'warning', message });
        return Promise.resolve(undefined);
    },
    showErrorMessage: (message: string): Promise<undefined> => {
        shownMessages.push({ kind: 'error', message });
        return Promise.resolve(undefined);
    },
    activeTextEditor: undefined as unknown,
    createWebviewPanel: (): FakeWebviewPanel => {
        const panel = new FakeWebviewPanel();
        createdPanels.push(panel);
        return panel;
    },
};

export const commands = {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        registeredCommands.set(id, handler);
        return { dispose: () => registeredCommands.delete(id) };
    },
    executeCommand: () => Promise.resolve(undefined),
};

/** One webview panel, recording what was posted to it and handing back its message listener. */
export class FakeWebviewPanel {
    public readonly posted: Array<Record<string, unknown>> = [];
    public title = '';
    public html = '';
    private listener: ((message: unknown) => unknown) | undefined;
    private disposeListener: (() => unknown) | undefined;

    public readonly webview = {
        html: '',
        postMessage: (message: Record<string, unknown>): Promise<boolean> => {
            this.posted.push(message);
            return Promise.resolve(true);
        },
        onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
            this.listener = listener;
            return { dispose: () => undefined };
        },
        asWebviewUri: (uri: unknown) => uri,
        cspSource: 'stub',
    };

    /**
     * Delivers a message the way the page would, and waits for the handler to settle.
     *
     * The panel registers its listener as `(message) => void this.onMessage(message)`, so the
     * handler's promise is dropped and awaiting the call returns before any of the work is done.
     * Yielding to the macrotask queue afterwards lets that chain run to its end, which is what a
     * test has to observe.
     *
     * @param message the message the page sends.
     */
    public async send(message: unknown): Promise<void> {
        await this.listener?.(message);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    /** The last message of a kind the panel posted, which is what a test asserts on. */
    public lastPosted(type: string): Record<string, unknown> | undefined {
        return [...this.posted].reverse().find((message) => message.type === type);
    }

    public onDidDispose(listener: () => unknown) {
        this.disposeListener = listener;
        return { dispose: () => undefined };
    }

    public reveal(): void {}

    public dispose(): void {
        this.disposeListener?.();
    }
}

/** The panels created through `window.createWebviewPanel`, newest last. */
export const createdPanels: FakeWebviewPanel[] = [];

/** The edits `workspace.applyEdit` was handed, and whether the next one is refused. */
export const appliedEdits: unknown[] = [];
export const applyEditAnswer = { applied: true };

/** The documents `workspace.textDocuments` reports, which is what a version gate reads. */
export const openDocuments: Array<{ uri: { toString(): string }; version: number }> = [];

export const workspace = {
    workspaceFolders: undefined as unknown,
    getConfiguration: () => ({ get: () => undefined }),
    onDidSaveTextDocument: () => ({ dispose: () => undefined }),
    onDidChangeTextDocument: () => ({ dispose: () => undefined }),
    get textDocuments() {
        return openDocuments;
    },
    applyEdit: (edit: unknown): Promise<boolean> => {
        appliedEdits.push(edit);
        return Promise.resolve(applyEditAnswer.applied);
    },
};

/** The l10n shim: the client keys every string by its English source, so the source is the answer. */
export const l10n = {
    t: (message: string, ...args: unknown[]): string =>
        message.replace(/\{(\d+)\}/g, (whole, index: string) => String(args[Number(index)] ?? whole)),
};

export class Uri {
    private constructor(public readonly fsPath: string) {}

    /**
     * Builds a uri from a path, the way the editor's own does.
     *
     * @param fsPath the path on disk.
     * @returns the uri.
     */
    public static file(fsPath: string): Uri {
        return new Uri(fsPath);
    }

    /**
     * Reads a uri back from the spelling `toString` produced.
     *
     * @param value the uri as text.
     * @returns the uri.
     */
    public static parse(value: string): Uri {
        return new Uri(value.replace(/^file:\/\//, ''));
    }

    /**
     * Joins path parts onto a uri, which a panel does to name its media folder.
     *
     * @param base the uri to start from.
     * @param parts the path parts to append.
     * @returns the joined uri.
     */
    public static joinPath(base: Uri, ...parts: string[]): Uri {
        return new Uri([base.fsPath, ...parts].join('/'));
    }

    /** @returns the uri as the editor would spell it. */
    public toString(): string {
        return `file://${this.fsPath.replace(/\\/g, '/')}`;
    }
}

export class Position {
    public constructor(
        public readonly line: number,
        public readonly character: number
    ) {}
}

export class Range {
    public constructor(
        public readonly start: Position,
        public readonly end: Position
    ) {}
}

export class Diagnostic {
    public source?: string;
    public code?: string;

    public constructor(
        public readonly range: Range,
        public readonly message: string,
        public readonly severity?: number
    ) {}
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export const ViewColumn = { Active: -1, Beside: -2, One: 1 };

/** A listener handle. The panel keeps a list of these and disposes them on teardown. */
export interface Disposable {
    dispose(): unknown;
}

/** The panel type the editor hands back. A test reads the fake one it was given instead. */
export type WebviewPanel = FakeWebviewPanel;

/** The context an activation is handed. Only the subscription list is ever read by a test. */
export interface ExtensionContext {
    readonly subscriptions: Array<{ dispose(): unknown }>;
}
