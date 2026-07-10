import { CancellationToken, InlayHint, InlayHintKind, Position, Range } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    AstPosition,
    isListNode,
    isAssignmentNode,
    isExpressionNode,
    isFunctionCallNode,
    isMathExpressionNode,
    isGroupNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { evaluateExpressionGroup, evaluateNumericValue, formatNumber } from '../../semantics/value-evaluator';

/**
 * Inlay hints (`textDocument/inlayHint`) showing the computed result of math assignments
 * `Damage = (&Base)/2 + ceil(17/2)` renders ` = 14` at the end of the line. The hardest part
 * of reading `.rules` is seeing what an expression actually works out to. This surfaces it
 * inline. Only assignments whose value is a `MathExpression`/`FunctionCall` that fully
 * evaluates get a hint (see {@link evaluateNumericValue}) anything non-numeric stays bare.
 */
export class InlayHintService {
    private static _instance: InlayHintService;
    private constructor() {}

    public static get instance(): InlayHintService {
        if (!InlayHintService._instance) {
            InlayHintService._instance = new InlayHintService();
        }
        return InlayHintService._instance;
    }

    public async getInlayHints(
        document: AbstractNodeDocument,
        range: Range,
        cancellationToken: CancellationToken
    ): Promise<InlayHint[]> {
        const hints: InlayHint[] = [];
        await this.collect(document.elements, range, cancellationToken, hints);
        return hints;
    }

    private async collect(
        nodes: AbstractNode[],
        range: Range,
        cancellationToken: CancellationToken,
        hints: InlayHint[]
    ): Promise<void> {
        for (const node of nodes) {
            if (!node || cancellationToken.isCancellationRequested) continue;
            if (isAssignmentNode(node)) {
                const right = node.right;
                if (!right) continue;
                if (
                    isMathExpressionNode(right) ||
                    isFunctionCallNode(right) ||
                    isReferenceValueNode(right) ||
                    isSuffixedNumberLiteral(right)
                ) {
                    // Math/function results and plain reference assignments (`COST = &<file>/COST`)
                    // both annotate with the number they resolve to — a cross-file or inherited
                    // value is otherwise invisible without tracing it by hand. A bare percentage
                    // literal (`Chance = 50%`) is annotated with its decimal value (`= 0.5`), the
                    // form the game's math actually uses, which the source doesn't show.
                    await this.emitHint([right], range, cancellationToken, hints);
                } else if (isListNode(right)) {
                    await this.collectList(right.elements, range, cancellationToken, hints);
                } else if (isGroupNode(right)) {
                    await this.collect(right.elements, range, cancellationToken, hints);
                }
            } else if (isListNode(node)) {
                await this.collectList(node.elements, range, cancellationToken, hints);
            } else if (isGroupNode(node)) {
                await this.collect(node.elements, range, cancellationToken, hints);
            }
        }
    }

    /**
     * List values store math inline-flattened with no grouping node — `[10 * 2, &A + 5, 30]`
     * parses to `[10, *, 2, &A, +, 5, 30]`, the commas dropped. We re-segment by the only rule a
     * flat arithmetic stream allows: an operand directly after an operand begins a new entry. Each
     * segment that actually computes (contains an operator or function call) gets its own ` = N`.
     */
    private async collectList(
        elements: AbstractNode[],
        range: Range,
        cancellationToken: CancellationToken,
        hints: InlayHint[]
    ): Promise<void> {
        let group: AbstractNode[] = [];
        let prevWasOperand = false;
        const flush = async () => {
            if (group.length) await this.emitHint(group, range, cancellationToken, hints);
            group = [];
            prevWasOperand = false;
        };
        for (const element of elements) {
            if (!element || cancellationToken.isCancellationRequested) continue;
            if (isExpressionNode(element)) {
                group.push(element);
                prevWasOperand = false;
                continue;
            }
            // A nested container is its own scope, never part of a numeric segment.
            if (isListNode(element)) {
                await flush();
                await this.collectList(element.elements, range, cancellationToken, hints);
                continue;
            }
            if (isGroupNode(element)) {
                await flush();
                await this.collect(element.elements, range, cancellationToken, hints);
                continue;
            }
            // Operand (value / function call): two operands in a row means a dropped comma.
            if (prevWasOperand) await flush();
            group.push(element);
            prevWasOperand = true;
        }
        await flush();
    }

    /**
     * Evaluate one expression segment and, if it computes to a number, push its ` = N` hint at the
     * segment's end. Single bare values (a plain `5`, a lone `&Ref`) are skipped — only segments
     * carrying real computation (an operator or function call) are worth annotating.
     */
    private async emitHint(
        group: AbstractNode[],
        range: Range,
        cancellationToken: CancellationToken,
        hints: InlayHint[]
    ): Promise<void> {
        // Worth annotating if it actually computes (operator / function / math group), OR it is a
        // lone reference / percentage literal whose resolved number isn't visible in the source.
        const computes =
            group.some((node) => isExpressionNode(node) || isFunctionCallNode(node) || isMathExpressionNode(node)) ||
            (group.length === 1 && (isReferenceValueNode(group[0]) || isSuffixedNumberLiteral(group[0])));
        if (!computes) return;
        const end = endPositionOf(group);
        if (end.line < range.start.line || end.line > range.end.line) return;
        const value = await evaluateExpressionGroup(group, cancellationToken);
        if (value === null) return;
        hints.push({
            position: end,
            label: `= ${formatNumber(value)}`,
            kind: InlayHintKind.Type,
            paddingLeft: true,
        });
    }
}

/** A value node that points elsewhere (`&Name`, `&<file>/X`, `&/super`, …) — its resolved value is hidden. */
const isReferenceValueNode = (node: AbstractNode): node is ValueNode =>
    isValueNode(node) && node.valueType.type === 'Reference';

/**
 * An unquoted percentage or degrees literal (`50%`, `-3.5 %`, `90d`). The lexer keeps the suffix
 * inside the value token, so these are plain `String`-typed values rather than `Number`s. The
 * evaluator converts them the way the game does before mXparser sees them (`÷100` for percent,
 * degrees to radians), which is what the inlay hint surfaces. A radians literal (`2r`) converts to
 * its own digits, so it gets no hint. Mirrors the suffix rules in {@link evaluateNumericValue}'s
 * `evaluateValue`.
 */
const isSuffixedNumberLiteral = (node: AbstractNode): node is ValueNode =>
    isValueNode(node) && !node.quoted && /^-?\d*\.?\d+\s*[%d]$/.test(String(node.valueType.value));

/** The position just after the last character of an expression segment (where its ` = N` hint sits). */
const endPositionOf = (nodes: AbstractNode[]): Position => {
    let line = -1;
    let character = -1;
    const consider = (position?: AstPosition) => {
        if (!position) return;
        if (position.line > line || (position.line === line && position.characterEnd > character)) {
            line = position.line;
            character = position.characterEnd;
        }
    };
    const walk = (current: AbstractNode | null | undefined): void => {
        if (!current) return;
        consider(current.position);
        if (isMathExpressionNode(current)) current.elements.forEach(walk);
        else if (isFunctionCallNode(current)) current.arguments.forEach(walk);
    };
    nodes.forEach(walk);
    return Position.create(line < 0 ? 0 : line, character < 0 ? 0 : character);
};
