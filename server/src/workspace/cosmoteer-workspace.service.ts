import { Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../parser/ast';
import { readdir } from 'fs/promises';
import { sep } from 'path';
import { Dirent } from 'fs';
import { parseFile } from '../utils/ast.utils';
import * as l10n from '@vscode/l10n';
import * as path from 'path';
import { globalSettings } from '../server';

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

    get CosmoteerWorkspacePath(): string {
        let cosmoteerPath = globalSettings.cosmoteerPath;
        if (cosmoteerPath.endsWith('Data') || cosmoteerPath.endsWith(`Data${sep}`)) {
            cosmoteerPath = cosmoteerPath.replace(/Data$/, '');
            cosmoteerPath = path.join(cosmoteerPath, 'Data');
        } else if (cosmoteerPath.endsWith('Cosmoteer') || cosmoteerPath.endsWith(`Cosmoteer${sep}`)) {
            cosmoteerPath = path.join(cosmoteerPath, 'Data');
        } else if (cosmoteerPath.endsWith('common') || cosmoteerPath.endsWith(`common${sep}`)) {
            cosmoteerPath = path.join(cosmoteerPath, 'Cosmoteer', 'Data');
        }
        return cosmoteerPath;
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

    public async initialize(cosmoteerWorkspacePath: string, workDoneProgress: WorkDoneProgressReporter) {
        if (this.isInitalized) return;

        workDoneProgress.begin('Initializing workspace', 0, 'Initializing workspace', false);
        if (cosmoteerWorkspacePath.endsWith('Data') || cosmoteerWorkspacePath.endsWith(`Data${sep}`)) {
            cosmoteerWorkspacePath = cosmoteerWorkspacePath.replace(/Data$/, '');
            cosmoteerWorkspacePath = path.join(cosmoteerWorkspacePath, 'Data');
        } else if (cosmoteerWorkspacePath.endsWith('Cosmoteer') || cosmoteerWorkspacePath.endsWith(`Cosmoteer${sep}`)) {
            cosmoteerWorkspacePath = path.join(cosmoteerWorkspacePath, 'Data');
        } else if (cosmoteerWorkspacePath.endsWith('common') || cosmoteerWorkspacePath.endsWith(`common${sep}`)) {
            cosmoteerWorkspacePath = path.join(cosmoteerWorkspacePath, 'Cosmoteer', 'Data');
        } else {
            this._connection.window.showWarningMessage(
                l10n.t('Invalid cosmoteer path, the path should end with common or Cosmoteer or Data')
            );
            workDoneProgress.done();
            return;
        }
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

    private buildFileStructure = async (parentTree: FileTree, dirents: Dirent[]) => {
        for (const dirent of dirents) {
            if (dirent.isDirectory()) {
                const nextDirents = await this.iterateFiles(`${dirent.parentPath + sep + dirent.name}`);
                if (nextDirents.length === 0) continue;
                const parent: FileTree = {
                    type: 'Dir',
                    name: dirent.name,
                    children: [],
                    path: dirent.parentPath + sep + dirent.name,
                };
                await this.buildFileStructure(parent, nextDirents);
                if (isDirectory(parentTree)) parentTree.children?.push(parent);
            } else if (dirent.isFile()) {
                if (dirent.name.endsWith('.rules')) {
                    const dataContent: FileTree = {
                        type: 'File',
                        name: dirent.name,
                        content: {
                            name: dirent.name.substring(0, dirent.name.lastIndexOf('.')),
                        },
                        path: dirent.parentPath + sep + dirent.name,
                        parent: parentTree,
                    };
                    if (isDirectory(parentTree)) parentTree.children.push(dataContent);
                } else if (dirent.name.endsWith('.png') || dirent.name.endsWith('.shader')) {
                    if (isDirectory(parentTree)) {
                        parentTree.children.push({
                            type: 'File',
                            name: dirent.name,
                            content: {
                                name: dirent.name.substring(0, dirent.name.lastIndexOf('.')),
                                fileEnding: dirent.name.split('.')[1],
                            },
                            path: dirent.parentPath + sep + dirent.name,
                            parent: parentTree,
                        });
                    }
                }
            }
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
