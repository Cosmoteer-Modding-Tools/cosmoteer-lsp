export interface AbstractNode {
    type: string;
    parent?: AbstractNode;
    position: Position;
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

export interface Position {
    line: number;
    characterStart: number;
    characterEnd: number;
    start: number;
    end: number;
}

export type PropertyType = PropertyType[] | number | string | boolean;
