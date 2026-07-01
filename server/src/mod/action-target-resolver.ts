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
 * `<a.rules>/A` becomes `<./Data/a.rules>/A`; `&<a.rules>/A` becomes `<./Data/a.rules>/A`
 * (a "&" reference target uses the same game-root form); `<cosmoteer.rules>` becomes
 * `<./Data/cosmoteer.rules>`; `<./data/gui/...>` (any case) becomes `<./Data/gui/...>`
 * (canonical case for the case-sensitive branch); and `<./Data/../../../workshop/...>`
 * stays unchanged (case-canonicalized only).
 */
export const normalizeTargetPath = (value: string): string => {
    let v = value.trim();
    if (v.startsWith('&')) v = v.slice(1).trim(); // a reference target ("&<file>") resolves like a string-path target
    if (!v.startsWith('<')) return v;
    const inner = v.slice(1); // drop the leading '<'
    const dataPrefix = inner.match(/^\.\/data\//i);
    if (dataPrefix) return '<./Data/' + inner.slice(dataPrefix[0].length);
    return '<./Data/' + inner;
};

/**
 * Resolve a mod-action target value node against the game Data root (and the Steam
 * workshop folder for `../` escapes). Returns the resolved node/file, or null.
 * Pure-vanilla resolution — mod-context awareness (mod-added globals) is layered on
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
