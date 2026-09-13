import { AsyncLocalStorage } from 'node:async_hooks';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode } from '../core/ast/ast';
import { FileWithPath } from '../workspace/cosmoteer-workspace.service';

/**
 * The seam between plain navigation and the mod's effective game tree.
 *
 * A reference inside a mod may point at something only the mod's own manifest actions put there, so
 * a failed resolution has to be retried against {@link import('./mod-context').ModContext}. The
 * navigation strategy cannot import that module directly: mod-context resolves its own sources
 * through the strategy, and the resulting import cycle would leave one of the two half-initialized.
 * This leaf module carries the hook instead, registered by mod-context when it loads.
 */
export type ModContextResolver = (
    path: string,
    node: AbstractNode,
    cancellationToken: CancellationToken
) => Promise<AbstractNode | null | FileWithPath>;

let resolver: ModContextResolver | undefined;

/** Guards against a mod-context resolution triggering the fallback again through its own lookups.
 *  An {@link AsyncLocalStorage} rather than a module flag, so concurrent resolutions (a validation
 *  pass and an editor request) cannot switch each other's fallback off mid-await. */
const insideModContext = new AsyncLocalStorage<true>();

/**
 * Registers the mod-context resolver used as the fallback of a failed nested resolution.
 *
 * @param fn the resolver to install.
 */
export const setModContextResolver = (fn: ModContextResolver): void => {
    resolver = fn;
};

/**
 * Runs a mod-context resolution with the fallback suppressed inside it. The resolution walks the
 * mod's own sources through navigation, and re-entering the fallback there would resolve the same
 * additions once per hop.
 *
 * @param run the resolution to execute.
 * @returns the resolution's result.
 */
export const withinModContext = <T>(run: () => Promise<T>): Promise<T> => insideModContext.run(true, run);

/**
 * Retries a failed resolution against the mod's additions. Answers null outside a mod, before
 * mod-context has loaded, and while a mod-context resolution is already running.
 *
 * @param path the reference path that did not resolve.
 * @param node the node bearing the reference, which locates the owning mod.
 * @param cancellationToken cancels the resolution.
 * @returns the mod-added target, or null.
 */
export const resolveThroughModContext = async (
    path: string,
    node: AbstractNode,
    cancellationToken: CancellationToken
): Promise<AbstractNode | null | FileWithPath> => {
    if (!resolver || insideModContext.getStore()) return null;
    return resolver(path, node, cancellationToken).catch(() => null);
};
