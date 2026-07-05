import { AbstractNodeDocument } from '../core/ast/ast';
import { Action } from './action';
import { parseModActions } from './action-parser';

/**
 * Owns parsed `mod.rules` manifests and their {@link Action}s. Wired into the server pipeline via
 * {@link registerManifest}: each manifest's `Actions` block is parsed into {@link Action}s (see
 * {@link parseModActions}), which back mod-action validation and completion (see ./README.md).
 */
export class ModRulesRegistrar {
    private static _instance: ModRulesRegistrar;
    private readonly actionsByUri = new Map<string, Action[]>();

    private constructor() {}

    public static get instance(): ModRulesRegistrar {
        if (!ModRulesRegistrar._instance) {
            ModRulesRegistrar._instance = new ModRulesRegistrar();
        }
        return ModRulesRegistrar._instance;
    }

    /** Parse and store the actions of a mod.rules manifest. */
    public registerManifest(document: AbstractNodeDocument): void {
        this.actionsByUri.set(document.uri, parseModActions(document));
    }

    public getActions(uri: string): Action[] {
        return this.actionsByUri.get(uri) ?? [];
    }
}
