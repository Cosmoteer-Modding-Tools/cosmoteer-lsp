import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode } from '../../../core/ast/ast';
import { registryOf, requiredFieldsOf } from '../../../document/schema/schema';
import { findModRoot } from '../../../mod/mod-root';
import { globalSettings } from '../../../settings';
import { parseText } from '../../../utils/ast.utils';
import { fieldSnippet } from '../../completion/autocompletion.schema-fields';
import { memberIndentAt, placeholderValue } from '../../diagnostics/required-field-insert';
import { ownerComponentRegistryOf } from '../../diagnostics/validator.schema-sibling';
import { uriToFsPath } from '../../navigation/workspace-files';
import { documentFor, indentUnitOf, lineEndingOf, openBuffers } from '../command-host';
import { memberSpanOf } from '../shared-base/member-record';
import { plainTextOf } from '../snippet-action';
import { CreateComponentArgs, CreateComponentHost, CreateComponentResult } from './create-component.types';

/**
 * The `workspace/executeCommand` id that declares a component a part or bullet references but does
 * not have. Both clients invoke it twice: without a type it reports the component kinds that may be
 * declared here, and with one it answers with the text to write and where it goes.
 */
export const CREATE_COMPONENT_COMMAND = 'cosmoteer.createComponent';

/**
 * The command the quick fix carries, deliberately absent from the server's `executeCommandProvider`
 * so that it is never executed here. Which kind of component the author meant is a choice only they
 * can make, and a code action has no way to ask for one. A client resolves a command against its own
 * handlers only when the server does not claim it, which is what hands the exchange to the client.
 */
export const CREATE_COMPONENT_ACTION_COMMAND = 'cosmoteer.createComponentFromAction';

/** The name of the group a part or bullet declares its components in. */
const COMPONENTS = 'Components';

/**
 * The groups enclosing an offset, outermost first, so the walk can ask each level what it holds.
 *
 * @param container the group or document to search.
 * @param offset the caret's byte offset.
 * @param chain the groups found so far.
 * @returns the chain, empty when the offset falls in no group.
 */
const groupChain = (
    container: AbstractNodeDocument | GroupNode,
    offset: number,
    chain: GroupNode[] = []
): GroupNode[] => {
    for (const element of container.elements) {
        const span = memberSpanOf(element);
        if (!span || offset < span.start || offset >= span.end) continue;
        const value = isGroupNode(element) ? element : undefined;
        if (value) {
            chain.push(value);
            groupChain(value, offset, chain);
        }
        return chain;
    }
    return chain;
};

/**
 * The `Components` group a member of that name holds, whatever it is written as.
 *
 * @param container the group or document to read.
 * @returns the group, or undefined when the container declares no components.
 */
const componentsMemberOf = (container: AbstractNodeDocument | GroupNode): GroupNode | undefined => {
    for (const element of container.elements) {
        if (isGroupNode(element) && element.identifier?.name.toLowerCase() === COMPONENTS.toLowerCase()) return element;
    }
    return undefined;
};

/**
 * Where a new component declaration goes: the `Components` group the file owns, or the owner group
 * itself when the file declares no such group and one has to be written with it.
 *
 * The caret can be anywhere in the owner, since the reference that named nothing is usually written
 * on a component rather than in the components group, so the chain is read from the inside out and
 * the first level that holds a `Components` group wins.
 *
 * @param document the parsed document.
 * @param offset the byte offset the reference sits at.
 * @returns the group to write into and whether it is the components group itself.
 */
const insertTarget = (
    document: AbstractNodeDocument,
    offset: number
): { container: AbstractNodeDocument | GroupNode; isComponents: boolean } | undefined => {
    const chain = groupChain(document, offset);
    for (const group of [...chain].reverse()) {
        if (group.identifier?.name.toLowerCase() === COMPONENTS.toLowerCase())
            return { container: group, isComponents: true };
        const components = componentsMemberOf(group);
        if (components) return { container: components, isComponents: true };
    }
    const rootComponents = componentsMemberOf(document);
    if (rootComponents) return { container: rootComponents, isComponents: true };
    // The owner is the outermost group the offset sits in, which is the `Part` group of a part file
    // and the root group of a bullet. A file whose reference sits outside every group has no owner to
    // write a components group into.
    const owner = chain[0];
    if (owner) return { container: owner, isComponents: false };
    return undefined;
};

/**
 * The offset a new member goes at inside a container, which is the end of its last member so the
 * closing brace stays where the author put it.
 *
 * @param container the group to write into.
 * @returns the offset, or undefined when the container is not closed or holds no member with a span.
 */
const appendOffsetIn = (container: AbstractNodeDocument | GroupNode): number | undefined => {
    const end = isGroupNode(container as AbstractNode) ? (container as GroupNode).position.end : undefined;
    let offset = 0;
    for (const element of container.elements) {
        const span = memberSpanOf(element);
        if (span) offset = Math.max(offset, span.end);
    }
    if (offset === 0) return undefined;
    if (end !== undefined && (end <= 0 || offset >= end)) return undefined;
    return offset;
};

/**
 * Whether a container already declares a member of that name, which is what the game reads first and
 * what makes a second declaration of the same name pointless.
 *
 * @param container the group to read.
 * @param name the name to look for.
 * @returns true when the name is already written there.
 */
const declares = (container: AbstractNodeDocument | GroupNode, name: string): boolean =>
    container.elements.some((element: AbstractNode) => {
        if (!isGroupNode(element)) return false;
        return element.identifier?.name.toLowerCase() === name.toLowerCase();
    });

/**
 * The declaration to write for one component kind: its `Type`, then every field the game throws
 * without, each carrying a tab stop so the author walks them in order.
 *
 * @param name the component's name.
 * @param type the `Type` discriminator.
 * @param cls the class the discriminator selects.
 * @param indent the indentation the declaration is written at.
 * @param step one level of indentation as the file writes it.
 * @param lineEnding the ending the file already uses.
 * @returns the snippet body.
 */
const declarationSnippet = (
    name: string,
    type: string,
    cls: string,
    indent: string,
    step: string,
    lineEnding: string
): string => {
    const lines = [`${name}`, `${indent}{`, `${indent}${step}Type = ${type}`];
    let stop = 0;
    for (const field of requiredFieldsOf(cls)) {
        if (field.name === 'Type') continue;
        // A kind with no literal the fix may invent is written as an empty tab stop for the author.
        const value = `\${${++stop}:${placeholderValue(field.valueType) ?? ''}}`;
        for (const line of fieldSnippet(field.name, field.valueType, value).split('\n')) {
            lines.push(`${indent}${step}${line}`);
        }
    }
    lines.push(`${indent}${step}$0`, `${indent}}`);
    return lines.join(lineEnding);
};

/**
 * Declares a component a part or bullet references but never writes. Called twice: the first round
 * reports the kinds the owner may declare, the second writes the one the author picked.
 *
 * The insertion is computed here rather than in the client because where a component goes is a
 * question about the file's shape: a part that inherits its components has no group of its own to
 * write into, and one is created with the declaration in that case.
 *
 * @param args what the client sent.
 * @param host the server facilities the buffers are read through.
 * @param token cancellation for the file read.
 * @returns the kinds, the text to write, or why nothing can be.
 */
export const createComponent = async (
    args: CreateComponentArgs,
    host: CreateComponentHost,
    token: CancellationToken
): Promise<CreateComponentResult> => {
    if (!args?.uri || !args.name) return { failure: 'stale' };
    if (!findModRoot(args.uri) && !globalSettings.allowEditingVanillaFiles) return { failure: 'notEditable' };
    const fsPath = uriToFsPath(args.uri);
    if (!fsPath) return { failure: 'stale' };
    const textDocument = await documentFor(fsPath, openBuffers(host));
    if (!textDocument || token.isCancellationRequested) return { failure: 'stale' };
    const text = textDocument.getText();
    const document: AbstractNodeDocument = parseText(text, fsPath);

    const registryName = ownerComponentRegistryOf(document);
    if (!registryName) return { failure: 'noOwner' };
    const registry = registryOf(registryName);
    if (!registry) return { failure: 'noOwner' };

    if (!args.type) {
        const choices = Object.entries(registry.members)
            .map(([type, cls]) => ({ type, detail: cls }))
            .sort((left, right) => left.type.localeCompare(right.type));
        return { choices };
    }

    const cls = registry.members[args.type];
    if (!cls) return { failure: 'unknownType' };
    const target = insertTarget(document, args.offset);
    if (!target) return { failure: 'noOwner' };
    if (declares(target.container, args.name)) return { failure: 'alreadyDeclared' };

    const offset = appendOffsetIn(target.container);
    if (offset === undefined) return { failure: 'stale' };
    const lineEnding = lineEndingOf(text);
    // One level deeper in whatever the file itself indents with, so a space-indented mod stays one.
    const step = indentUnitOf(text);
    const memberIndent = memberIndentAt(text, offset);
    const indent = target.isComponents ? memberIndent : `${memberIndent}${step}`;
    const declaration = declarationSnippet(args.name, args.type, cls, indent, step, lineEnding);
    // A file that declares no components group gets one written with the declaration, which is the
    // shape a part inheriting its components needs: the game merges the group into the inherited one.
    const snippet = target.isComponents
        ? `${lineEnding}${memberIndent}${declaration}`
        : [
              '',
              `${memberIndent}${COMPONENTS}`,
              `${memberIndent}{`,
              `${memberIndent}${step}${declaration}`,
              `${memberIndent}}`,
          ].join(lineEnding);
    const position = textDocument.positionAt(offset);
    const insert = {
        uri: args.uri,
        range: { start: position, end: position },
        snippet,
        text: plainTextOf(snippet),
    };
    // A client that cannot place a tab stop asks the server to write the plain form, so both
    // clients share one implementation of where the declaration goes and what it carries.
    if (args.apply) {
        const applied = await host
            .applyEdit({ [args.uri]: [{ range: insert.range, newText: insert.text }] })
            .catch(() => false);
        return { insert, applied };
    }
    return { insert };
};
