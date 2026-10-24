import { CancellationToken, CompletionItem, CompletionItemKind, MarkupKind } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNodeDocument, descendants, isValueNode, ValueNode } from '../../core/ast/ast';
import { scriptingSurface } from '../../document/schema/schema';
import { ScriptMember } from '../../document/schema/schema.types';
import { compileScript, membersOf, SCRIPT_KEYWORDS, ScriptMemberAccess, scriptTypeName } from './script-compiler';
import { CompiledScript, compileScriptAt } from './script-field';

/** The script under a document offset, with the cursor's index into it. */
const scriptAt = async (
    document: AbstractNodeDocument,
    text: TextDocument,
    offset: number,
    token: CancellationToken
): Promise<{ script: CompiledScript; index: number } | undefined> => {
    // Found by offset, since a value continued over several lines carries only its last line.
    let node: ValueNode | undefined;
    for (const candidate of descendants(document)) {
        if (isValueNode(candidate) && candidate.position.start <= offset && offset <= candidate.position.end)
            node = candidate;
    }
    if (!node) return undefined;
    const script = await compileScriptAt(node, text.getText(), token);
    const index = script?.fromDocument(offset);
    return script && index !== undefined ? { script, index } : undefined;
};

/** A member's signature as the script writes it: `name(param: Type, …): Type` or `name: Type`. */
const signatureOf = (member: ScriptMember, owner?: string): string => {
    const surface = scriptingSurface();
    const name = owner ? `${scriptTypeName(surface, owner)}.${member.name}` : member.name;
    if (!member.params) return `${name}: ${scriptTypeName(surface, member.type ?? '')}`;
    const params = member.params.map(
        (param) => `${param.name}${param.optional ? '?' : ''}: ${scriptTypeName(surface, param.type)}`
    );
    return `${name}(${params.join(', ')}): ${scriptTypeName(surface, member.returns ?? '')}`;
};

/**
 * Hover over a name inside a rules script: its signature, with every overload of a method, and the
 * game's own doc comment.
 *
 * @param document the parsed document.
 * @param text the open document.
 * @param offset the hovered document offset.
 * @param token cancels the field lookup.
 * @returns the markdown, or undefined when the offset is on no bound name.
 */
export const scriptHoverAt = async (
    document: AbstractNodeDocument,
    text: TextDocument,
    offset: number,
    token: CancellationToken
): Promise<string | undefined> => {
    const at = await scriptAt(document, text, offset, token);
    if (!at) return undefined;
    const binding = at.script.result.bindings.find((b) => b.start <= at.index && at.index < b.end);
    if (!binding) return undefined;
    const code = binding.members.map((member) => signatureOf(member, binding.owner)).join('\n');
    const doc = binding.members.find((member) => member.doc)?.doc;
    return [`\`\`\`python\n${code}\n\`\`\``, doc].filter(Boolean).join('\n\n');
};

/**
 * The member access at a name, read from the chain of calls and properties left of its dot alone.
 * The whole script stops at its first error, so a mistake earlier in it would otherwise leave every
 * later dot without members to offer.
 *
 * @param script the compiled script.
 * @param nameStart the index the name after the dot starts at.
 * @returns the access, or undefined when the chain does not bind.
 */
const chainAccess = (script: CompiledScript, nameStart: number): ScriptMemberAccess | undefined => {
    const { tokens } = script.result;
    const dot = tokens.findLastIndex((t) => t.end <= nameStart);
    if (dot < 0 || tokens[dot].kind !== 'symbol' || tokens[dot].text !== '.') return undefined;
    // Walk back over `name`, `name(…)` and `.`, the shapes a postfix chain is made of.
    let begin = dot;
    for (;;) {
        let j = begin - 1;
        if (tokens[j]?.text === ')') {
            for (let depth = 0; j >= 0; j--) {
                if (tokens[j].text === ')') depth++;
                else if (tokens[j].text === '(' && --depth === 0) break;
            }
            j--;
        }
        if (tokens[j]?.kind !== 'name') return undefined;
        begin = j;
        if (tokens[j - 1]?.text !== '.') break;
        begin = j - 1;
    }
    const chain = script.script.slice(tokens[begin].start, nameStart);
    const result = compileScript(chain, scriptingSurface(), script.type.context, 'System.Void');
    const shift = tokens[begin].start;
    const found = result.accesses.find((a) => a.nameStart + shift === nameStart);
    return found && { nameStart, target: found.target };
};

const memberItem = (member: ScriptMember, kind: CompletionItemKind, owner?: string): CompletionItem => ({
    label: member.name,
    kind,
    detail: signatureOf(member, owner),
    documentation: member.doc ? { kind: MarkupKind.Markdown, value: member.doc } : undefined,
});

/**
 * Completion inside a rules script: the members of whatever stands left of a `.`, and otherwise the
 * context's variables and functions and the keywords. Nothing is offered inside a string literal.
 *
 * @param document the parsed document.
 * @param text the open document.
 * @param offset the cursor's document offset.
 * @param token cancels the field lookup.
 * @returns the items, or undefined when the cursor is not in a script.
 */
export const scriptCompletionsAt = async (
    document: AbstractNodeDocument,
    text: TextDocument,
    offset: number,
    token: CancellationToken
): Promise<CompletionItem[] | undefined> => {
    const at = await scriptAt(document, text, offset, token);
    if (!at) return undefined;
    const { script, index } = at;
    const { tokens, accesses } = script.result;
    if (tokens.some((t) => t.kind === 'string' && t.start < index && index < t.end)) return [];
    const surface = scriptingSurface();
    // The script text is not kept, so the word is read off the tokens: the name the cursor ends.
    const word = tokens.find((t) => (t.kind === 'name' || t.kind === 'keyword') && t.start < index && index <= t.end);
    const start = word?.start ?? index;
    const range = script.toDocument(start, index);
    const edit = (item: CompletionItem): CompletionItem => ({
        ...item,
        textEdit: {
            range: { start: text.positionAt(range.start), end: text.positionAt(range.end) },
            newText: item.label,
        },
    });
    const access = accesses.find((a) => a.nameStart === start) ?? chainAccess(script, start);
    if (access) {
        const { properties, methods } = membersOf(surface, access.target);
        return [
            ...properties.map((m) => memberItem(m, CompletionItemKind.Property, access.target)),
            ...methods.map((m) => memberItem(m, CompletionItemKind.Method, access.target)),
        ].map(edit);
    }
    // A `.` with nothing bound before it (an unknown name, a mod's own context) has no members to offer.
    const before = tokens.filter((t) => t.end <= start).pop();
    if (before?.kind === 'symbol' && before.text === '.') return [];
    const variables = surface?.contexts[script.type.context]?.variables ?? [];
    return [
        ...variables.map((v) =>
            memberItem(v, v.kind === 'function' ? CompletionItemKind.Function : CompletionItemKind.Variable)
        ),
        ...SCRIPT_KEYWORDS.map((keyword) => ({ label: keyword, kind: CompletionItemKind.Keyword })),
    ].map(edit);
};
