import { DocumentUri } from 'vscode-languageserver';

export interface AbstractNode {
    type: AstType;
    parent?: GroupNode | ListNode | AbstractNodeDocument;
    position: AstPosition;
}

export interface AbstractNodeDocument extends AbstractNode {
    type: 'Document';
    elements: AbstractNode[];
    uri: DocumentUri;
}

export interface GroupNode extends AbstractNode {
    identifier?: IdentifierNode;
    type: 'Group';
    inheritance?: ValueNode[];
    elements: AbstractNode[];
}

export interface ListNode extends AbstractNode {
    identifier?: IdentifierNode;
    type: 'List';
    inheritance?: ValueNode[];
    elements: AbstractNode[];
}

export interface IdentifierNode extends AbstractNode {
    type: 'Identifier';
    name: string;
    delimiter?: ';' | ',';
}

export interface ValueNode extends AbstractNode {
    type: 'Value';
    valueType: ValueNodeTypes;
    delimiter?: ';' | ',';
    parenthesized?: boolean;
    quoted?: boolean;
}

export type ValueNodeTypes =
    | {
          type: 'String';
          value: string;
      }
    | {
          type: 'Number';
          value: number;
      }
    | {
          type: 'Boolean';
          value: boolean;
      }
    | {
          type: 'Reference';
          value: string;
      }
    | {
          type: 'Sprite';
          value: string;
      }
    | {
          type: 'Sound';
          value: string;
      }
    | {
          type: 'Shader';
          value: string;
      };

/**
 * The mXparser 4.4.2 operators the lexer does not emit as single EXPRESSION tokens. The parser
 * assembles them from adjacent tokens in math position (see `matchAssembledOperator`): tetration
 * `^^`, modulo `#`, the boolean conjunction/disjunction/implication families, binary relations
 * and the bitwise operators. The game hands the whole field value to mXparser, so all of these
 * compute in `.rules` math. The `/\`, `\/`, `~/\`, `~\/` spellings are excluded on purpose: the
 * ObjectText tokenizer treats `\` as whitespace, so they can never reach mXparser from a
 * `.rules` value.
 */
export const MX_ASSEMBLED_OPERATORS = [
    '^^',
    '#',
    '&',
    '&&',
    '~&',
    '~&&',
    '|',
    '||',
    '~|',
    '~||',
    '(+)',
    '-->',
    '<--',
    '<->',
    '-/>',
    '</-',
    '=',
    '==',
    '<>',
    '~=',
    '!=',
    '<',
    '>',
    '<=',
    '>=',
    '@&',
    '@|',
    '@^',
    '@<<',
    '@>>',
] as const;
export type MxAssembledOperator = (typeof MX_ASSEMBLED_OPERATORS)[number];

export interface ExpressionNode extends AbstractNode {
    type: 'Expression';
    // `^` is mXparser exponentiation (emitted only when not followed by `/`, since a leading
    // `^/…` is a super-path reference). `!` is mXparser's postfix factorial. It has no right
    // operand and applies to the value immediately before it. The assembled operators
    // (boolean/relational/bitwise, `#`, `^^`) are only produced in the narrow
    // "math operand, operator, `(` or number" shape, see {@link MX_ASSEMBLED_OPERATORS}.
    expressionType: '+' | '-' | '*' | '/' | '^' | '!' | MxAssembledOperator;
}

export interface FunctionCallNode extends AbstractNode {
    type: 'FunctionCall';
    name: string;
    arguments: Array<ValueNode | FunctionCallNode | ExpressionNode>;
}

export interface AssignmentNode extends AbstractNode {
    type: 'Assignment';
    assignmentType: 'Equals' | 'Colon';
    left: IdentifierNode;
    /** Null for an in-progress empty value (`Type = ` with nothing before the newline), which the
     *  OT grammar reads as an empty field rather than consuming the next line as the value. */
    right: ListNode | ValueNode | GroupNode | FunctionCallNode | MathExpressionNode | null;
}

export interface MathExpressionNode extends AbstractNode {
    type: 'MathExpression';
    elements: Array<ValueNode | MathExpressionNode | ExpressionNode>;
}

export interface AstPosition {
    line: number;
    characterStart: number;
    characterEnd: number;
    start: number;
    end: number;
}

// The guards tolerate a null/undefined node: incomplete input (e.g. a `Name=` with no value yet)
// produces assignment nodes whose `right` is null, and consumers narrow them through these guards.
// Returning false rather than dereferencing keeps an in-progress edit from crashing the request.
export const isGroupNode = (astNode: AbstractNode | null | undefined): astNode is GroupNode => {
    return astNode?.type === 'Group';
};

export const isListNode = (astNode: AbstractNode | null | undefined): astNode is ListNode => {
    return astNode?.type === 'List';
};

export const isIdentifierNode = (astNode: AbstractNode | null | undefined): astNode is IdentifierNode => {
    return astNode?.type === 'Identifier';
};

export const isValueNode = (astNode: AbstractNode | null | undefined): astNode is ValueNode => {
    return astNode?.type === 'Value';
};

export const isExpressionNode = (astNode: AbstractNode | null | undefined): astNode is ExpressionNode => {
    return astNode?.type === 'Expression';
};

export const isFunctionCallNode = (astNode: AbstractNode | null | undefined): astNode is FunctionCallNode => {
    return astNode?.type === 'FunctionCall';
};

export const isAssignmentNode = (astNode: AbstractNode | null | undefined): astNode is AssignmentNode => {
    return astNode?.type === 'Assignment';
};

export const isDocumentNode = (astNode: AbstractNode | null | undefined): astNode is AbstractNodeDocument => {
    return astNode?.type === 'Document';
};

export const isMathExpressionNode = (astNode: AbstractNode | null | undefined): astNode is MathExpressionNode => {
    return astNode?.type === 'MathExpression';
};

/**
 * Every node the parser produces, as one union. `AbstractNode` is the shape they share and is what
 * a consumer holding an unidentified node types it as; `AstNode` is the same node once it is known
 * to be one of the nine, which is what lets `switch (node.type)` narrow and be checked for
 * exhaustiveness. Prefer it over `AbstractNode` in a signature that will branch on the kind.
 */
export type AstNode =
    | AbstractNodeDocument
    | GroupNode
    | ListNode
    | IdentifierNode
    | ValueNode
    | ExpressionNode
    | FunctionCallNode
    | AssignmentNode
    | MathExpressionNode;

export type AstType = AstNode['type'];

/**
 * Narrows a node to the union, which is sound for anything the parser built: `type` is only ever
 * one of the nine tags. It exists because the tree is typed as `AbstractNode` at nearly every seam,
 * and a `switch` needs the union to narrow against.
 *
 * @param astNode the node to narrow.
 * @returns the same node, typed as the union.
 */
export const asAstNode = (astNode: AbstractNode): AstNode => astNode as AstNode;

/**
 * The nodes directly under one node: a container's elements, or the value an assignment binds.
 *
 * Three things are deliberately left out of the children here, and a pass that needs them reaches
 * for them itself:
 * - a {@link MathExpressionNode}'s `elements` and a {@link FunctionCallNode}'s `arguments`, which
 *   are operands of a value rather than members of a container. A pass that reads inside math
 *   (`validator.division-by-zero.ts`) recurses into them by hand, on purpose.
 * - a group's or list's `inheritance` bases, which are references to somewhere else rather than
 *   content of this node. `rename-file-references.ts` walks them alongside the children.
 *
 * Widening this would silently change every pass that walks a document, so the omissions are
 * documented rather than fixed.
 *
 * @param node the node to descend.
 * @returns its direct children, empty for a leaf.
 */
export const childNodesOf = (node: AbstractNode): AbstractNode[] =>
    isGroupNode(node) || isListNode(node) || isDocumentNode(node)
        ? node.elements
        : isAssignmentNode(node) && node.right
          ? [node.right]
          : [];

/**
 * Every node at or below `node`, depth first, parents before children. This is the shared
 * replacement for a hand-written recursive `visit` closure: a pass that wants some particular kind
 * filters this rather than re-writing the descent.
 *
 * Being a generator matters for the passes that stop early, which is most of them: nothing below
 * the node that answered the question is visited. It does not check a cancellation token, because a
 * caller that needs one has to decide what to answer when it trips, so that check stays in the loop
 * body where the caller can see it.
 *
 * It descends through {@link childNodesOf}, so it inherits that function's omissions: math operands,
 * call arguments and inheritance bases are not reached.
 *
 * @param node the node to start from, which is itself yielded first.
 * @yields `node` and then each descendant.
 */
export function* descendants(node: AbstractNode): Generator<AbstractNode> {
    yield node;
    for (const child of childNodesOf(node)) yield* descendants(child);
}
