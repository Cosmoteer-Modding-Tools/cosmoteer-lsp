export interface AbstractNode {
    type: AstType;
    parent?: ObjectNode | ArrayNode | AbstractNodeDocument;
    position: AstPosition;
}

export interface AbstractNodeDocument extends AbstractNode {
    type: 'Document';
    elements: AbstractNode[];
}

export interface ObjectNode extends AbstractNode {
    identifier?: IdentifierNode;
    type: 'Object';
    elements: AbstractNode[];
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

export interface AssignmentNode extends AbstractNode {
    type: 'Assignment';
    assignmentType: 'Equals' | 'Colon';
    left: IdentifierNode;
    right:
        | ArrayNode
        | ValueNode
        | ObjectNode
        | FunctionCallNode;
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

export const isDocumentNode = (
    astNode: AbstractNode
): astNode is AbstractNodeDocument => {
    return astNode.type === 'Document';
};

export type PropertyType = PropertyType[] | number | string | boolean;

export type AstType =
    | InheritanceNode['type']
    | AssignmentNode['type']
    | ObjectNode['type']
    | ArrayNode['type']
    | IdentifierNode['type']
    | ValueNode['type']
    | ExpressionNode['type']
    | FunctionCallNode['type']
    | AbstractNodeDocument['type'];