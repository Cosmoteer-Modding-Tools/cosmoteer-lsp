import { DocumentUri } from 'vscode-languageserver';

export interface AbstractNode {
    type: AstType;
    parent?: ObjectNode | ArrayNode | AbstractNodeDocument;
    position: AstPosition;
}

export interface AbstractNodeDocument extends AbstractNode {
    type: 'Document';
    elements: AbstractNode[];
    uri: DocumentUri;
}

export interface ObjectNode extends AbstractNode {
    identifier?: IdentifierNode;
    type: 'Object';
    inheritance?: ValueNode[];
    elements: AbstractNode[];
}

export interface ArrayNode extends AbstractNode {
    identifier?: IdentifierNode;
    type: 'Array';
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
    expressionType: '+' | '-' | '*' | '/';
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
    right: ArrayNode | ValueNode | ObjectNode | FunctionCallNode | MathExpressionNode;
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

export const isObjectNode = (astNode: AbstractNode): astNode is ObjectNode => {
    return astNode.type === 'Object';
};

export const isArrayNode = (astNode: AbstractNode): astNode is ArrayNode => {
    return astNode.type === 'Array';
};

export const isIdentifierNode = (astNode: AbstractNode): astNode is IdentifierNode => {
    return astNode.type === 'Identifier';
};

export const isValueNode = (astNode: AbstractNode): astNode is ValueNode => {
    return astNode.type === 'Value';
};

export const isExpressionNode = (astNode: AbstractNode): astNode is ExpressionNode => {
    return astNode.type === 'Expression';
};

export const isFunctionCallNode = (astNode: AbstractNode): astNode is FunctionCallNode => {
    return astNode.type === 'FunctionCall';
};

export const isAssignmentNode = (astNode: AbstractNode): astNode is AssignmentNode => {
    return astNode.type === 'Assignment';
};

export const isDocumentNode = (astNode: AbstractNode): astNode is AbstractNodeDocument => {
    return astNode.type === 'Document';
};

export const isMathExpressionNode = (astNode: AbstractNode): astNode is MathExpressionNode => {
    return astNode.type === 'MathExpression';
};

export type AstType =
    | AssignmentNode['type']
    | ObjectNode['type']
    | ArrayNode['type']
    | IdentifierNode['type']
    | ValueNode['type']
    | ExpressionNode['type']
    | FunctionCallNode['type']
    | AbstractNodeDocument['type']
    | MathExpressionNode['type'];
