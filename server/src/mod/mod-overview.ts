import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, isAssignmentNode, isValueNode } from '../core/ast/ast';
import { basenameOf } from '../document/document-kind';
import { uriToFsPath } from '../features/navigation/workspace-files';
import { Action } from './action';
import { normalizeTargetPath } from './action-target-resolver';
import { resolveWithModContext } from './mod-context';
import { computeModReachability, reachabilityKey, relativeToMod } from './mod-reachability';
import { findModRoot } from './mod-root';
import { parseModActions } from './action-parser';
import { parseFilePath } from '../utils/ast.utils';
import * as l10n from '@vscode/l10n';

/** The top-level manifest fields worth echoing in the overview header, in display order. */
const HEADER_FIELDS = ['ID', 'Name', 'Version', 'Author', 'CompatibleGameVersions', 'StringsFolder', 'ModifiesGameplay'];

/** A top-level scalar manifest field's written text, unquoted, or undefined. Name match is case-insensitive like the game's. */
const headerField = (document: AbstractNodeDocument, name: string): string | undefined => {
    for (const element of document.elements) {
        if (!isAssignmentNode(element) || element.left.name.toLowerCase() !== name.toLowerCase()) continue;
        const value = element.right;
        if (value && isValueNode(value)) return String(value.valueType.value).replace(/^"|"$/g, '');
    }
    return undefined;
};

/** Markdown-safe inline code (escapes backticks, which cannot appear in a `.rules` path anyway). */
const code = (text: string): string => '`' + text.replace(/`/g, "'") + '`';

/**
 * A markdown link to a file, labeled with its mod-relative path. The destination is a
 * `vscode://file/…` deep link, not a `file:` uri — markdown-it's link validator (in VS Code's
 * preview too) rejects the `file:` scheme outright, leaving the raw `[…](…)` text visible.
 * Parentheses are percent-encoded on top of the per-segment encoding, since an unencoded `)` in a
 * file name (`Kopie (2).rules`) would close the markdown destination early.
 */
const fileLink = (modRoot: string, absPath: string): string => {
    const encoded = absPath
        .replace(/\\/g, '/')
        .split('/')
        .map((segment) => encodeURIComponent(segment).replace(/\(/g, '%28').replace(/\)/g, '%29'))
        .join('/');
    return `[${relativeToMod(modRoot, absPath)}](vscode://file/${encoded})`;
};

/** The display text of an action's first source: a reference's path, or the inline shape. */
const sourceText = (action: Action): string => {
    const source = action.sources[0];
    if (!source) return '';
    if (isValueNode(source)) return String(source.valueType.value);
    return source.type === 'Group' ? '{ inline group }' : '[ inline list ]';
};

/**
 * Whether each of the action's targets resolves in the effective game tree (vanilla plus the mod's
 * own additions), mirroring the mod-action validator. Undefined when the action tolerates a missing
 * target (`IgnoreIfNotExisting`/`CreateIfNotExisting`), where existence is not a fact to report.
 */
const targetStatus = async (action: Action, token: CancellationToken): Promise<boolean | undefined> => {
    if (action.flags.IgnoreIfNotExisting === true || action.flags.CreateIfNotExisting === true) return undefined;
    if (action.targets.length === 0) return undefined;
    for (const target of action.targets) {
        const resolved = await resolveWithModContext(
            normalizeTargetPath(String(target.valueType.value)),
            target,
            token
        ).catch(() => null);
        if (resolved === null) return false;
    }
    return true;
};

/**
 * Renders the "what does this mod.rules do" markdown report: the manifest header fields, every
 * action with its verb, target, source and resolution status, and the reachability section listing
 * the `.rules` files no action or include ever pulls in (probable forgotten content).
 *
 * @param manifestUri the mod.rules document uri the overview is requested for.
 * @param token cancels target resolution and the reachability walk.
 * @returns the markdown text, or undefined when the uri is not inside a mod.
 */
export const generateModOverview = async (manifestUri: string, token: CancellationToken): Promise<string | undefined> => {
    const manifestPath = uriToFsPath(manifestUri);
    const modRoot = findModRoot(manifestUri);
    if (!modRoot) return undefined;
    const document = await parseFilePath(manifestPath).catch(() => null);
    if (!document) return undefined;
    const actions = parseModActions(document);

    const lines: string[] = [];
    const name = headerField(document, 'Name') ?? basenameOf(manifestUri);
    lines.push(`# ${l10n.t('Mod overview')} — ${name}`);
    lines.push('');
    for (const field of HEADER_FIELDS) {
        const value = headerField(document, field);
        if (value !== undefined) lines.push(`- **${field}**: ${value}`);
    }
    lines.push('');

    // ── Actions ────────────────────────────────────────────────────────────────
    lines.push(`## ${l10n.t('Actions')} (${actions.length})`);
    lines.push('');
    lines.push(
        l10n.t(
            'Each action patches the effective game tree. ✓ the target exists, ✗ it resolves to nothing (the action does nothing in game), · existence is not required (create/ignore flag).'
        )
    );
    lines.push('');
    let broken = 0;
    for (const [index, action] of actions.entries()) {
        if (token.isCancellationRequested) return undefined;
        const verb = action.type === 'Unknown' ? (action.verbText ?? l10n.t('Unknown verb')) : action.type;
        const status = action.type === 'Unknown' ? false : await targetStatus(action, token);
        const mark = status === undefined ? '·' : status ? '✓' : '✗';
        if (status === false) broken++;
        const target = action.targets.map((t) => code(String(t.valueType.value))).join(', ');
        const name = action.nameNode ? ` **${String(action.nameNode.valueType.value)}**` : '';
        const source = sourceText(action);
        const from = source ? ` ← ${code(source)}` : '';
        const flags = Object.entries(action.flags)
            .filter(([, on]) => on)
            .map(([flag]) => flag)
            .join(', ');
        const flagNote = flags ? ` _(${flags})_` : '';
        lines.push(`${index + 1}. ${mark} **${verb}**${name} ${target}${from}${flagNote}`);
    }
    lines.push('');
    if (broken > 0) {
        lines.push(l10n.t('⚠ {0} action(s) have a target that resolves to nothing — they silently do nothing in game.', broken));
        lines.push('');
    }

    // ── Reachability ───────────────────────────────────────────────────────────
    const reachability = await computeModReachability(modRoot, token);
    if (reachability) {
        const total = reachability.allRulesFiles.length;
        const reached = total - reachability.unreachable.length;
        lines.push(`## ${l10n.t('File reachability')}`);
        lines.push('');
        lines.push(
            l10n.t(
                '{0} of {1} `.rules` files are reachable from the manifest (action sources, their includes and inheritance, and the strings folder). The game never loads the rest.',
                reached,
                total
            )
        );
        lines.push('');
        if (reachability.unreachable.length > 0) {
            lines.push(`### ${l10n.t('Unreachable files')} (${reachability.unreachable.length})`);
            lines.push('');
            lines.push(
                l10n.t(
                    'Dead content: backups and templates are expected here, but a part or effect you meant to ship should not be.'
                )
            );
            lines.push('');
            // The conventional convenience-globals file at the mod root deserves its own explanation:
            // it is expected to be here, not forgotten. The game applies the manifest actions to its
            // own Data/cosmoteer.rules and never opens the mod's copy.
            if (reachability.unreachable.some((file) => relativeToMod(modRoot, file).toLowerCase() === 'cosmoteer.rules')) {
                lines.push(
                    l10n.t(
                        'ℹ The root `cosmoteer.rules` here is a documentation convention: the game injects such globals via the manifest actions into its own `Data/cosmoteer.rules` and never loads the mod\'s copy.'
                    )
                );
                lines.push('');
            }
            const chained = reachability.unreachable.filter((file) =>
                reachability.deadReferencers.has(reachabilityKey(file))
            ).length;
            if (chained > 0) {
                lines.push(
                    l10n.t(
                        '{0} of these are referenced by nothing at all. {1} are referenced only from other unreachable files or from commented-out lines (shown as ←), so wiring in the root of such a chain revives every file behind it.',
                        reachability.unreachable.length - chained,
                        chained
                    )
                );
                lines.push('');
            }
            const byFolder = new Map<string, string[]>();
            for (const file of reachability.unreachable) {
                const rel = relativeToMod(modRoot, file);
                const folder = rel.includes('/') ? rel.split('/')[0] : l10n.t('(mod root)');
                (byFolder.get(folder) ?? byFolder.set(folder, []).get(folder)!).push(file);
            }
            for (const [folder, files] of [...byFolder.entries()].sort((a, b) => b[1].length - a[1].length)) {
                lines.push('<details>');
                lines.push(`<summary><b>${folder}</b> (${files.length})</summary>`);
                lines.push('');
                for (const file of files) {
                    const referencers = reachability.deadReferencers.get(reachabilityKey(file));
                    const chain = referencers
                        ? ` ← ${fileLink(modRoot, referencers[0])}` +
                          (referencers.length > 1 ? ` _(+${referencers.length - 1})_` : '')
                        : '';
                    lines.push(`- ${fileLink(modRoot, file)}${chain}`);
                }
                lines.push('');
                lines.push('</details>');
                lines.push('');
            }
        }
    }
    return lines.join('\n');
};
