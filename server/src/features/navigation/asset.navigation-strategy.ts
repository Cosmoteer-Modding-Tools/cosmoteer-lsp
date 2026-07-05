import { join } from 'path';
import { AbstractNode } from '../../core/ast/ast';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { extractSubstrings, filePathToDirectoryPath, NavigationStrategy } from './navigation-strategy';
import { access, constants, readdir, realpath } from 'fs/promises';
import { globalSettings } from '../../settings';

export class AssetNavigationStrategy extends NavigationStrategy<boolean> {
    async navigate(path: string, startNode: AbstractNode, currentLocation: string): Promise<boolean> {
        return (await this.resolveAsset(path, startNode, currentLocation)) !== null;
    }

    /**
     * Resolve an asset path to the absolute on-disk file it names, or `null` if it does
     * not exist. The boolean-returning {@link navigate} is just this with the path
     * discarded. Go-to-definition and hover need the resolved path itself.
     */
    async resolveAsset(path: string, _startNode: AbstractNode, currentLocation: string): Promise<string | null> {
        // `./Data/…` is an absolute path from the Cosmoteer install root. The prefix is
        // matched case-insensitively because real assets use `./data/…` too (the file
        // system is case-insensitive on Windows, and mods rely on that).
        if (/^\.\/data\//i.test(path)) {
            return await this.resolveTroughCosmoteerFiles(path);
        }
        return await this.resolveTroughOwnFiles(path, currentLocation);
    }

    private resolveTroughCosmoteerFiles(path: string): Promise<string | null> {
        const pathWithoutData = path.replace(/^\.\/data/i, '');
        return this.resolveByCurrentLocation(
            extractSubstrings(pathWithoutData),
            CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath
        );
    }

    private resolveTroughOwnFiles(path: string, currentLocation: string): Promise<string | null> {
        return this.resolveByCurrentLocation(extractSubstrings(path), currentLocation);
    }

    private resolveByCurrentLocation = async (pathes: string[], currentLocation: string): Promise<string | null> => {
        try {
            const cleanedPath = join(currentLocation, '..', ...pathes);

            await access(cleanedPath, constants.F_OK);
            return cleanedPath;
        } catch (error) {
            // This first access "will fail most of the times" (see below) and falls
            // back to a dir scan — so only surface it under 'verbose', else it floods when the
            // whole game tree is validated/searched.
            if (globalSettings.trace.server === 'verbose') {
                console.error(error);
            }

            return await this.searchInDirForFile(pathes, currentLocation);
        }
    };

    /**
     * Searches for a file in the directory incasesensitive which {access} will fail most of the times.
     * Returns the resolved absolute path (with the directory's real casing) or `null`.
     */
    private searchInDirForFile = async (pathes: string[], currentLocation: string): Promise<string | null> => {
        try {
            const realPath = await realpath(
                join(filePathToDirectoryPath(currentLocation), ...pathes.slice(0, pathes.length - 1))
            );
            const dir = await readdir(realPath);
            const file = dir.find((f) => f.toLowerCase() === pathes[pathes.length - 1].toLowerCase());
            return file ? join(realPath, file) : null;
        } catch (error) {
            if (globalSettings.trace.server === 'verbose') {
                console.error(error);
            }
        }
        return null;
    };
}
