import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AstType,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isGroupNode,
} from '../../core/ast/ast';
import { globalSettings } from '../../settings';

export class Validator {
    private static _instance: Validator;

    public static get instance(): Validator {
        if (!Validator._instance) {
            Validator._instance = new Validator();
        }
        return Validator._instance;
    }

    private map = new Map<AstType, ValidationCallback<any>>();

    private constructor() {}

    public registerValidation<T extends AbstractNode>(validation: Validation<T>): void {
        this.map.set(validation.type, validation.callback);
    }

    public async validate(node: AbstractNode, cancellationToken: CancellationToken): Promise<ValidationError[]> {
        const promises: Promise<ValidationError | undefined>[] = [];
        promises.push(this.validateRecursive(node, promises, cancellationToken));
        return (
            await Promise.all(promises).catch((error) => {
                if (globalSettings.trace.server === 'verbose') {
                    console.error(error);
                }
                return [];
            })
        ).filter((v) => v !== undefined) as ValidationError[];
    }

    private async validateRecursive(
        node: AbstractNode,
        promises: Promise<ValidationError | undefined>[],
        cancellationToken: CancellationToken
    ): Promise<ValidationError | undefined> {
        // `node` is `null` for an incomplete `Field =` (AssignmentNode.right before a value is
        // typed). Guard it too, or dereferencing `node.type` throws and Promise.all's rejection
        // drops every diagnostic for the enclosing element while the user is mid-edit.
        if (node === undefined || node === null) return;
        const callback = this.map.get(node.type);
        if (callback) {
            promises.push(callback(node, cancellationToken));
        }
        if (isListNode(node) || isGroupNode(node) || isDocumentNode(node)) {
            for (const child of node.elements) {
                promises.push(this.validateRecursive(child, promises, cancellationToken));
            }
            if ((isListNode(node) || isGroupNode(node)) && node.inheritance) {
                for (const child of node.inheritance) {
                    promises.push(this.validateRecursive(child, promises, cancellationToken));
                }
            }
        } else if (isAssignmentNode(node)) {
            promises.push(this.validateRecursive(node.left, promises, cancellationToken));
            if (node.right) promises.push(this.validateRecursive(node.right, promises, cancellationToken));
        } else if (isFunctionCallNode(node)) {
            for (const child of node.arguments) {
                promises.push(this.validateRecursive(child, promises, cancellationToken));
            }
        }
    }
}

export type Validation<T extends AbstractNode> = {
    type: AstType;
    callback: ValidationCallback<T>;
};

type ValidationCallback<T extends AbstractNode> = (
    node: T,
    cancellationToken: CancellationToken
) => Promise<ValidationError | undefined>;

export type ValidationError = {
    message: string;
    node: AbstractNode;
    /**
     * The rule this finding belongs to, which every lint report groups and filters by (see
     * server/src/cli/rule-ids.ts). Where a setting switches the pass off, the id is that setting's
     * key, so a reported rule can be turned off without a lookup table. Usually left unset here and
     * filled in where the pass is invoked, which is the only place a finding's pass is known.
     */
    code?: string;
    /**
     * Byte-offset span to underline instead of `node`'s own span. For findings that read as a whole
     * clause (a faded-out dead field covers its value too, not just the key) where no single node
     * spans it: an AssignmentNode carries no position, so the span cannot come from a node alone.
     */
    range?: { start: number; end: number };
    additionalInfo?: string;
    additionalNode?: AbstractNode;
    /**
     * LSP severity for the emitted diagnostic. Defaults to Error when omitted. Use 'warning' for
     * lint-level findings the game tolerates at load time (e.g. a stylistic unquoted asset path, or
     * a dangling reference that simply resolves to nothing) so they don't read as hard errors.
     */
    severity?: 'error' | 'warning' | 'information' | 'hint';
    /**
     * Marks the flagged span as dead weight the game never acts on, so the editor fades it out
     * instead of underlining it (DiagnosticTag.Unnecessary). Only for findings where removing the
     * span provably changes nothing at load time, never for a finding the author still has to read.
     */
    unnecessary?: boolean;
    /** Optional payload attached to the emitted LSP Diagnostic (e.g. a quick-fix), see server.ts. */
    data?: ValidationErrorData;
};

/**
 * The did-you-mean quick fix a finding carries when a close match was found, meant to be spread into
 * the error so a finding without a match carries no data at all.
 *
 * @param suggestion The closest name the check found, or nothing when it found none.
 * @returns The `data` payload holding the quick fix, or an empty object when there is no suggestion.
 */
export const didYouMeanFix = (suggestion: string | null | undefined): Pick<ValidationError, 'data'> =>
    suggestion ? { data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } } } : {};

/** Extra data round-tripped on a Diagnostic so a code action can act on it without re-analyzing. */
export type ValidationErrorData = {
    /** A "did you mean …" quick fix that replaces the diagnostic's range with `newText`. */
    quickFix?: { title: string; newText: string };
    /**
     * A quick fix deleting the byte-offset span `[start, end)` (e.g. a whole ignored field). The
     * code-action handler widens the span to whole lines when nothing else shares them, so the
     * removal leaves no blank line behind.
     */
    remove?: { title: string; start: number; end: number };
    /**
     * An undefined localization key the code action can offer to insert into the mod's strings files.
     * Carries only the key path (`Parts/Foo`). Resolving the target files and edits happens lazily in
     * the code-action handler (a cross-file, filesystem-touching operation).
     */
    insertLocalizationKey?: { key: string };
    /**
     * A group the required-field check found members missing on, and what the quick fix needs to
     * write them: the byte offset the new lines go at, the offset the group's `}` ends at (checked
     * before anything is written, since the buffer can have moved on since the pass), the fields a
     * value can be written for, and which of them this diagnostic reported. The diagnostic itself is
     * anchored on the group's name, which is not an insertion point, so the offset cannot be derived
     * from its range.
     */
    insertRequiredFields?: {
        offset: number;
        groupEnd: number;
        fields: Array<{ name: string; text: string }>;
        fieldIndex: number;
    };
    /**
     * A component id a part or bullet references but never declares. Carries the name alone. Which
     * kind of component the author meant is a choice only they can make, so the quick fix hands the
     * exchange to the client, which asks and then has the declaration written for it.
     */
    createComponent?: { name: string };
    /**
     * A mod whose ids this file uses without the manifest declaring it as a dependency. Carries only
     * how the mod is named (its published file id or manifest id) and its display name. Finding the
     * manifest and building the edit happens lazily in the code-action handler, since it writes to a
     * different file than the one the diagnostic sits in, which a `rewrite` cannot express.
     */
    addModDependency?: { token: string; name: string };
    /**
     * A quick fix spanning several byte-offset edits in the same file, for migrations a single
     * replacement cannot express (e.g. `Flammable = false` deletes its line and appends
     * `non_flammable` to the sibling `TypeCategories` list). Spans must not overlap. An edit whose
     * `newText` is empty is a removal and gets the same whole-line widening as `remove`.
     */
    rewrite?: { title: string; edits: Array<{ start: number; end: number; newText: string }> };
    /**
     * Marks the finding as an old-game-version leftover the workspace migration command handles.
     * `version` is the game version that made the change (undefined when the changelog does not
     * record it). `apply` names the attached fix the migration may apply mechanically. When absent
     * the finding needs author judgment (e.g. a part whose fireproofing must not clobber an
     * inherited category list) and the migration only reports it. `symbol` names the
     * deprecation-registry entry behind the finding (see deprecations.ts), so a bulk fix can collect
     * this one deprecation across the mod and leave every other finding alone.
     */
    migration?: { version?: string; apply?: 'rewrite' | 'quickFix' | 'remove'; symbol?: string };
};
