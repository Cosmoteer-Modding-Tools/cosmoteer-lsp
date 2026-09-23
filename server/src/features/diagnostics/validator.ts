import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AstType, isAssignmentNode } from '../../core/ast/ast';

/**
 * The values reached as operands of an expression. The parser gives an operand the container the
 * expression is written in as its parent, so the node itself does not say that it stands in one,
 * and the value checks that read a value as a member of its container have to be told.
 *
 * Membership is a fact about the node, so it never has to be taken back, and the entries die with
 * the AST they belong to.
 */
export const expressionOperands = new WeakSet<AbstractNode>();

export type Validation<T extends AbstractNode> = {
    type: AstType;
    callback: ValidationCallback<T>;
};

export type ValidationCallback<T extends AbstractNode> = (
    node: T,
    cancellationToken: CancellationToken
) => Promise<ValidationError | undefined>;

export type ValidationError = {
    message: string;
    node: AbstractNode;
    /**
     * The rule this finding belongs to, which every lint report groups and filters by (see
     * features/diagnostics/rule-ids.ts). Where a setting switches the pass off, the id is that
     * setting's key, so a reported rule can be turned off without a lookup table. Usually left
     * unset here and filled in where the pass is invoked, which is the only place a finding's pass
     * is known.
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
 * The byte span a finding is underlined at: its own span where it names one, else the span of the
 * node it is anchored on.
 *
 * An assignment is the one node the parser gives no span of its own, so a finding anchored on one
 * is placed on its written name instead, which is where every pass that anchors on a member points
 * anyway. A finding that can be placed nowhere at all is answered with null rather than with the
 * top of the file, so the caller drops it: an underline at line one describes nothing, and reading
 * a missing span as a zero used to take the whole pass down with it.
 *
 * @param error the finding to place.
 * @returns the span to underline, or null when the finding carries no placeable node.
 */
export const findingSpanOf = (error: ValidationError): { start: number; end: number } | null => {
    if (error.range) return error.range;
    const node: AbstractNode | undefined = error.node;
    if (node?.position) return { start: node.position.start, end: node.position.end };
    if (node && isAssignmentNode(node)) {
        const start = node.left.position?.start;
        const end = node.right?.position?.end ?? node.left.position?.end;
        if (start !== undefined && end !== undefined) return { start, end };
    }
    return null;
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
     * A language strings file that declares fewer keys than the languages beside it. Carries only
     * the language and how many keys are missing. Reading the other languages back and building
     * the insertion happens lazily in the code-action handler, since it touches the index and the
     * file on disk.
     */
    fillLanguageKeys?: { language: string; count: number };
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
