export interface AbstractNode {
    type: string;
    parent?: AbstractNode;
    position: AstPosition;
}

export interface AbstractNodeDocument {
    type: 'Document';
    body: AbstractNode[];
}

export interface ObjectNode extends AbstractNode {
    identifier?: IdentifierNode;
    type: 'Object';
    properties: AbstractNode[];
}

export interface ArrayNode extends AbstractNode {
    identifier?: IdentifierNode;
    type: 'Array';
    elements: AbstractNode[];
}

export interface IdentifierNode extends AbstractNode {
    type: 'Identifier';
    name: string;
}

export interface ValueNode extends AbstractNode {
    type: 'Value';
    valueType: 'String' | 'Number' | 'Boolean' | 'Reference' | 'Sprite';
    delimiter?: ';' | ',';
    values: PropertyType;
    fileType?: 'png';
    parenthesized?: boolean;
}

export interface ExpressionNode extends AbstractNode {
    type: 'Expression';
    expressionType: '+' | '-' | '*' | '/';
}

export interface FunctionCallNode extends AbstractNode {
    type: 'FunctionCall';
    name: string;
    arguments: Array<ValueNode | FunctionCallNode | ExpressionNode>;
}

// Make a node for expression and function nodes
export interface MathExpressionNode extends AbstractNode {
    type: 'MathExpression';
    expressionType: '+' | '-' | '*' | '/';
    left: ValueNode | FunctionCallNode;
    right: ValueNode | FunctionCallNode;
}

export interface AssignmentNode extends AbstractNode {
    type: 'Assignment';
    assignmentType: 'Equals' | 'Colon';
    left: IdentifierNode;
    right:
        | ArrayNode
        | ValueNode
        | ObjectNode
        | FunctionCallNode
        | MathExpressionNode;
}

export interface InheritanceNode extends AbstractNode {
    type: 'Inheritance';
    left?: IdentifierNode;
    inheritance: ValueNode[];
    right: ObjectNode | ArrayNode;
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

export const isIdentifierNode = (
    astNode: AbstractNode
): astNode is IdentifierNode => {
    return astNode.type === 'Identifier';
};

export const isValueNode = (astNode: AbstractNode): astNode is ValueNode => {
    return astNode.type === 'Value';
};

export const isExpressionNode = (
    astNode: AbstractNode
): astNode is ExpressionNode => {
    return astNode.type === 'Expression';
};

export const isFunctionCallNode = (
    astNode: AbstractNode
): astNode is FunctionCallNode => {
    return astNode.type === 'FunctionCall';
};

export const isMathExpressionNode = (
    astNode: AbstractNode
): astNode is MathExpressionNode => {
    return astNode.type === 'MathExpression';
};

export const isAssignmentNode = (
    astNode: AbstractNode
): astNode is AssignmentNode => {
    return astNode.type === 'Assignment';
};

export const isInheritanceNode = (
    astNode: AbstractNode
): astNode is InheritanceNode => {
    return astNode.type === 'Inheritance';
};

export type PropertyType = PropertyType[] | number | string | boolean;
