import { join } from 'path';
import { AbstractNode } from '../parser/ast';
import { CosmoteerFile, CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { extractSubstrings, filePathToDirectoryPath, NavigationStrategy } from './navigation-strategy';
import { access, constants, readdir, realpath } from 'fs/promises';
import { globalSettings } from '../server';

export class AssetNavigationStrategy extends NavigationStrategy<boolean> {
    async navigate(path: string, _startNode: AbstractNode, currentLocation: string): Promise<boolean> {
        if (path.startsWith('./Data')) {
            return (await this.navigateTroughCosmoteerFiles(path)) ? true : false;
        } else {
            return await this.navigateTroughOwnFiles(path, currentLocation);
        }
    }

    async navigateTroughCosmoteerFiles(path: string): Promise<CosmoteerFile | null | boolean> {
        const pathWithoutData = path.replace('./Data', '');
        return await this.navigateRulesByCurrentLocation(
            extractSubstrings(pathWithoutData),
            CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath
        );
    }

    async navigateTroughOwnFiles(path: string, currentLocation: string): Promise<boolean> {
        return await this.navigateRulesByCurrentLocation(extractSubstrings(path), currentLocation);
    }

    navigateRulesByCurrentLocation = async (pathes: string[], currentLocation: string) => {
        try {
            const cleanedPath = join(currentLocation, '..', ...pathes);

            await access(cleanedPath, constants.F_OK);
        } catch (error) {
            if (globalSettings.trace.server !== 'off') {
                console.error(error);
            }

            return await this.searchInDirForFile(pathes, currentLocation);
        }
        return true;
    };

    /**
     * Searches for a file in the directory incasesensitive which {access} will fail most of the times.
     */
    private searchInDirForFile = async (pathes: string[], currentLocation: string): Promise<boolean> => {
        try {
            const realPath = await realpath(
                join(filePathToDirectoryPath(currentLocation), ...pathes.slice(0, pathes.length - 1))
            );
            const dir = await readdir(realPath);
            const file = dir.find((f) => f.toLowerCase() === pathes[pathes.length - 1].toLowerCase());
            return file ? true : false;
        } catch (error) {
            if (globalSettings.trace.server !== 'off') {
                console.error(error);
            }
        }
        return false;
    };
}
