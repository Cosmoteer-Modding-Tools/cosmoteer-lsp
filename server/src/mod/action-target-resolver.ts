import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, ValueNode } from '../core/ast/ast';
import { getStartOfAstNode } from '../utils/ast.utils';
import { FullNavigationStrategy } from '../features/navigation/full.navigation-strategy';
import { FileWithPath } from '../workspace/cosmoteer-workspace.service';

const navigation = new FullNavigationStrategy();

/**
 * Normalize a mod-action target path to the canonical game-root form `<./Data/...>`.
 *
 * Action targets resolve against the game Data root, unlike normal `.rules` references
 * which resolve relative to their own file. Rewriting every target to start with the
 * canonical `<./Data/` forces it through `navigateRules`'s cosmoteer-tree branch
 * (which ignores `currentLocation`), and leaves workshop escapes
 * (`<./Data/../../../workshop/...>`) intact for the `./Data/..` branch. For example,
 * `<a.rules>/A` becomes `<./Data/a.rules>/A`. `&<a.rules>/A` becomes `<./Data/a.rules>/A`
 * (a "&" reference target uses the same game-root form). `<cosmoteer.rules>` becomes
 * `<./Data/cosmoteer.rules>`. `<./data/gui/...>` (any case) becomes `<./Data/gui/...>`
 * (canonical case for the case-sensitive branch). And `<./Data/../../../workshop/...>`
 * stays unchanged (case-canonicalized only).
 */
export const normalizeTargetPath = (value: string): string => {
    let v = value.trim();
    if (v.startsWith('&')) v = v.slice(1).trim(); // a reference target ("&<file>") resolves like a string-path target
    if (!v.startsWith('<')) return v;
    const inner = v.slice(1); // drop the leading '<'
    const dataPrefix = inner.match(/^\.\/data\//i);
    if (dataPrefix) return '<./Data/' + inner.slice(dataPrefix[0].length);
    // A `./` path that does not name `Data` resolves against the game's working directory, the
    // install root (the game takes any `./` path as-is), so it escapes Data by one level here.
    if (inner.startsWith('./')) return '<./Data/../' + inner.slice(2);
    return '<./Data/' + inner;
};

/**
 * Split a normalized target path into the container part and the member name it ends with, at the
 * last `/` outside the `<…>` file span, since a file path carries slashes of its own.
 *
 * @param path the normalized target path.
 * @returns the two halves, or undefined when the path names no member.
 */
const splitTargetMember = (path: string): { container: string; member: string } | undefined => {
    let depth = 0;
    let cut = -1;
    for (let index = 0; index < path.length; index++) {
        const char = path[index];
        if (char === '<') depth++;
        else if (char === '>') depth--;
        else if (char === '/' && depth === 0) cut = index;
    }
    if (cut <= 0 || cut === path.length - 1) return undefined;
    return { container: path.slice(0, cut), member: path.slice(cut + 1) };
};

/**
 * Resolve the container a target's last segment names a member of, without following that member.
 *
 * `resolveActionTarget` answers with the node a path leads to, and the walk dereferences a final
 * reference on the way, which is right for asking whether a target exists and wrong for asking which
 * member an action rewrites: the game reads these two verbs with `dereferenceFinalNode: false`, so
 * `Replace = <f>/A/B` rewrites `B` in `A` even when `B` is a reference into another file entirely.
 *
 * @param target the action's target value node.
 * @param cancellationToken cancels the resolution.
 * @returns the container and the member name, or null when the path names no member the walk reaches.
 */
export const resolveActionTargetMember = async (
    target: ValueNode,
    cancellationToken: CancellationToken
): Promise<{ container: AbstractNode | FileWithPath; member: string } | null> => {
    const raw = String(target.valueType.value);
    if (!raw.includes('<')) return null;
    const split = splitTargetMember(normalizeTargetPath(raw));
    if (!split) return null;
    const container = await navigation
        .navigate(split.container, target, getStartOfAstNode(target).uri, cancellationToken)
        .catch(() => null);
    if (!container) return null;
    return { container: container as AbstractNode | FileWithPath, member: split.member };
};

/**
 * Resolve a mod-action target value node against the game Data root (and the Steam
 * workshop folder for `../` escapes). Returns the resolved node/file, or null.
 * Pure-vanilla resolution. Mod-context awareness (mod-added globals) is layered on
 * top in `mod/mod-context.ts`.
 */
export const resolveActionTarget = async (
    target: ValueNode,
    cancellationToken: CancellationToken
): Promise<AbstractNode | null | FileWithPath> => {
    const raw = String(target.valueType.value);
    if (!raw.includes('<')) return null;
    return navigation
        .navigate(normalizeTargetPath(raw), target, getStartOfAstNode(target).uri, cancellationToken)
        .catch(() => null);
};
