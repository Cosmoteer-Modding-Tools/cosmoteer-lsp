import { DocumentUri, WorkDoneProgressReporter } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../parser/ast';
import { readdir } from 'fs/promises';
import { sep } from 'path';

export class CosmoteerWorkspaceService {
    private _rulesWorkspace: Map<
        string,
        CosmoteerWorkspace<RulesCosmoteerWorkspaceData>
    >;
    private _assetsWorkspace: Map<
        string,
        CosmoteerWorkspace<AssetsCosmoteerWorkspaceData>
    >;
    private static _instance: CosmoteerWorkspaceService;
    private isInitalized = false;

    constructor() {
        this._rulesWorkspace = new Map();
        this._assetsWorkspace = new Map();
    }

    public static get instance(): CosmoteerWorkspaceService {
        if (!CosmoteerWorkspaceService._instance) {
            CosmoteerWorkspaceService._instance =
                new CosmoteerWorkspaceService();
        }
        return CosmoteerWorkspaceService._instance;
    }

    public findRulesFile(
        relativePath: string
    ): CosmoteerWorkspace<RulesCosmoteerWorkspaceData> | undefined {
        for (const [, value] of this._rulesWorkspace) {
            if (value.data.relativePath === relativePath) {
                return value;
            }
        }
        return undefined;
    }

    public async initialize(
        currentWorkSpacePath: string,
        cosmoteerWorkspacePath: string,
        workDoneProgress: WorkDoneProgressReporter
    ) {
        if (this.isInitalized) return;

        workDoneProgress.begin(
            'Initializing workspace',
            0,
            'Initializing workspace',
            false
        );
        //@experimental Probably a official game dev workspace
        if (
            !currentWorkSpacePath.includes('Mods') &&
            !currentWorkSpacePath.includes('workshop')
        ) {
            workDoneProgress.done();
            return;
        }
        if (
            cosmoteerWorkspacePath.endsWith('Data') ||
            cosmoteerWorkspacePath.endsWith(`Data${sep}`)
        ) {
            cosmoteerWorkspacePath = cosmoteerWorkspacePath.replace(
                /Data$/,
                ''
            );
        } else if (
            cosmoteerWorkspacePath.endsWith('Cosmoteer') ||
            cosmoteerWorkspacePath.endsWith(`Cosmoteer${sep}`)
        ) {
            cosmoteerWorkspacePath += cosmoteerWorkspacePath.endsWith(
                `Cosmoteer${sep}`
            )
                ? `Data${sep}`
                : `${sep}Data${sep}`;
        } else if (
            cosmoteerWorkspacePath.endsWith('common') ||
            cosmoteerWorkspacePath.endsWith(`common${sep}`)
        ) {
            cosmoteerWorkspacePath += cosmoteerWorkspacePath.endsWith(
                `common${sep}`
            )
                ? `Cosmoteer${sep}Data${sep}`
                : `${sep}Cosmoteer${sep}Data${sep}`;
        }
        const dirents = await this.iterateFiles(cosmoteerWorkspacePath);
        let current = 0;
        for (const dirent of dirents) {
            if (dirent.isFile()) {
                if (dirent.name.endsWith('.rules')) {
                    this._rulesWorkspace.set(dirent.name, {
                        data: {
                            name: dirent.name.substring(
                                0,
                                dirent.name.length - '.rules'.length
                            ),
                            relativePath: dirent.path.substring(
                                dirent.path.indexOf('Data') + 4 + sep.length,
                                dirent.path.lastIndexOf(sep)
                            ),
                            parsedDocument: undefined,
                        },
                        uri: dirent.path,
                    });
                } else if (
                    dirent.name.endsWith('.png') ||
                    dirent.name.endsWith('.shader')
                ) {
                    this._assetsWorkspace.set(dirent.name, {
                        uri: dirent.path,
                        data: {
                            name: dirent.name.substring(
                                0,
                                dirent.name.lastIndexOf('.')
                            ),
                            relativePath: dirent.path.substring(
                                dirent.path.indexOf('Data') + 4 + sep.length,
                                dirent.path.lastIndexOf(sep)
                            ),
                            fileEnding: dirent.name.substring(
                                dirent.name.lastIndexOf('.')
                            ),
                        },
                    });
                }
            }
            current++;
            workDoneProgress.report((current / dirents.length) * 100);
        }
        if (this._rulesWorkspace.size > 0) {
            this.isInitalized = true;
        }
        workDoneProgress.done();
    }

    iterateFiles = (workspacePath: string) => {
        return readdir(workspacePath, { withFileTypes: true, recursive: true });
    };
}

export type CosmoteerWorkspace<Data> = {
    readonly uri: DocumentUri;
    data: Data;
};

export type RulesCosmoteerWorkspaceData = {
    name: string;
    relativePath: string;
    parsedDocument?: AbstractNodeDocument;
};

export type AssetsCosmoteerWorkspaceData = {
    name: string;
    relativePath: string;
    fileEnding: string;
};
