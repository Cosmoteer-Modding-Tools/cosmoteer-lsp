import { CosmoteerSettings, globalSettings, mergeSettings } from '../settings';
import { hasConfigurationCapability } from './capabilities';
import { connection } from './context';

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<CosmoteerSettings>> = new Map();

/**
 * The settings that apply to one document, cached for as long as it is open. Falls back to the
 * global settings on a client that cannot answer `workspace/configuration`.
 *
 * @param resource the document's uri.
 * @returns that document's effective settings.
 */
export function getDocumentSettings(resource: string): Thenable<CosmoteerSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        // The answer carries only the keys the client knows about, so it is merged over the
        // defaults: an omitted key must read as its default, not as `undefined`.
        result = connection.workspace
            .getConfiguration({
                scopeUri: resource,
                section: 'cosmoteerLSPRules',
            })
            .then((answer) => mergeSettings(answer));
        documentSettings.set(resource, result);
    }
    return result;
}

/** Drops every cached per-document answer, after the client reported a configuration change. */
export function clearDocumentSettings(): void {
    documentSettings.clear();
}

/**
 * Drops one document's cached answer, when its tab closes.
 *
 * @param resource the closed document's uri.
 */
export function forgetDocumentSettings(resource: string): void {
    documentSettings.delete(resource);
}
