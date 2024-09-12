import {
    AbstractNode,
    AstType,
    isArrayNode,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isInheritanceNode,
    isObjectNode,
} from '../parser/ast';

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

    public registerValidation<T extends AbstractNode>(
        validation: Validation<T>
    ): void {
        this.map.set(validation.type, validation.callback);
    }

    public validate(node: AbstractNode): ValidationError[] {
        const errors: ValidationError[] = [];
        this.validateRecursive(node, errors);
        return errors;
    }

    private validateRecursive(
        node: AbstractNode,
        errors: ValidationError[]
    ): void {
        if (node === undefined) return;
        const callback = this.map.get(node.type);
        if (callback) {
            const error = callback(node);
            if (error) {
                errors.push(error);
            }
        }
        if (isArrayNode(node) || isObjectNode(node) || isDocumentNode(node)) {
            for (const child of node.elements) {
                this.validateRecursive(child, errors);
            }
        } else if (isAssignmentNode(node)) {
            this.validateRecursive(node.left, errors);
            this.validateRecursive(node.right, errors);
        } else if (isInheritanceNode(node)) {
            this.validateRecursive(node.right, errors);
            for (const child of node.inheritance) {
                this.validateRecursive(child, errors);
            }
        } else if (isFunctionCallNode(node)) {
            for (const child of node.arguments) {
                this.validateRecursive(child, errors);
            }
        }
    }
}

export type Validation<T extends AbstractNode> = {
    type: AstType;
    callback: ValidationCallback<T>;
};

type ValidationCallback<T extends AbstractNode> = (
    node: T
) => ValidationError | undefined;

export type ValidationError = {
    message: string;
    node: AbstractNode;
    addditionalInfo?: string;
    additionalNode?: AbstractNode;
};
