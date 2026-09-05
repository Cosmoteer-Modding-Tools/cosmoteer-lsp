import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, isAssignmentNode, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { parseModActions } from '../../mod/action-parser';
import { evaluateNumericValue } from '../../semantics/value-evaluator';
import { foldPathCase } from '../../workspace/fs-cache';
import { dirOf, readRulesFile } from '../refactor/shared-base/base-index';
import { manifestsIn, modRootsUnder } from '../refactor/register-part/ship-registry';
import { ShipLayerContext, sourceNodesOf } from '../ships/ship-layer.index';

/**
 * What one unit of each resource costs to buy, read from the game's resource registry and from the
 * manifests that add resources to it. The part table turns a part's `Resources` list into a price
 * with this, which is the column a modder used to keep by hand next to the steel and the coils.
 *
 * The registry is the `Resources` list of `resources/resources.rules`, one file reference per
 * resource, and each file declares its `ID` and its `BuyPrice` at the top level. A mod appends to
 * that list from its manifest the same way it appends parts to a ship, so the same action walk
 * finds its resources.
 */

/** The registry file, relative to the game's data root. */
const REGISTRY_FILE = 'resources/resources.rules';

/** The registry's list member. */
const REGISTRY_MEMBER = 'Resources';

/** The verbs that can put new entries into the registry's list. */
const ADDING_VERBS = new Set(['Add', 'AddMany', 'Replace', 'Override', 'Overrides']);

/** The member a resource declares its id in, folded. */
const ID_MEMBER = 'id';

/** The member a resource declares its price in, folded. */
const PRICE_MEMBER = 'buyprice';

/** The prices by folded resource id. */
export type ResourcePrices = ReadonlyMap<string, number>;

/**
 * The top-level members of a resource file, by folded name, in either `Name = value` or `Name { }`
 * form.
 *
 * @param elements the file's root elements.
 * @returns the member values by folded name.
 */
const topLevelMembers = (elements: readonly AbstractNode[]): Map<string, AbstractNode> => {
    const members = new Map<string, AbstractNode>();
    for (const element of elements) {
        if (isAssignmentNode(element) && element.right) members.set(element.left.name.toLowerCase(), element.right);
        else if ((isGroupNode(element) || isListNode(element)) && element.identifier) {
            members.set(element.identifier.name.toLowerCase(), element);
        }
    }
    return members;
};

/**
 * Reads one resource file's id and price into the map.
 *
 * @param fsPath the resource file.
 * @param into the prices being collected.
 * @param token cancels the evaluation.
 */
const readResourceFile = async (fsPath: string, into: Map<string, number>, token: CancellationToken): Promise<void> => {
    const file = await readRulesFile(fsPath);
    if (!file) return;
    const members = topLevelMembers(file.document.elements);
    const id = members.get(ID_MEMBER);
    const price = members.get(PRICE_MEMBER);
    if (!id || !isValueNode(id) || !price) return;
    const value = await evaluateNumericValue(price, token).catch(() => null);
    if (value === null) return;
    into.set(String(id.valueType.value).trim().toLowerCase(), value);
};

/**
 * The file a registry entry names, resolved against the directory the list is written in.
 *
 * @param entry the list element.
 * @param declaringDir the directory references resolve against.
 * @returns the file's path, or undefined when the entry is not a file reference.
 */
const referencedFile = (entry: AbstractNode, declaringDir: string): string | undefined => {
    if (!isValueNode(entry) || entry.valueType.type !== 'Reference') return undefined;
    const match = /^\s*&?\s*<([^<>]+)>\s*$/.exec(String(entry.valueType.value));
    if (!match) return undefined;
    const relative = match[1].trim().replace(/\\/g, '/');
    return `${declaringDir.replace(/\\/g, '/').replace(/\/+$/, '')}/${relative}`;
};

/**
 * Whether an action target names the registry's list. The list sits at the top level of its file,
 * so the shared ship-member test, which expects a group between the file and the member, cannot be
 * asked this.
 *
 * @param target the action's target path, as written.
 * @param registryPath the registry file's path.
 * @returns true when the target names the registry's list.
 */
const targetsRegistry = (target: string, registryPath: string): boolean => {
    const written = target.trim().replace(/\\/g, '/');
    const opening = written.indexOf('<');
    const closing = written.indexOf('>');
    if (opening === -1 || closing === -1) return false;
    const member = written
        .slice(closing + 1)
        .replace(/^\/+|\/+$/g, '')
        .toLowerCase();
    if (member !== REGISTRY_MEMBER.toLowerCase()) return false;
    const file = written.slice(opening + 1, closing).replace(/^\.?\//, '');
    return foldPathCase(registryPath).endsWith(foldPathCase(file));
};

/**
 * Reads the prices of every resource a list of registry entries names.
 *
 * @param entries the list elements.
 * @param declaringDir the directory their references resolve against.
 * @param into the prices being collected.
 * @param token cancels the reads.
 */
const collectEntries = async (
    entries: readonly AbstractNode[],
    declaringDir: string,
    into: Map<string, number>,
    token: CancellationToken
): Promise<void> => {
    for (const entry of entries) {
        if (token.isCancellationRequested) return;
        const fsPath = referencedFile(entry, declaringDir);
        if (fsPath) await readResourceFile(fsPath, into, token);
    }
};

/**
 * The prices of every resource the project registers: the game's registry and every manifest that
 * appends to it.
 *
 * @param context the game root and workspace folders the registry is read from.
 * @param token cancels the reads.
 * @returns the price per folded resource id, empty when the game path is not set.
 */
export const collectResourcePrices = async (
    context: ShipLayerContext,
    token: CancellationToken
): Promise<ResourcePrices> => {
    const prices = new Map<string, number>();
    if (!context.gameRootPath) return prices;
    const dataRoot = dirOf(context.gameRootPath);
    const registryPath = `${dataRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${REGISTRY_FILE}`;
    const registry = await readRulesFile(registryPath);
    if (!registry) return prices;
    const list = topLevelMembers(registry.document.elements).get(REGISTRY_MEMBER.toLowerCase());
    if (list && isListNode(list)) await collectEntries(list.elements, dirOf(registryPath), prices, token);

    for (const folder of context.folderPaths) {
        for (const modRoot of modRootsUnder(folder)) {
            for (const manifestFsPath of manifestsIn(modRoot)) {
                if (token.isCancellationRequested) return prices;
                const manifest = await readRulesFile(manifestFsPath);
                if (!manifest) continue;
                const declaringDir = dirOf(manifestFsPath);
                for (const action of parseModActions(manifest.document)) {
                    if (!ADDING_VERBS.has(action.type)) continue;
                    const targets = action.targets.map((target) => String(target.valueType.value));
                    if (!targets.some((target) => targetsRegistry(target, registryPath))) continue;
                    for (const { node, dir } of await sourceNodesOf(action.sources, declaringDir)) {
                        await collectEntries(isListNode(node) ? node.elements : [node], dir, prices, token);
                    }
                }
            }
        }
    }
    return prices;
};

/**
 * The price of a resource, looked up the way the game matches ids.
 *
 * @param prices the collected prices.
 * @param id the resource id as a part's `Resources` list writes it.
 * @returns the price, or undefined when nothing registers the resource.
 */
export const priceOf = (prices: ResourcePrices, id: string): number | undefined => prices.get(id.trim().toLowerCase());
