import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { readFileSync } from 'fs';
import {
    AbstractNode,
    AbstractNodeDocument,
    AssignmentNode,
    GroupNode,
    ListNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../../src/core/ast/ast';
import { findNodeByIdentifier, parseFilePath } from '../../../src/utils/ast.utils';
import { resolveClassThroughInheritance, warmInheritedClasses } from '../../../src/features/completion/inheritance-resolution';
import { AutoCompletionSchema } from '../../../src/features/completion/autocompletion.schema';
import {
    crossFileReferenceTargetAtOffset,
    schemaFieldNameCompletions,
    schemaValueCompletionsAtOffset,
} from '../../../src/features/completion/autocompletion.schema-fields';
import { Completion } from '../../../src/features/completion/autocompletion.service';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';
import { HoverService } from '../../../src/features/hover/hover.service';
import { schemaReferenceFieldOf } from '../../../src/features/navigation/schema-id-reference.navigation';
import { resolveGroupClass } from '../../../src/document/schema/schema-context';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';

// A group whose class comes only through a base in another file (`NestedSound : /BASE_AUDIO/BaseAudio`)
// is classified by the async inheritance walk. The synchronous slot walk reads no other file, so
// before the walk seeded its answer everything written inside such a group had no class: a nested
// group, the elements of a list, a group element of a polymorphic list, a cross-file id. Field
// names, values, hover, the reference target and the validators were all silent there.
const token = CancellationToken.None;
const completer = new AutoCompletionSchema();
const labels = (completions: Completion[]): string[] => completions.map((c) => (typeof c === 'string' ? c : c.label));

/** The first value assigned to `field`, searching depth-first. */
const findValue = (node: AbstractNode, field: string): ValueNode | undefined => {
    if (isAssignmentNode(node) && node.left.name === field && isValueNode(node.right)) return node.right;
    for (const child of childrenOf(node)) {
        const found = findValue(child, field);
        if (found) return found;
    }
    return undefined;
};

/** The first list assigned to `field`, searching depth-first. */
const findList = (node: AbstractNode, field: string): ListNode | undefined => {
    if (isAssignmentNode(node) && node.left.name === field && isListNode(node.right)) return node.right;
    for (const child of childrenOf(node)) {
        const found = findList(child, field);
        if (found) return found;
    }
    return undefined;
};

const childrenOf = (node: AbstractNode): AbstractNode[] =>
    isGroupNode(node) || isListNode(node) ? node.elements : isAssignmentNode(node) && node.right ? [node.right] : [];

const memberGroup = (group: GroupNode, name: string): GroupNode =>
    group.elements.find((e) => isGroupNode(e) && e.identifier?.name === name) as GroupNode;

const assignment = (group: GroupNode, name: string): AssignmentNode =>
    group.elements.find((e) => isAssignmentNode(e) && e.left.name === name) as AssignmentNode;

describe('members of a group classified through a cross-file base', () => {
    let document: AbstractNodeDocument;
    let text: string;
    let nestedSound: GroupNode;
    let dynamicVolume: GroupNode;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        const path = workspaceFile('effects', 'inherits_descendants.rules');
        text = readFileSync(path, 'utf8');
        document = await parseFilePath(path);
        nestedSound = findNodeByIdentifier(document, 'NestedSound') as GroupNode;
        dynamicVolume = memberGroup(nestedSound, 'DynamicVolume');
    });

    it('seeds the synchronous resolution: a nested group reads its slot once the deriver is resolved', async () => {
        // The synchronous walk is asked first, so its memo of "no class" for the nested group is the
        // one the seed has to drop.
        expect(resolveGroupClass(dynamicVolume)).toBeUndefined();
        expect(await resolveClassThroughInheritance(nestedSound, token)).toBe(
            'Cosmoteer.Simulation.MediaEffects.AudioEffectRules'
        );
        expect(resolveGroupClass(nestedSound)).toBe('Cosmoteer.Simulation.MediaEffects.AudioEffectRules');
        expect(resolveGroupClass(dynamicVolume)).toBe('Cosmoteer.Simulation.MediaEffects.DynamicVolumeRules');
    });

    it('resolves a nested group through its ancestors when asked for it directly', async () => {
        const fresh = await parseFilePath(workspaceFile('effects', 'inherits_descendants.rules'));
        const nested = memberGroup(findNodeByIdentifier(fresh, 'NestedSound') as GroupNode, 'DynamicVolume');
        expect(await resolveClassThroughInheritance(nested, token)).toBe(
            'Cosmoteer.Simulation.MediaEffects.DynamicVolumeRules'
        );
    });

    it('offers bool values inside the nested group', async () => {
        const result = await completer.getCompletions(findValue(dynamicVolume, 'UseCustomShapeForDistance')!, token);
        expect(labels(result)).toEqual(['true', 'false']);
    });

    it('offers bool values at an empty `Key = ` position inside the nested group', async () => {
        const offset = text.indexOf('= x') + 2;
        const result = await schemaValueCompletionsAtOffset(document, offset, '\t\tUseCustomShapeForDistance = ', token);
        expect(labels(result ?? [])).toEqual(['true', 'false']);
    });

    it('offers the field names of the nested group', async () => {
        const result = await schemaFieldNameCompletions(document, text.indexOf('MaxDistance'), token);
        expect(labels(result)).toContain('MinDistance');
    });

    it('describes a field of the nested group on hover', async () => {
        const left = assignment(dynamicVolume, 'MaxDistance').left;
        const hover = await HoverService.instance.getHover(
            document,
            { line: left.position.line, character: left.position.characterStart + 1 },
            token
        );
        const value = hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
        expect(value).toContain('**MaxDistance**');
        expect(value).toContain('float');
    });

    it('offers the enum members of a list element', async () => {
        const targets = findNodeByIdentifier(document, 'Targets') as GroupNode;
        const element = findList(targets, 'TargetTypesByPriority')!.elements[0] as ValueNode;
        expect(labels(await completer.getCompletions(element, token))).toContain('ShipParts');
    });

    it('offers the discriminators and the fields of a group element of a polymorphic list', async () => {
        const tracks = findNodeByIdentifier(document, 'Tracks') as GroupNode;
        const element = findList(tracks, 'Tracks')!.elements[0] as GroupNode;
        expect(labels(await completer.getCompletions(findValue(element, 'Type')!, token))).toContain('Sequence');
        const fields = await schemaFieldNameCompletions(document, text.indexOf('Volume = 1'), token);
        expect(labels(fields)).toContain('Layers');
    });

    it('types a cross-file id reference on both the offset and the value paths', () => {
        const mission = findNodeByIdentifier(document, 'Mission') as GroupNode;
        const offset = text.indexOf('SpecificFaction = x') + 'SpecificFaction = '.length;
        expect(crossFileReferenceTargetAtOffset(document, offset, '\tSpecificFaction = ')).toBe(
            'Cosmoteer.Factions.FactionRules'
        );
        expect(schemaReferenceFieldOf(findValue(mission, 'SpecificFaction')!)?.targetClass).toBe(
            'Cosmoteer.Factions.FactionRules'
        );
    });

    it('validates the deriver and its nested group once the document is warmed', async () => {
        const fresh = await parseFilePath(workspaceFile('effects', 'inherits_descendants.rules'));
        await warmInheritedClasses(fresh, token);
        const messages = (await validateSchema(fresh, token)).map((error) => error.message);
        expect(messages.some((m) => m.includes("'Foo' is not a valid ConcurrencyMode"))).toBe(true);
        expect(messages.some((m) => m.includes("'x' is not a valid boolean"))).toBe(true);
    });
});
