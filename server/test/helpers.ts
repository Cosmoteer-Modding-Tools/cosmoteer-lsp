import { readFileSync } from 'fs';
import { join } from 'path';
import { Location } from 'vscode-languageserver';
import { lexer } from '../src/core/lexer/lexer';
import { parser } from '../src/core/parser/parser';
import {
    AbstractNode,
    AbstractNodeDocument,
    AssignmentNode,
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

/**
 * Narrow a `getDefinition` result to the single Location a test expects.
 *
 * The service answers `Location | Location[] | null`, an array when one reference resolves to several
 * places (a virtual-inheritance path pointing at every concrete override). A test that means "one
 * definition, here" should say so rather than index past the union, so this asserts the shape and the
 * failure message names which half was wrong.
 *
 * @param result the value returned by DefinitionService.getDefinition.
 * @returns the single Location.
 */
export const singleLocation = (result: Location | Location[] | null): Location => {
    if (result === null) throw new Error('expected a definition Location, got null');
    if (Array.isArray(result)) throw new Error(`expected a single definition Location, got ${result.length}`);
    return result;
};

/**
 * The value of an assignment, asserting it has one.
 *
 * `AssignmentNode.right` is null for a bare key (`X` with no `=`), a legitimate parse. A test that
 * built the assignment with a value wants to fail loudly if it ever parses without one, rather than
 * silently proceed on a non-null assertion.
 *
 * @param assignment the assignment whose value is wanted.
 * @returns the assignment's value node.
 */
export const valueOf = (assignment: AssignmentNode): AbstractNode => {
    if (!assignment.right) throw new Error(`assignment "${assignment.left.name}" parsed with no value`);
    return assignment.right;
};

export const readFixture = (name: string): string => readFileSync(join(FIXTURES_DIR, name), { encoding: 'utf-8' });

export const parseFixture = (name: string, uri = `file:///${name}`): AbstractNodeDocument =>
    parser(lexer(readFixture(name)), uri).value;

/**
 * Depth-first walk over every node in the AST (elements, inheritance, assignment sides, args).
 *
 * A bare key (`X` with no `=` value) has a null `right`, which is a legitimate parse result. Skipping
 * it keeps null out of the stream. Walking it used to yield null and make every consumer that reads
 * `.position` throw, which showed up as phantom failures in mutation sweeps.
 *
 * @param node the node to start the walk from.
 * @returns a generator yielding `node` itself and every descendant node.
 */
export const walkAst = function* (node: AbstractNode): Generator<AbstractNode> {
    yield node;
    if (isListNode(node) || isGroupNode(node) || isDocumentNode(node)) {
        for (const child of node.elements) yield* walkAst(child);
        if ((isListNode(node) || isGroupNode(node)) && node.inheritance) {
            for (const child of node.inheritance) yield* walkAst(child);
        }
    } else if (isAssignmentNode(node)) {
        yield* walkAst(node.left);
        if (node.right) yield* walkAst(node.right);
    } else if (isFunctionCallNode(node)) {
        for (const arg of node.arguments) yield* walkAst(arg);
    } else if (isMathExpressionNode(node)) {
        for (const el of node.elements) yield* walkAst(el);
    }
};

/**
 * Find the first reference ValueNode whose textual value matches `reference`.
 *
 * @param document the parsed document to search.
 * @param reference the reference text to match, such as `&Test1/TestValue`.
 * @returns the matching reference node.
 */
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
 *
 * @param value the value to copy.
 * @returns a structural copy of `value` with every `parent` key removed.
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
