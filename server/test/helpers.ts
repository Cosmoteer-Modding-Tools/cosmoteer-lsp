import { readFileSync } from 'fs';
import { join } from 'path';
import { lexer } from '../src/core/lexer/lexer';
import { parser } from '../src/core/parser/parser';
import {
    AbstractNode,
    AbstractNodeDocument,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isMathExpressionNode,
    isGroupNode,
    isValueNode,
    ValueNode,
} from '../src/core/ast/ast';

export const FIXTURES_DIR = join(__dirname, 'fixtures');

export const readFixture = (name: string): string => readFileSync(join(FIXTURES_DIR, name), { encoding: 'utf-8' });

export const parseFixture = (name: string, uri = `file:///${name}`): AbstractNodeDocument =>
    parser(lexer(readFixture(name)), uri).value;

/** Depth-first walk over every node in the AST (elements, inheritance, assignment sides, args). */
export const walkAst = function* (node: AbstractNode): Generator<AbstractNode> {
    yield node;
    if (isListNode(node) || isGroupNode(node) || isDocumentNode(node)) {
        for (const child of node.elements) yield* walkAst(child);
        if ((isListNode(node) || isGroupNode(node)) && node.inheritance) {
            for (const child of node.inheritance) yield* walkAst(child);
        }
    } else if (isAssignmentNode(node)) {
        yield* walkAst(node.left);
        yield* walkAst(node.right);
    } else if (isFunctionCallNode(node)) {
        for (const arg of node.arguments) yield* walkAst(arg);
    } else if (isMathExpressionNode(node)) {
        for (const el of node.elements) yield* walkAst(el);
    }
};

/** Find the first reference ValueNode whose textual value matches `reference`. */
export const findReferenceNode = (document: AbstractNodeDocument, reference: string): ValueNode => {
    for (const node of walkAst(document)) {
        if (isValueNode(node) && node.valueType.type === 'Reference' && node.valueType.value === reference) {
            return node;
        }
    }
    throw new Error(`No reference node found for "${reference}"`);
};

/**
 * AST nodes carry circular `parent` back-references which cannot be serialized
 * into a snapshot. This produces a structural copy with `parent` removed so the
 * tree can be snapshotted deterministically.
 */
export const stripParents = <T>(value: T): T => {
    const seen = new WeakSet<object>();
    const walk = (input: unknown): unknown => {
        if (Array.isArray(input)) {
            return input.map(walk);
        }
        if (input && typeof input === 'object') {
            if (seen.has(input as object)) return '[Circular]';
            seen.add(input as object);
            const out: Record<string, unknown> = {};
            for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
                if (key === 'parent') continue;
                out[key] = walk(val);
            }
            return out;
        }
        return input;
    };
    return walk(value) as T;
};
