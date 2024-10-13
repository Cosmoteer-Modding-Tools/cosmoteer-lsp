import { Dirent } from 'fs';
import { AbstractNode } from '../parser/ast';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';

export abstract class NavigationStrategy<T> {
    abstract navigate(
        path: string,
        startNode: AbstractNode,
        currentLocation: string,
        cancellationToken: CancellationToken
    ): Promise<T>;
}

export const filePathToDirectoryPath = (path: string) => {
    if (path.startsWith('file:///')) {
        const cleanedPath = path
            .replace(`file:///`, '')
            .replace('c%3A', 'C:')
            .replaceAll('%20', ' ')
            .replaceAll('%28', '(')
            .replaceAll('%29', ')');
        return cleanedPath.substring(0, cleanedPath.lastIndexOf('/') + 1);
    }
    if (path.endsWith('.rules')) {
        return path.substring(0, (path.includes('/') ? path.lastIndexOf('/') : path.lastIndexOf('\\') - 1) + 1);
    }
    return path;
};

export const extractSubstrings = (input: string): string[] => {
    const regex = /([^/]+)/g;
    const matches = input.matchAll(regex);
    return Array.from(matches, (match) => match[1]);
};

export const createDirentPath = (dirent: Dirent) => {
    return join(dirent.parentPath, dirent.name);
};
