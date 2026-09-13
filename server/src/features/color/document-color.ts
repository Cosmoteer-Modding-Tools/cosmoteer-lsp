import { CancellationToken, Color, ColorInformation, ColorPresentation, Range, TextEdit } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    AssignmentNode,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ListNode,
    ValueNode,
} from '../../core/ast/ast';
import { childNodesOf } from '../../utils/ast.utils';
import { listSlotType, memberTypeIn, resolveGroupClass } from '../../document/schema/schema-context';
import { acceptsShaderConstants } from '../../document/schema/schema';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { resolveAssetPath } from '../navigation/asset-resolver';
import { shaderConstants } from '../shader/shader-index';
import { materialConstants, materialShaderNode } from '../shader/shader-reference';
import { shaderVariantSiblings } from '../diagnostics/validator.shader-constants';
import { NAMED_COLORS, namedColorOf } from '../text-markup/text-markup';

/**
 * Document colour swatches for `.rules` colour values, read the way `Color.ReadContentFrom` and
 * `IntColor.ReadContentFrom` read them.
 *
 * A colour reaches the engine in four shapes. A single value is a name out of `Color.NamedColors`
 * (hex is not a colour in a rules file, only in text markup). A list of three or four numbers is
 * `[r, g, b, a]` with every channel over 255. A group carrying `H`, `S` and `V` is a hue in degrees
 * with saturation and value. Any other group resolves each channel on its own, the byte `R` winning
 * over the float `Rf`, and the alpha `A` over `Af` and over an opaque default. Nothing the engine
 * reads is clamped, so a channel may sit above 1 on purpose: vanilla writes `Af = 1.9607843` and
 * `[500, 0, 0]` to drive additive effects past white.
 *
 * Each colour is surfaced as an LSP {@link ColorInformation} whose channels are clamped for the
 * editor to render, plus a picker edit that rewrites the written component values in place and
 * leaves the identifier, braces, brackets and layout untouched. A channel the picker hands back
 * unchanged keeps the bytes it was written with, so using the picker never quietly flattens an
 * overbright channel or reformats a number.
 *
 * Group detection is structural, a group carrying the `Rf`/`Gf`/`Bf` (or `R`/`G`/`B`) trio, which is
 * cheap and unambiguous. List and single-value detection is schema-typed: the slot has to be declared
 * as a `Color` or an `IntColor`, so an arbitrary `[x, y, w, h]` rect never gets a swatch. A shader
 * colour constant is typed by the shader it is written for instead, since the schema knows no `_`-key.
 */

/** The classes whose list and single-value forms encode a colour. */
const COLOR_CLASSES: ReadonlySet<string> = new Set(['Halfling.Graphics.Color', 'Halfling.Graphics.IntColor']);

/** The float component names, in channel order, and the byte ones, whichever a group carries. */
const FLOAT_COMPONENTS = ['Rf', 'Gf', 'Bf', 'Af'] as const;
const BYTE_COMPONENTS = ['R', 'G', 'B', 'A'] as const;

/** The hue, saturation and value component names, which the engine tries before any channel name. */
const HSV_COMPONENTS = ['H', 'S', 'V'] as const;

/** Every name a colour group may carry, which is what keeps a numeric `{ H S V }` lookalike out. */
const COLOR_COMPONENTS: ReadonlySet<string> = new Set([...FLOAT_COMPONENTS, ...BYTE_COMPONENTS, ...HSV_COMPONENTS]);

/**
 * How far a picked channel may sit from the one handed to the picker and still count as untouched.
 * Half a byte step, because a picker that quantises its channels to 8 bits hands back the value it
 * was given rounded, and a change smaller than that is one no picker can express.
 */
const CHANNEL_EPSILON = 0.5 / 255;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** A colour whose channels are the engine's, unclamped, so an overbright channel survives the read. */
interface RawColor {
    readonly red: number;
    readonly green: number;
    readonly blue: number;
    readonly alpha: number;
}

/** One written colour channel: its value node, the name it was written under, and its scale. */
interface WrittenChannel {
    readonly node: ValueNode;
    readonly name: string;
    /** What the written number is divided by to reach 0 to 1: 255 for a byte channel, 1 for a float. */
    readonly scale: number;
}

/**
 * The colour the engine builds from a hue in degrees, a saturation and a value, a port of
 * `Color.FromHSVA`.
 *
 * @param hue the hue in degrees.
 * @param saturation the saturation.
 * @param value the value.
 * @param alpha the alpha to carry through.
 * @returns the colour, unclamped.
 */
const fromHsva = (hue: number, saturation: number, value: number, alpha: number): RawColor => {
    const chroma = saturation * value;
    const sextant = hue / 60;
    const second = chroma * (1 - Math.abs((sextant % 2) - 1));
    let red = 0;
    let green = 0;
    let blue = 0;
    if (sextant < 1) [red, green, blue] = [chroma, second, 0];
    else if (sextant < 2) [red, green, blue] = [second, chroma, 0];
    else if (sextant < 3) [red, green, blue] = [0, chroma, second];
    else if (sextant < 4) [red, green, blue] = [0, second, chroma];
    else if (sextant < 5) [red, green, blue] = [second, 0, chroma];
    else if (sextant <= 6) [red, green, blue] = [chroma, 0, second];
    const rest = value - chroma;
    return { red: red + rest, green: green + rest, blue: blue + rest, alpha };
};

/**
 * The hue in degrees, saturation and value of a colour, a port of `Color.ToHSV`.
 *
 * @param color the colour to decompose.
 * @returns the hue in degrees, the saturation and the value.
 */
const toHsv = (color: Color): { hue: number; saturation: number; value: number } => {
    const low = Math.min(color.red, color.green, color.blue);
    const high = Math.max(color.red, color.green, color.blue);
    const span = high - low;
    if (span === 0) return { hue: 0, saturation: 0, value: high };
    let hue: number;
    if (color.red === high) {
        hue = (color.green - color.blue) / span;
        if (hue < 0) hue += 6;
    } else if (color.green === high) {
        hue = (color.blue - color.red) / span + 2;
    } else {
        hue = (color.red - color.green) / span + 4;
    }
    return { hue: hue * 60, saturation: span / high, value: high };
};

/** A colour group's numeric component assignments, keyed by field name, with each value's node. */
const componentNodes = (group: GroupNode): Map<string, ValueNode> => {
    const components = new Map<string, ValueNode>();
    for (const element of group.elements) {
        if (
            isAssignmentNode(element) &&
            isValueNode(element.right) &&
            typeof element.right.valueType.value === 'number'
        ) {
            components.set(element.left.name, element.right);
        }
    }
    return components;
};

/** A colour group as the engine reads it: the three channels it carries, plus an alpha when written. */
interface GroupColor {
    readonly group: GroupNode;
    /** Whether the trio is a hue/saturation/value one or a red/green/blue one. */
    readonly form: 'hsv' | 'rgb';
    readonly trio: readonly [WrittenChannel, WrittenChannel, WrittenChannel];
    readonly alpha?: WrittenChannel;
}

/**
 * The alpha channel a group writes, the byte `A` winning over the float `Af`, as the engine reads it.
 *
 * @param components the group's numeric components.
 * @returns the alpha channel, or undefined when the group writes none.
 */
const alphaChannel = (components: Map<string, ValueNode>): WrittenChannel | undefined => {
    const byte = components.get('A');
    if (byte) return { node: byte, name: 'A', scale: 255 };
    const float = components.get('Af');
    return float ? { node: float, name: 'Af', scale: 1 } : undefined;
};

/**
 * The colour a group encodes, resolved channel by channel with the engine's precedence, so a mixed
 * `{ R G B Af }` reads its alpha off `Af` and its channels off the byte names.
 *
 * @param group the group to read.
 * @returns the colour's channels, or undefined when the group is no colour.
 */
const groupColorOf = (group: GroupNode): GroupColor | undefined => {
    const components = componentNodes(group);
    const alpha = alphaChannel(components);
    // The engine tries hue/saturation/value first. A group that carries the trio and nothing but
    // colour names is one, and a numeric lookalike that writes anything else is left alone.
    const hue = components.get('H');
    const saturation = components.get('S');
    const value = components.get('V');
    if (hue && saturation && value) {
        const named = group.elements.every(
            (element) => !isAssignmentNode(element) || COLOR_COMPONENTS.has(element.left.name)
        );
        if (named) {
            const trio = [
                { node: hue, name: 'H', scale: 1 },
                { node: saturation, name: 'S', scale: 1 },
                { node: value, name: 'V', scale: 1 },
            ] as const;
            return { group, form: 'hsv', trio, alpha };
        }
    }
    const channel = (index: number): WrittenChannel | undefined => {
        const byte = components.get(BYTE_COMPONENTS[index]);
        if (byte) return { node: byte, name: BYTE_COMPONENTS[index], scale: 255 };
        const float = components.get(FLOAT_COMPONENTS[index]);
        return float ? { node: float, name: FLOAT_COMPONENTS[index], scale: 1 } : undefined;
    };
    const red = channel(0);
    const green = channel(1);
    const blue = channel(2);
    if (!red || !green || !blue) return undefined;
    return { group, form: 'rgb', trio: [red, green, blue], alpha };
};

/** The 0 to 1 value a written channel carries, unclamped. */
const valueOf = (channel: WrittenChannel): number => Number(channel.node.valueType.value) / channel.scale;

/** The colour a group encodes, in the engine's own unclamped channels. */
const rawColorOfGroup = (found: GroupColor): RawColor => {
    const alpha = found.alpha ? valueOf(found.alpha) : 1;
    const [first, second, third] = found.trio;
    if (found.form === 'hsv') return fromHsva(valueOf(first), valueOf(second), valueOf(third), alpha);
    return { red: valueOf(first), green: valueOf(second), blue: valueOf(third), alpha };
};

/** The colour the editor renders, which is the engine's colour with every channel brought into range. */
const renderable = (raw: RawColor): Color => ({
    red: clamp01(raw.red),
    green: clamp01(raw.green),
    blue: clamp01(raw.blue),
    alpha: clamp01(raw.alpha),
});

/** The node the swatch and the edit start at: a named container's identifier, else its opening bracket. */
const anchorPosition = (node: GroupNode | ListNode) => node.identifier?.position ?? node.position;

/**
 * The range a colour occupies: from the anchor (a named container's identifier, or an anonymous one's
 * opening bracket) through the last written component. This is both the swatch decoration range and
 * the colour-picker's edit range, and they have to be identical. VS Code's inline picker tracks the
 * region an applied edit covered and passes that back as the range of the next change, so a
 * decoration range that differed from the edit range would let only the first change land and every
 * later one would miss the lookup. Anchoring on the identifier keeps the swatch next to the field
 * name, and the range then extends over the component values the edit rewrites.
 *
 * @param anchor the position the colour is decorated from.
 * @param nodes the written component value nodes.
 * @returns the swatch and edit range.
 */
const spanRange = (anchor: { line: number; characterStart: number }, nodes: readonly ValueNode[]): Range => {
    const last = nodes.reduce((a, b) => (b.position.start > a.position.start ? b : a));
    return Range.create(anchor.line, anchor.characterStart, last.position.line, last.position.characterEnd);
};

/** The written component value nodes of a group colour, in the order the engine reads them. */
const groupNodes = (found: GroupColor): ValueNode[] =>
    [...found.trio, ...(found.alpha ? [found.alpha] : [])].map((channel) => channel.node);

/**
 * The channel value nodes of a positional colour list (`[255, 255, 255, 217]`): three or four plain
 * numeric elements. The engine reads exactly this shape, each channel divided by 255 with a missing
 * alpha opaque, so anything else is not surfaced, be it expressions, references or other element counts.
 *
 * @param list the list node to inspect.
 * @returns the channel value nodes in order, or undefined when the list is no colour shape.
 */
const listChannels = (list: ListNode): ValueNode[] | undefined => {
    if (list.elements.length < 3 || list.elements.length > 4 || list.inheritance?.length) return undefined;
    const channels = list.elements.filter(
        (e): e is ValueNode => isValueNode(e) && typeof e.valueType.value === 'number'
    );
    return channels.length === list.elements.length ? channels : undefined;
};

/** The colour a positional list encodes, in the engine's own unclamped channels. */
const rawColorOfList = (channels: readonly ValueNode[]): RawColor => {
    const at = (i: number, fallback: number) => Number(channels[i]?.valueType.value ?? fallback) / 255;
    return { red: at(0, 0), green: at(1, 0), blue: at(2, 0), alpha: at(3, 255) };
};

/** Round a channel to a compact literal: three decimals for a float, a whole number for a byte. */
const formatChannel = (value: number, scale: number): string =>
    scale === 255 ? String(Math.round(value * 255)) : String(Math.round(value * 1000) / 1000);

/** Whether the picker handed a channel back as it was given, which is what keeps its literal. */
const isUnchanged = (was: number, now: number): boolean => Math.abs(was - now) <= CHANNEL_EPSILON;

/** The bytes a value node was written with, which is what an untouched channel is written back as. */
const writtenText = (source: string, node: ValueNode): string => source.slice(node.position.start, node.position.end);

/** A component to rewrite: its value node and the new literal to put in its place. */
interface ChannelEdit {
    readonly node: ValueNode;
    readonly text: string;
}

/**
 * Rebuild the source span from `spanStart` through the last component value as a single string,
 * splicing each component's new value into place and keeping every byte in between (the identifier,
 * braces, field names, whitespace, newlines) verbatim. Producing one contiguous edit rather than one
 * edit per component is deliberate: VS Code's inline colour picker desyncs and stops applying further
 * changes once a `ColorPresentation` carries `additionalTextEdits` (microsoft/vscode#136965), so a
 * lone `textEdit` is the only shape that keeps the picker working across repeated changes.
 *
 * @param source the full document text the value node offsets index into.
 * @param spanStart the source offset the replacement starts at (the colour's anchor).
 * @param edits the components to rewrite, sorted by source offset.
 * @param tail text to add behind the last component, for an alpha the colour did not write yet.
 * @returns the replacement text for the span from `spanStart` through the last component value.
 */
const spliceChannels = (source: string, spanStart: number, edits: readonly ChannelEdit[], tail = ''): string => {
    let out = '';
    let cursor = spanStart;
    for (const { node, text } of [...edits].sort((a, b) => a.node.position.start - b.node.position.start)) {
        out += source.slice(cursor, node.position.start) + text;
        cursor = node.position.end;
    }
    return out + tail;
};

/** The line ending a document is written with, so appended text keeps the file's own shape. */
const lineEndingOf = (source: string): string => (source.includes('\r\n') ? '\r\n' : '\n');

/** The leading whitespace of the line a node sits on, so an appended component lines up with it. */
const indentOf = (source: string, node: ValueNode): string => {
    const lineStart = source.lastIndexOf('\n', node.position.start - 1) + 1;
    return /^[ \t]*/.exec(source.slice(lineStart, node.position.start))?.[0] ?? '';
};

/**
 * The text that adds an alpha component to a colour group that writes none, laid out the way the
 * group writes its other channels: behind the last one on a single-line group, on a line of its own
 * under a multi-line one.
 *
 * @param source the full document text.
 * @param found the group colour the alpha is added to.
 * @param alpha the picked alpha.
 * @returns the component name, its literal, and the text to add behind the group's last component.
 */
const appendedGroupAlpha = (
    source: string,
    found: GroupColor,
    alpha: number
): { name: string; literal: string; text: string } => {
    const last = found.trio.reduce((a, b) => (b.node.position.start > a.node.position.start ? b : a));
    // A byte trio takes a byte alpha, everything else the float one, so the added component reads
    // like the ones already there.
    const scale = last.scale === 255 && found.form === 'rgb' ? 255 : 1;
    const name = scale === 255 ? 'A' : 'Af';
    const literal = formatChannel(alpha, scale);
    const written = `${name} = ${literal}`;
    const inline = found.trio.some(
        (channel) => channel !== last && channel.node.position.line === last.node.position.line
    );
    return {
        name,
        literal,
        text: inline ? `; ${written}` : `${lineEndingOf(source)}${indentOf(source, last.node)}${written}`,
    };
};

/**
 * The text that adds a fourth entry to a three-entry colour list, separated the way the list
 * separates the entries it already has.
 *
 * @param source the full document text.
 * @param channels the list's written entries.
 * @param alpha the picked alpha.
 * @returns the text to add behind the last entry.
 */
const appendedListAlpha = (source: string, channels: readonly ValueNode[], alpha: number): string => {
    const between = source.slice(channels[1].position.end, channels[2].position.start);
    const separator = between.trim() === ',' || between.trim() === ';' ? between : ', ';
    return `${separator}${formatChannel(alpha, 255)}`;
};

/** One colour in a document: where its swatch sits, what it reads as, and how a pick is written back. */
interface ColorSite {
    readonly range: Range;
    readonly color: Color;
    /** The presentation for a picked colour, given the document text the value nodes index into. */
    readonly write: (source: string, picked: Color) => ColorPresentation[];
}

/**
 * The colour site of a group, whose picker edit rewrites only the channels the pick actually moved.
 *
 * @param found the group colour.
 * @returns the site.
 */
const groupSite = (found: GroupColor): ColorSite => {
    const raw = rawColorOfGroup(found);
    const shown = renderable(raw);
    const nodes = groupNodes(found);
    const range = spanRange(anchorPosition(found.group), nodes);
    return {
        range,
        color: shown,
        write: (source, picked) => {
            const edits: ChannelEdit[] = [];
            const moved =
                !isUnchanged(shown.red, picked.red) ||
                !isUnchanged(shown.green, picked.green) ||
                !isUnchanged(shown.blue, picked.blue);
            if (found.form === 'hsv') {
                const { hue, saturation, value } = toHsv(picked);
                const written = [hue, saturation, value];
                found.trio.forEach((channel, i) =>
                    edits.push({
                        node: channel.node,
                        text: moved ? formatChannel(written[i], 1) : writtenText(source, channel.node),
                    })
                );
            } else {
                const written = [picked.red, picked.green, picked.blue];
                const shownChannels = [shown.red, shown.green, shown.blue];
                found.trio.forEach((channel, i) =>
                    edits.push({
                        node: channel.node,
                        text: isUnchanged(shownChannels[i], written[i])
                            ? writtenText(source, channel.node)
                            : formatChannel(written[i], channel.scale),
                    })
                );
            }
            const labels = found.trio.map((channel, i) => `${channel.name}=${edits[i].text}`);
            let tail = '';
            if (found.alpha) {
                const text = isUnchanged(shown.alpha, picked.alpha)
                    ? writtenText(source, found.alpha.node)
                    : formatChannel(picked.alpha, found.alpha.scale);
                edits.push({ node: found.alpha.node, text });
                labels.push(`${found.alpha.name}=${text}`);
            } else if (picked.alpha < 1) {
                const added = appendedGroupAlpha(source, found, picked.alpha);
                tail = added.text;
                labels.push(`${added.name}=${added.literal}`);
            }
            const spanStart = anchorPosition(found.group).start;
            return [
                {
                    label: labels.join(' '),
                    textEdit: TextEdit.replace(range, spliceChannels(source, spanStart, edits, tail)),
                },
            ];
        },
    };
};

/**
 * The colour site of a positional list, whose picker edit rewrites only the entries the pick moved
 * and adds a fourth entry when the pick is translucent.
 *
 * @param list the list node.
 * @param channels the list's written entries.
 * @returns the site.
 */
const listSite = (list: ListNode, channels: readonly ValueNode[]): ColorSite => {
    const shown = renderable(rawColorOfList(channels));
    const range = spanRange(anchorPosition(list), channels);
    return {
        range,
        color: shown,
        write: (source, picked) => {
            const written = [picked.red, picked.green, picked.blue, picked.alpha];
            const shownChannels = [shown.red, shown.green, shown.blue, shown.alpha];
            const edits: ChannelEdit[] = channels.map((node, i) => ({
                node,
                text: isUnchanged(shownChannels[i], written[i])
                    ? writtenText(source, node)
                    : formatChannel(written[i], 255),
            }));
            const adds = channels.length === 3 && picked.alpha < 1;
            const tail = adds ? appendedListAlpha(source, channels, picked.alpha) : '';
            const entries = edits.map((e) => e.text);
            if (adds) entries.push(formatChannel(picked.alpha, 255));
            const spanStart = anchorPosition(list).start;
            return [
                {
                    label: `[${entries.join(', ')}]`,
                    textEdit: TextEdit.replace(range, spliceChannels(source, spanStart, edits, tail)),
                },
            ];
        },
    };
};

/**
 * The colour site of a single named colour (`DefaultRoleColor = Red`), whose picker edit keeps the
 * name when the pick lands back on it and writes the channel list the same slot reads otherwise.
 *
 * @param assignment the assignment the name is written in.
 * @param node the name's value node.
 * @param channels the colour the name stands for.
 * @returns the site.
 */
const namedSite = (
    assignment: AssignmentNode,
    node: ValueNode,
    channels: readonly [number, number, number, number]
): ColorSite => {
    const shown: Color = { red: channels[0], green: channels[1], blue: channels[2], alpha: channels[3] };
    const anchor = assignment.left.position;
    const range = spanRange(anchor, [node]);
    return {
        range,
        color: shown,
        write: (source, picked) => {
            const same =
                isUnchanged(shown.red, picked.red) &&
                isUnchanged(shown.green, picked.green) &&
                isUnchanged(shown.blue, picked.blue) &&
                isUnchanged(shown.alpha, picked.alpha);
            const text = same ? writtenText(source, node) : (colorNameOf(picked) ?? byteListOf(picked));
            return [
                {
                    label: text,
                    textEdit: TextEdit.replace(range, source.slice(anchor.start, node.position.start) + text),
                },
            ];
        },
    };
};

/** The picked colour as the byte list the same slot reads, which is the form every colour can take. */
const byteListOf = (color: Color): string => {
    const channels = [color.red, color.green, color.blue].map((channel) => formatChannel(channel, 255));
    if (color.alpha < 1) channels.push(formatChannel(color.alpha, 255));
    return `[${channels.join(', ')}]`;
};

/**
 * The colour name a picked colour is exactly, so a slot written `Red` keeps its name form.
 *
 * @param color the picked colour.
 * @returns the name, or undefined when no named colour matches.
 */
const colorNameOf = (color: Color): string | undefined => {
    for (const [name, channels] of NAMED_COLORS) {
        if (
            isUnchanged(channels[0], color.red) &&
            isUnchanged(channels[1], color.green) &&
            isUnchanged(channels[2], color.blue) &&
            isUnchanged(channels[3], color.alpha)
        ) {
            return name;
        }
    }
    return undefined;
};

/** Every node of a document, in document order. */
function* everyNode(document: AbstractNodeDocument): Generator<AbstractNode> {
    const visit = function* (node: AbstractNode): Generator<AbstractNode> {
        yield node;
        for (const child of childNodesOf(node)) yield* visit(child);
    };
    for (const element of document.elements) yield* visit(element);
}

/** Whether a schema slot is declared as one of the colour classes. */
const isColorSlot = (slot: { kind: string; ref?: string } | undefined): boolean =>
    slot?.kind === 'group' && slot.ref !== undefined && COLOR_CLASSES.has(slot.ref);

/**
 * The colour sites the schema and the document structure alone account for: every colour group, every
 * three or four entry list in a declared colour slot, and every single value naming a colour.
 *
 * @param document the parsed document.
 * @returns the sites, and the list nodes already covered so the shader pass does not repeat them.
 */
const schemaColorSites = (document: AbstractNodeDocument): { sites: ColorSite[]; lists: Set<ListNode> } => {
    const sites: ColorSite[] = [];
    const lists = new Set<ListNode>();
    for (const node of everyNode(document)) {
        if (isGroupNode(node)) {
            const found = groupColorOf(node);
            if (found && node.position) sites.push(groupSite(found));
            continue;
        }
        if (isListNode(node)) {
            const channels = listChannels(node);
            if (channels && node.position && isColorSlot(listSlotType(node))) {
                lists.add(node);
                sites.push(listSite(node, channels));
            }
            continue;
        }
        if (isAssignmentNode(node) && isValueNode(node.right) && node.right.valueType.type === 'String') {
            const container = node.parent;
            if (!container || (!isGroupNode(container) && !isDocumentNode(container))) continue;
            const channels = namedColorOf(String(node.right.valueType.value));
            if (!channels) continue;
            if (isColorSlot(memberTypeIn(container, node.left.name))) sites.push(namedSite(node, node.right, channels));
        }
    }
    return { sites, lists };
};

/** Every material group of a document, which is where a shader constant may be written. */
function* materialGroupsOf(document: AbstractNodeDocument): Generator<GroupNode> {
    for (const node of everyNode(document)) {
        if (!isGroupNode(node)) continue;
        const cls = resolveGroupClass(node);
        if (cls && acceptsShaderConstants(cls)) yield node;
    }
}

/**
 * The colour sites of the shader constants a document's materials set in list form. The schema knows
 * no `_`-key, so the shader itself types them: a `float4` whose default is `255` is a colour to the
 * engine, and a `float4` defaulting to anything else stays a plain vector with no swatch.
 *
 * @param document the parsed document.
 * @param covered the list nodes the schema pass already gave a swatch.
 * @param cancellationToken cancels the shader resolution.
 * @returns one site per colour constant written as a three or four entry list.
 */
const shaderColorSites = async (
    document: AbstractNodeDocument,
    covered: ReadonlySet<ListNode>,
    cancellationToken: CancellationToken
): Promise<ColorSite[]> => {
    const sites: ColorSite[] = [];
    // Class resolution is the expensive part, so a document that writes no constant of the right
    // shape at all never gets that far.
    const anyCandidate = [...everyNode(document)].some(
        (node) =>
            isAssignmentNode(node) &&
            node.left.name.startsWith('_') &&
            isListNode(node.right) &&
            !covered.has(node.right) &&
            listChannels(node.right) !== undefined
    );
    if (!anyCandidate) return sites;
    const dataDir = CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath;
    for (const group of materialGroupsOf(document)) {
        if (cancellationToken.isCancellationRequested) return sites;
        const candidates = materialConstants(group).filter(
            (constant) => isListNode(constant.value) && !covered.has(constant.value) && listChannels(constant.value)
        );
        if (candidates.length === 0) continue;
        const shaderNode = materialShaderNode(group);
        if (!shaderNode) continue;
        const shaderPath = await resolveAssetPath(shaderNode, document.uri, cancellationToken).catch(() => null);
        if (!shaderPath) continue;
        // A split-pass material names one variant of a shader family and sets constants the plain
        // sibling declares, so the siblings' declarations count too.
        const declarations = [shaderPath, ...(await shaderVariantSiblings(shaderPath).catch(() => []))];
        const colorNames = new Set<string>();
        for (const declaration of declarations) {
            for (const constant of await shaderConstants(declaration, dataDir).catch(() => [])) {
                if (constant.kind === 'vec4' && constant.default?.trim() === '255') colorNames.add(constant.name);
            }
        }
        for (const constant of candidates) {
            if (!colorNames.has(constant.name)) continue;
            const list = constant.value as ListNode;
            sites.push(listSite(list, listChannels(list)!));
        }
    }
    return sites;
};

/**
 * Every colour site of a document, schema-typed and shader-typed alike.
 *
 * @param document the parsed document.
 * @param cancellationToken cancels the shader resolution.
 * @returns the sites in document order.
 */
const colorSites = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ColorSite[]> => {
    const { sites, lists } = schemaColorSites(document);
    return [...sites, ...(await shaderColorSites(document, lists, cancellationToken))];
};

/**
 * Every colour swatch in a document: group, positional list, named single value and shader colour
 * constant alike.
 *
 * @param document the parsed document.
 * @param cancellationToken cancels the shader resolution.
 * @returns one {@link ColorInformation} per colour.
 */
export const documentColors = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken = CancellationToken.None
): Promise<ColorInformation[]> =>
    (await colorSites(document, cancellationToken)).map(({ range, color }) => ({ range, color }));

/**
 * The colour-picker presentation for the colour at `range`: a single text edit that rewrites the
 * written component values in place. Re-finds the colour by the start of its {@link spanRange}, which
 * VS Code passes back, so a component the colour does not write is simply not touched and a channel
 * the pick left alone keeps the bytes it was written with.
 *
 * @param document the parsed document the colour lives in.
 * @param source the full document text (value node offsets index into it).
 * @param range the colour range the client sent back (matches a {@link documentColors} entry, or the
 * range of the previously applied edit, which shares the same start).
 * @param color the colour the user picked.
 * @param cancellationToken cancels the shader resolution.
 * @returns one presentation, or an empty list when the colour can no longer be located.
 */
export const colorPresentations = async (
    document: AbstractNodeDocument,
    source: string,
    range: Range,
    color: Color,
    cancellationToken: CancellationToken = CancellationToken.None
): Promise<ColorPresentation[]> => {
    for (const site of await colorSites(document, cancellationToken)) {
        if (site.range.start.line !== range.start.line || site.range.start.character !== range.start.character)
            continue;
        return site.write(source, color);
    }
    return [];
};
