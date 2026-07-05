import { Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../core/ast/ast';
import { readdir } from 'fs/promises';
import { sep } from 'path';
import { Dirent } from 'fs';
import { parseFile } from '../utils/ast.utils';
import * as l10n from '@vscode/l10n';
import * as path from 'path';
import { globalSettings } from '../settings';
import Registry from 'winreg';

/**
 * Normalize a user-supplied game path to its `Data` root: a path ending in `Data`, `Cosmoteer`, or
 * `common` (the common install-tree tails) maps to the corresponding `.../Data` directory. Returns
 * `undefined` when the path ends in none of them, which the caller treats as an invalid path.
 */
const toDataRoot = (cosmoteerPath: string): string | undefined => {
    if (cosmoteerPath.endsWith('Data') || cosmoteerPath.endsWith(`Data${sep}`)) {
        return path.join(cosmoteerPath.replace(/Data$/, ''), 'Data');
    }
    if (cosmoteerPath.endsWith('Cosmoteer') || cosmoteerPath.endsWith(`Cosmoteer${sep}`)) {
        return path.join(cosmoteerPath, 'Data');
    }
    if (cosmoteerPath.endsWith('common') || cosmoteerPath.endsWith(`common${sep}`)) {
        return path.join(cosmoteerPath, 'Cosmoteer', 'Data');
    }
    return undefined;
};

/** A reporter that drops every call, used when there is no connection (unit tests) so work still runs. */
const NOOP_PROGRESS: WorkDoneProgressReporter = {
    begin: () => undefined,
    report: () => undefined,
    done: () => undefined,
};

export class CosmoteerWorkspaceService {
    private _fileWorkspaceTree!: FileTree;
    private static _instance: CosmoteerWorkspaceService;
    private _connection!: Connection;
    private isInitalized = false;

    private constructor() {}

    public static get instance(): CosmoteerWorkspaceService {
        if (!CosmoteerWorkspaceService._instance) {
            CosmoteerWorkspaceService._instance = new CosmoteerWorkspaceService();
        }
        return CosmoteerWorkspaceService._instance;
    }

    setConnection(connection: Connection) {
        this._connection = connection;
    }

    /**
     * Runs a long index build under an LSP work-done progress notification, so the user sees an
     * "indexing" indicator instead of an unexplained pause while a project-wide scan runs. The work
     * receives the reporter to post a running count (`report('123 files')`). When the connection is
     * not set (unit tests) the work still runs, against a no-op reporter.
     *
     * @param title the progress title shown to the user (e.g. `Indexing symbols`).
     * @param work the build to run, given a reporter to post incremental progress.
     * @returns whatever the work resolves to.
     */
    public async withIndexingProgress<T>(
        title: string,
        work: (progress: WorkDoneProgressReporter) => Promise<T>
    ): Promise<T> {
        // No connection, or a client/mock without work-done progress support — run against a no-op
        // reporter so the build still happens, just without a visible indicator.
        if (typeof this._connection?.window?.createWorkDoneProgress !== 'function') return work(NOOP_PROGRESS);
        const progress = await this._connection.window.createWorkDoneProgress();
        progress.begin(title, undefined, undefined, false);
        try {
            return await work(progress);
        } finally {
            progress.done();
        }
    }

    /**
     * The Data root the workspace was actually initialized against (the scanned file tree's
     * own path), or `undefined` if not initialized. Unlike {@link CosmoteerWorkspacePath} this
     * doesn't re-derive from `globalSettings.cosmoteerPath` (which a `didChangeConfiguration`
     * event can transiently blank), so it's the reliable source for "where the game files are".
     */
    get dataRootPath(): string | undefined {
        return this.isInitalized && this._fileWorkspaceTree ? this._fileWorkspaceTree.path : undefined;
    }

    get CosmoteerWorkspacePath(): string {
        const cosmoteerPath = globalSettings.cosmoteerPath;
        return toDataRoot(cosmoteerPath) ?? cosmoteerPath;
    }

    public findFile(pathes: string[]):
        | (CosmoteerFile & {
              readonly path: string;
          })
        | undefined {
        if (!this.isInitalized) return;
        if (isDirectory(this._fileWorkspaceTree)) {
            return this.findFileRecursive(this._fileWorkspaceTree, pathes);
        }
    }
    public async getCosmoteerRules(): Promise<
        | (CosmoteerFile & {
              readonly path: string;
          })
        | undefined
    > {
        if (!this.isInitalized) return;
        const cosmoteerRules = (this._fileWorkspaceTree as Directory).children.find(
            (c) => c.name.toLowerCase() === 'cosmoteer.rules'
        ) as CosmoteerFile & {
            readonly path: string;
        };
        if (!(cosmoteerRules.content as CosmoteerWorkspaceData).parsedDocument)
            (cosmoteerRules.content as CosmoteerWorkspaceData).parsedDocument = await parseFile(cosmoteerRules);
        return cosmoteerRules;
    }

    private findFileRecursive = (
        parent: FileTree,
        pathes: string[],
        index: number = 0
    ): (CosmoteerFile & { readonly path: string }) | undefined => {
        if (index === pathes.length) return;
        if (isFile(parent) && parent.name.toLowerCase() === pathes[index].toLowerCase()) {
            return parent;
        } else if (isDirectory(parent)) {
            for (const dirent of parent.children) {
                if (isFile(dirent) && dirent.name.toLowerCase() === pathes[index].toLowerCase()) {
                    return dirent;
                } else if (isDirectory(dirent) && dirent.name.toLowerCase() === pathes[index].toLowerCase()) {
                    return this.findFileRecursive(dirent, pathes, index + 1);
                }
            }
        }
    };

    public async initializeWithoutPath(workDoneProgress: WorkDoneProgressReporter): Promise<boolean> {
        workDoneProgress.begin('Initializing workspace', 0, 'Initializing workspace', false);
        const cosmoteerPath = await this.getCosmoteerPathFromRegistry();
        if (!cosmoteerPath) {
            this._connection.window.showWarningMessage(
                l10n.t('Could not find Cosmoteer installation automatically, please set the path manually')
            );
            workDoneProgress.done();
            return false;
        }
        workDoneProgress.report(50, 'Found Cosmoteer installation');
        globalSettings.cosmoteerPath = cosmoteerPath;
        await this.initialize(cosmoteerPath, workDoneProgress);
        return true;
    }

    private async getCosmoteerPathFromRegistry(): Promise<string | undefined> {
        const reg = new Registry({
            hive: Registry.HKLM,
            key: '\\SOFTWARE\\WOW6432Node\\Valve\\Steam',
        });
        return new Promise<string | undefined>((resolve, reject) => {
            reg.get('InstallPath', (err, item) => {
                if (err) {
                    this._connection.window.showWarningMessage(
                        l10n.t('Could not find Cosmoteer installation, please set the path manually')
                    );
                    reject(err);
                    return;
                }
                const cosmoteerPath = path.join(item.value, '\\steamapps\\common\\Cosmoteer\\Data');
                resolve(cosmoteerPath);
            });
        });
    }

    public async initialize(cosmoteerWorkspacePath: string, workDoneProgress: WorkDoneProgressReporter) {
        if (this.isInitalized) return;
        const dataRoot = toDataRoot(cosmoteerWorkspacePath);
        if (!dataRoot) {
            this._connection.window.showWarningMessage(
                l10n.t('Invalid cosmoteer path, the path should end with common or Cosmoteer or Data')
            );
            workDoneProgress.done();
            return;
        }
        cosmoteerWorkspacePath = dataRoot;
        const dirents = await this.iterateFiles(cosmoteerWorkspacePath);
        this._fileWorkspaceTree = {
            type: 'Dir',
            name: 'Data',
            path: cosmoteerWorkspacePath,
            children: [],
        };

        await this.buildFileStructure(this._fileWorkspaceTree, dirents);
        if (this._fileWorkspaceTree.children && this._fileWorkspaceTree.children.length > 0) {
            this.isInitalized = true;
            this._connection.languages.diagnostics.refresh();
        }
        workDoneProgress.done();
    }

    private iterateFiles = (workspacePath: string) => {
        return readdir(workspacePath, { withFileTypes: true });
    };

    /**
     * Builds the file tree under `parentTree` from its directory entries. Subdirectories are scanned
     * concurrently (the game `Data` tree holds thousands of directories, so a sequential walk pays
     * one disk round-trip per directory), while children are appended in the original entry order so
     * the resulting tree is deterministic.
     *
     * @param parentTree the directory node the built children are appended to.
     * @param dirents the directory's entries, as read by `readdir`.
     * @returns once the whole subtree below `parentTree` is built.
     */
    private buildFileStructure = async (parentTree: FileTree, dirents: Dirent[]) => {
        if (!isDirectory(parentTree)) return;
        const children = await Promise.all(
            dirents.map(async (dirent): Promise<FileTree | undefined> => {
                if (dirent.isDirectory()) {
                    const nextDirents = await this.iterateFiles(`${dirent.parentPath + sep + dirent.name}`);
                    if (nextDirents.length === 0) return undefined;
                    const parent: FileTree = {
                        type: 'Dir',
                        name: dirent.name,
                        children: [],
                        path: dirent.parentPath + sep + dirent.name,
                    };
                    await this.buildFileStructure(parent, nextDirents);
                    return parent;
                }
                if (dirent.isFile()) {
                    if (dirent.name.endsWith('.rules')) {
                        return {
                            type: 'File',
                            name: dirent.name,
                            content: {
                                name: dirent.name.substring(0, dirent.name.lastIndexOf('.')),
                            },
                            path: dirent.parentPath + sep + dirent.name,
                            parent: parentTree,
                        };
                    }
                    if (dirent.name.endsWith('.png') || dirent.name.endsWith('.shader')) {
                        return {
                            type: 'File',
                            name: dirent.name,
                            content: {
                                name: dirent.name.substring(0, dirent.name.lastIndexOf('.')),
                                fileEnding: dirent.name.split('.')[1],
                            },
                            path: dirent.parentPath + sep + dirent.name,
                            parent: parentTree,
                        };
                    }
                }
                return undefined;
            })
        );
        for (const child of children) {
            if (child) parentTree.children.push(child);
        }
    };
}

export type CosmoteerWorkspaceData = {
    readonly name: string;
    readonly fileEnding?: string;
    parsedDocument?: AbstractNodeDocument;
};

export type FileTree = {
    readonly path: string;
    readonly parent?: FileTree;
} & (Directory | CosmoteerFile);

export type FileWithPath = CosmoteerFile & { readonly path: string };

export type Directory = {
    type: 'Dir';
    name: string;
    children: FileTree[];
};

export type CosmoteerFile = {
    type: 'File';
    readonly name: string;
    content: CosmoteerWorkspaceData;
};

export const isDirectory = (fileTree: FileTree): fileTree is Directory & { readonly path: string } =>
    fileTree.type === 'Dir';
export const isFile = (fileTree: FileTree): fileTree is CosmoteerFile & { readonly path: string } =>
    fileTree.type === 'File';
