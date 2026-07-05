import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { parseModActions } from '../../src/mod/action-parser';
import {
    AutoCompletionModRules,
    buildActionSnippet,
    fieldCompletionsForGroup,
    findActionGroupAtOffset,
    modRulesOffsetCompletions,
    verbSnippetSuggestions,
} from '../../src/features/completion/autocompletion.mod-rules';
import { Completion } from '../../src/features/completion/autocompletion.service';
import { ValueNode } from '../../src/core/ast/ast';
import { globalSettings } from '../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../workspace-helper';

const token = CancellationToken.None;
const completer = new AutoCompletionModRules();

/** The labels of a completion list (strings pass through, suggestion objects yield their label). */
const labels = (completions: Completion[]): string[] =>
    completions.map((completion) => (typeof completion === 'string' ? completion : completion.label));

/** Parse a single-action mod.rules and return its (verb node, first target node). */
const parseOne = (verb: string, body: string, uri = 'file:///mod.rules') => {
    const src = `Actions\n[\n\t{\n\t\tAction = ${verb}\n${body}\n\t}\n]\n`;
    return parseModActions(parser(lexer(src), uri).value)[0];
};

beforeAll(async () => {
    await initWorkspace();
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
});

describe('AutoCompletionModRules', () => {
    it('completes the action verb after `Action = `', async () => {
        const action = parseOne('Re', '\t\tReplace = "x"');
        const result = await completer.getCompletions(action.verbNode!, token);
        expect(labels(result).sort()).toEqual(['Remove', 'RemoveMany', 'Replace'].sort());
    });

    it('offers all verbs for an empty/short verb prefix', async () => {
        const action = parseOne('A', '\t\tAddTo = "x"');
        const result = await completer.getCompletions(action.verbNode!, token);
        expect(labels(result).sort()).toEqual(['Add', 'AddMany', 'AddBase'].sort());
    });

    it('suggests how to start a target path when none is typed yet', async () => {
        const action = parseOne('Overrides', '\t\tOverrideIn = "x"');
        const result = await completer.getCompletions(action.targets[0], token);
        expect(result).toEqual(['<./Data/', '<']);
    });

    it('completes a target path into the game tree (members of A)', async () => {
        const action = parseOne('Overrides', '\t\tOverrideIn = "<a.rules>/A/"');
        const result = await completer.getCompletions(action.targets[0], token);
        expect(result.sort()).toEqual(['Direct', 'RefToB', 'ToB', 'ToC', 'ToNested'].sort());
    });

    it('lists the Data directory for a `<./Data/` target prefix', async () => {
        const action = parseOne('Overrides', '\t\tOverrideIn = "<./Data/"');
        const result = await completer.getCompletions(action.targets[0], token);
        expect(result).toContain('a.rules>');
        expect(result).toContain('ships/');
    });

    it('returns nothing for a node in a non-mod document', async () => {
        const action = parseOne('Re', '\t\tReplace = "x"', 'file:///ships/part.rules');
        const result = await completer.getCompletions(action.verbNode!, token);
        expect(result).toEqual([]);
    });

    it('offers the remaining field names at an empty insertion point inside an action', () => {
        // `\t\t` on its own line = a blank insertion point inside the Replace action.
        const src = 'Actions\n[\n\t{\n\t\tAction = Replace\n\t\tReplace = "<a.rules>"\n\t\t\n\t}\n]\n';
        const doc = parser(lexer(src), 'file:///mod.rules').value;
        const offset = src.indexOf('"\n\t\t\n') + 3; // a byte offset on the blank line
        const actionGroup = findActionGroupAtOffset(doc, offset);
        expect(actionGroup).toBeDefined();
        // Replace fields minus the present Action/Replace.
        expect(fieldCompletionsForGroup(actionGroup).sort()).toEqual(['IgnoreIfNotExisting', 'With'].sort());
    });

    it('does not find an action group for an offset outside any action entry', () => {
        const src = 'Actions\n[\n\t{\n\t\tAction = Replace\n\t}\n]\n';
        const doc = parser(lexer(src), 'file:///mod.rules').value;
        expect(findActionGroupAtOffset(doc, 0)).toBeUndefined();
    });

    it('does not complete a verb for a non-target, non-Action field', async () => {
        // `With` is a source field — no path/verb completion offered (the reference completer
        // handles `&` sources; this completer stays out of the way).
        const src = 'Actions\n[\n\t{\n\t\tAction = Replace\n\t\tReplace = "<a.rules>"\n\t\tWith = somevalue\n\t}\n]\n';
        const action = parseModActions(parser(lexer(src), 'file:///mod.rules').value)[0];
        const withNode = action.sources[0] as ValueNode;
        expect(await completer.getCompletions(withNode, token)).toEqual([]);
    });

    /** The value node of assignment `field` inside an action entry. */
    const flagValueNode = (verb: string, field: string, partial: string): ValueNode => {
        const src = `Actions\n[\n\t{\n\t\tAction = ${verb}\n\t\t${field} = ${partial}\n\t}\n]\n`;
        const group = parseModActions(parser(lexer(src), 'file:///mod.rules').value)[0].group;
        const assignment = group.elements.find(
            (e): e is typeof e & { right: ValueNode } =>
                e.type === 'Assignment' && (e as never as { left: { name: string } }).left.name === field
        )!;
        return assignment.right;
    };

    it('completes true/false for a boolean flag field value', async () => {
        const result = await completer.getCompletions(flagValueNode('Replace', 'IgnoreIfNotExisting', 't'), token);
        expect(labels(result)).toEqual(['true']);
    });

    it('completes false from an `f` flag prefix', async () => {
        const result = await completer.getCompletions(flagValueNode('Add', 'CreateIfNotExisting', 'f'), token);
        expect(labels(result)).toEqual(['false']);
    });

    it('builds a full action-block snippet from the verb schema', () => {
        expect(buildActionSnippet('Add')).toBe('{\n\tAction = Add\n\tAddTo = "$1"\n\tToAdd = $2\n}');
        expect(buildActionSnippet('Overrides')).toBe(
            '{\n\tAction = Overrides\n\tOverrideIn = "$1"\n\tOverrides\n\t{\n\t\t$2\n\t}\n}'
        );
        expect(buildActionSnippet('AddMany')).toBe(
            '{\n\tAction = AddMany\n\tAddTo = "$1"\n\tManyToAdd\n\t[\n\t\t$2\n\t]\n}'
        );
        expect(buildActionSnippet('Remove')).toBe('{\n\tAction = Remove\n\tRemove = "$1"\n}');
        expect(buildActionSnippet('RemoveMany')).toBe('{\n\tAction = RemoveMany\n\tRemoveMany\n\t[\n\t\t"$1"\n\t]\n}');
    });

    it('offers a full-action snippet per verb at the Actions list level', () => {
        const src = 'Actions\n[\n\t\n]\n';
        const doc = parser(lexer(src), 'file:///mod.rules').value;
        const offset = src.indexOf('[\n\t\n') + 3; // the blank line directly inside the Actions list
        const result = modRulesOffsetCompletions(doc, offset);
        expect(labels(result).sort()).toEqual([...ACTION_VERBS_FOR_TEST].sort());
        expect(result.every((c) => typeof c !== 'string' && c.isSnippet)).toBe(true);
    });

    it('offers field names (not snippets) at an empty insertion point inside an entry', () => {
        const src = 'Actions\n[\n\t{\n\t\tAction = Replace\n\t\tReplace = "<a.rules>"\n\t\t\n\t}\n]\n';
        const doc = parser(lexer(src), 'file:///mod.rules').value;
        const offset = src.indexOf('"\n\t\t\n') + 3;
        const result = modRulesOffsetCompletions(doc, offset);
        expect(labels(result).sort()).toEqual(['IgnoreIfNotExisting', 'With'].sort());
        expect(result.some((c) => typeof c !== 'string' && c.isSnippet)).toBe(false);
    });

    it('verbSnippetSuggestions are all snippet-kind with insert text', () => {
        const suggestions = verbSnippetSuggestions();
        expect(suggestions).toHaveLength(7);
        expect(suggestions.every((s) => s.isSnippet && !!s.insertText && s.kind === 15 /* Snippet */)).toBe(true);
    });
});

const ACTION_VERBS_FOR_TEST = ['Add', 'AddMany', 'Overrides', 'Replace', 'Remove', 'RemoveMany', 'AddBase'];
