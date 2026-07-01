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
}

export interface ValueNode extends AbstractNode {
    type: 'Value';
    valueType: ValueNodeTypes;
    delimiter?: ';' | ',';
    fileType?: string;
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

export interface ExpressionNode extends AbstractNode {
    type: 'Expression';
    // `^` is mXparser exponentiation (emitted only when not followed by `/`, since a leading
    // `^/…` is a super-path reference). `!` is mXparser's postfix factorial — it has no right
    // operand and applies to the value immediately before it.
    expressionType: '+' | '-' | '*' | '/' | '^' | '!';
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
    right: ListNode | ValueNode | GroupNode | FunctionCallNode | MathExpressionNode;
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

export type AstType =
    | AssignmentNode['type']
    | GroupNode['type']
    | ListNode['type']
    | IdentifierNode['type']
    | ValueNode['type']
    | ExpressionNode['type']
    | FunctionCallNode['type']
    | AbstractNodeDocument['type']
    | MathExpressionNode['type'];
