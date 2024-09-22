import {
    AbstractNode,
    AstType,
    isArrayNode,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isObjectNode,
} from '../parser/ast';
import { globalSettings } from '../server';

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

    public async validate(node: AbstractNode): Promise<ValidationError[]> {
        const promises: Promise<ValidationError | undefined>[] = [];
        promises.push(this.validateRecursive(node, promises));
        return (
            await Promise.all(promises).catch((error) => {
                if (globalSettings.trace.server !== 'off') {
                    console.error(error);
                }
                return [];
            })
        ).filter((v) => v !== undefined) as ValidationError[];
    }

    private async validateRecursive(
        node: AbstractNode,
        promises: Promise<ValidationError | undefined>[]
    ): Promise<ValidationError | undefined> {
        if (node === undefined) return;
        const callback = this.map.get(node.type);
        if (callback) {
            promises.push(callback(node));
        }
        if (isArrayNode(node) || isObjectNode(node) || isDocumentNode(node)) {
            for (const child of node.elements) {
                promises.push(this.validateRecursive(child, promises));
            }
            if ((isArrayNode(node) || isObjectNode(node)) && node.inheritance) {
                for (const child of node.inheritance) {
                    promises.push(this.validateRecursive(child, promises));
                }
            }
        } else if (isAssignmentNode(node)) {
            promises.push(this.validateRecursive(node.left, promises));
            promises.push(this.validateRecursive(node.right, promises));
        } else if (isFunctionCallNode(node)) {
            for (const child of node.arguments) {
                promises.push(this.validateRecursive(child, promises));
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
) => Promise<ValidationError | undefined>;

export type ValidationError = {
    message: string;
    node: AbstractNode;
    addditionalInfo?: string;
    additionalNode?: AbstractNode;
};
