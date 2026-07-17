import { CompletionItemKind, Position } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isGroupNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { fieldOf } from '../../document/schema/schema';
import { memberScopeClassAt, resolveGroupClass } from '../../document/schema/schema-context';
import { Completion } from '../completion/autocompletion.service';
import { stringValueNodesOf, valueTextRange } from './schema-reference.navigation';

/**
 * Particle data channels: the local symbol system inside a particle effect file.
 *
 * A particle updater/renderer reads and writes named data "channels" (the engine's `ParticleDataID`):
 * `SetRandom { DataOut = rot_vel }` declares the channel `rot_vel`, and `Operator { BIn = rot_vel }`
 * uses it. The fields are detected by their schema value type: every channel field is typed
 * `ParticleDataID` (emitted as an `opaque` kind by the extractor), so no field-name guessing is
 * needed. The read/write direction is encoded in the field-name suffix: `…Out` writes (declares),
 * `…In` reads (uses), `…InOut` does both.
 *
 * Channels are scoped to the whole file: a channel written in `EmitterDef`'s pre-initializers
 * (`base_scale`, `base_color`) is read by `Def`'s updaters, so navigation/rename span the document.
 * Engine built-ins (`location`, `velocity`, `life`, …) are read without an in-file writer. They still
 * appear as uses, so completion offers them and go-to-definition simply finds no writer.
 */
const PARTICLE_DATA_ID = 'ParticleDataID';

type ChannelDirection = 'in' | 'out' | 'inout';

export interface ChannelOccurrence {
    /** The channel name written in the field value. */
    readonly name: string;
    /** Whether this occurrence writes (`out`/`inout`) or reads (`in`/`inout`) the channel. */
    readonly direction: ChannelDirection;
    /** The value node carrying the channel name. */
    readonly node: ValueNode;
}

/** The read/write direction a `ParticleDataID` field name implies (suffix `InOut` checked before `Out`). */
const directionOf = (fieldName: string): ChannelDirection =>
    fieldName.endsWith('InOut') ? 'inout' : fieldName.endsWith('Out') ? 'out' : 'in';

/** The field name a value node fills, found via the sibling assignment whose right-hand side it is. */
const fieldNameOfValue = (group: AbstractNode, node: ValueNode): string | undefined => {
    if (!isGroupNode(group)) return undefined;
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.right === node) return element.left.name;
    }
    return undefined;
};

/**
 * Recognises a value node as a particle data channel occurrence.
 *
 * @param node the candidate value node (a bare/quoted string).
 * @returns the channel occurrence (name, direction, node) when the node fills a `ParticleDataID`
 * field with a non-empty value, otherwise undefined.
 */
export const particleChannelOf = (node: AbstractNode | null | undefined): ChannelOccurrence | undefined => {
    if (!node || !isValueNode(node) || node.valueType.type !== 'String') return undefined;
    const group = node.parent;
    if (!group || !isGroupNode(group)) return undefined;
    const fieldName = fieldNameOfValue(group, node);
    if (!fieldName) return undefined;
    const cls = resolveGroupClass(group);
    const valueType = cls ? fieldOf(cls, fieldName)?.valueType : undefined;
    if (valueType?.kind !== 'opaque' || valueType.type !== PARTICLE_DATA_ID) return undefined;
    const name = String(node.valueType.value);
    return name.trim() === '' ? undefined : { name, direction: directionOf(fieldName), node };
};

/** Every particle data channel occurrence in a document. */
export function* particleChannelsOf(document: AbstractNodeDocument): Generator<ChannelOccurrence> {
    for (const value of stringValueNodesOf(document)) {
        const channel = particleChannelOf(value);
        if (channel) yield channel;
    }
}

/** True when `position` falls within a single-line value node's text range. */
const positionInValue = (node: ValueNode, position: Position): boolean => {
    const { line, characterStart, characterEnd } = node.position;
    return position.line === line && position.character >= characterStart && position.character <= characterEnd;
};

/** The channel occurrence under the cursor, if the cursor sits on a `ParticleDataID` value. */
export const particleChannelAt = (
    document: AbstractNodeDocument,
    position: Position
): ChannelOccurrence | undefined => {
    for (const channel of particleChannelsOf(document)) {
        if (positionInValue(channel.node, position)) return channel;
    }
    return undefined;
};

/** Every occurrence of a named channel in the document (uses and declarations alike). */
export const channelOccurrences = (document: AbstractNodeDocument, name: string): ChannelOccurrence[] =>
    [...particleChannelsOf(document)].filter((channel) => channel.name === name);

/**
 * The declaration site of a channel for go-to-definition: the first occurrence that writes it
 * (`…Out`/`…InOut`). Returns undefined for an engine built-in that no field in the file writes.
 */
export const channelDefinitionSite = (
    document: AbstractNodeDocument,
    name: string
): ChannelOccurrence | undefined =>
    [...particleChannelsOf(document)].find(
        (channel) => channel.name === name && (channel.direction === 'out' || channel.direction === 'inout')
    );

/** The document range covering a channel occurrence's value text (for find-references / rename). */
export const channelRangeOf = (channel: ChannelOccurrence) => valueTextRange(channel.node);

/** Matches a `Field = <partial>` value position on a line prefix, capturing the field name. */
const CHANNEL_VALUE_POSITION = /(?:^|[\s{;[])([A-Za-z_]\w*)\s*=\s*[A-Za-z0-9_.]*$/;

/**
 * Channel-name completions when the cursor sits at a `ParticleDataID` field's value position, so
 * `AIn = ` offers every channel the file already mentions.
 *
 * @param document the parsed particle document.
 * @param offset the cursor byte offset (used to find the enclosing group).
 * @param linePrefix the text from the line start up to the cursor.
 * @returns the channel completions, or undefined when the cursor is not at a `ParticleDataID` value
 * position (so the caller falls through to other completion sources).
 */
export const particleChannelCompletionsAtOffset = (
    document: AbstractNodeDocument,
    offset: number,
    linePrefix: string
): Completion[] | undefined => {
    const match = CHANNEL_VALUE_POSITION.exec(linePrefix);
    if (!match) return undefined;
    // Scope-aware class lookup: inside `Offset [Scale2In = <cursor>]` the scope is the list slot's
    // Vector2 (which has no channel fields), not the outer renderer, so no channels are offered
    // for a binding the game never reads.
    const cls = memberScopeClassAt(document, offset);
    const valueType = cls ? fieldOf(cls, match[1])?.valueType : undefined;
    if (valueType?.kind !== 'opaque' || valueType.type !== PARTICLE_DATA_ID) return undefined;

    const names = new Set<string>();
    for (const channel of particleChannelsOf(document)) names.add(channel.name);
    return [...names].map((name) => ({
        label: name,
        kind: CompletionItemKind.Variable,
        detail: '→ particle data',
    }));
};
