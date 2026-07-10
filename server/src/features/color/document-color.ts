import { Color, ColorInformation, ColorPresentation, Range, TextEdit } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';

/**
 * Document colour swatches for `.rules` colour groups.
 *
 * Cosmoteer writes colours as a small group of numeric components — float `{ Rf Gf Bf Af }` (0–1, a
 * `Halfling.Graphics.Color`) or byte `{ R G B A }` (0–255, an `IntColor`). This surfaces each as an
 * LSP {@link ColorInformation} so the editor renders an inline swatch, and a colour-picker edit that
 * rewrites the existing component values in place (never the surrounding braces). Detection is
 * structural — a group carrying the `Rf`/`Gf`/`Bf` (or `R`/`G`/`B`) numeric trio — which is cheap and
 * unambiguous, so no per-group schema resolution is needed.
 */
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** The float component names, in channel order, and the byte ones — whichever a group carries. */
const FLOAT_COMPONENTS = ['Rf', 'Gf', 'Bf', 'Af'] as const;
const BYTE_COMPONENTS = ['R', 'G', 'B', 'A'] as const;

/** A colour group's component assignments, keyed by field name, with each value's node. */
const componentNodes = (group: GroupNode): Map<string, ValueNode> => {
    const components = new Map<string, ValueNode>();
    for (const element of group.elements) {
        if (isAssignmentNode(element) && isValueNode(element.right) && typeof element.right.valueType.value === 'number') {
            components.set(element.left.name, element.right);
        }
    }
    return components;
};

/** Whether a group is a float (`Rf…`) colour, a byte (`R…`) colour, or not a colour at all. */
const colorForm = (components: Map<string, ValueNode>): 'float' | 'byte' | undefined => {
    if (FLOAT_COMPONENTS.slice(0, 3).every((c) => components.has(c))) return 'float';
    if (BYTE_COMPONENTS.slice(0, 3).every((c) => components.has(c))) return 'byte';
    return undefined;
};

/** The {@link Color} a component map encodes for a given form. */
const colorOf = (components: Map<string, ValueNode>, form: 'float' | 'byte'): Color => {
    const names = form === 'float' ? FLOAT_COMPONENTS : BYTE_COMPONENTS;
    const div = form === 'float' ? 1 : 255;
    const channel = (name: string, fallback: number) =>
        clamp01((Number(components.get(name)?.valueType.value ?? fallback)) / div);
    return {
        red: channel(names[0], 0),
        green: channel(names[1], 0),
        blue: channel(names[2], 0),
        alpha: channel(names[3], div),
    };
};

/** The node the swatch/edit starts at: a named group's identifier, or an anonymous group's opening brace. */
const anchorPosition = (group: GroupNode) => group.identifier?.position ?? group.position;

/** The colour's `R`/`G`/`B`/`A` component value nodes present in a group, in channel order. */
const channelNodes = (components: Map<string, ValueNode>, form: 'float' | 'byte'): ValueNode[] =>
    (form === 'float' ? FLOAT_COMPONENTS : BYTE_COMPONENTS)
        .map((name) => components.get(name))
        .filter((node): node is ValueNode => node !== undefined);

/**
 * The range the colour occupies: from the anchor (a named group's identifier, or an anonymous group's
 * opening brace) through the last component value. This is BOTH the swatch decoration range AND the
 * colour-picker's edit range, and they MUST be identical. VS Code's inline picker tracks the region an
 * applied edit covered and passes that back as the range of the next change; if the decoration range
 * and the edit range differed, only the first change would land and every later one would miss the
 * lookup (the symptom: "the picker only changes on the first click"). Anchoring on the identifier keeps
 * the swatch next to the field name; the range then extends over the component values the edit rewrites.
 */
const colorRange = (group: GroupNode, components: Map<string, ValueNode>, form: 'float' | 'byte'): Range => {
    const anchor = anchorPosition(group);
    const last = channelNodes(components, form).reduce((a, b) => (b.position.start > a.position.start ? b : a));
    return Range.create(anchor.line, anchor.characterStart, last.position.line, last.position.characterEnd);
};

/** A colour group in a document, with its detected form and already-extracted component values. */
type ColorGroup = { group: GroupNode; form: 'float' | 'byte'; components: Map<string, ValueNode> };

/** Every colour group in a document, paired with its node (for the picker to rewrite values). */
function* colorGroups(document: AbstractNodeDocument): Generator<ColorGroup> {
    const visit = function* (node: AbstractNode): Generator<ColorGroup> {
        if (isGroupNode(node)) {
            const components = componentNodes(node);
            const form = colorForm(components);
            if (form) yield { group: node, form, components };
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
                  : [];
        for (const child of children) yield* visit(child);
    };
    for (const element of document.elements) yield* visit(element);
}

/** Every colour swatch in a document. */
export const documentColors = (document: AbstractNodeDocument): ColorInformation[] => {
    const colors: ColorInformation[] = [];
    for (const { group, form, components } of colorGroups(document)) {
        if (group.position) colors.push({ range: colorRange(group, components, form), color: colorOf(components, form) });
    }
    return colors;
};

/** Round a channel to a compact literal: 0–1 for float, 0–255 integer for byte. */
const formatChannel = (value01: number, form: 'float' | 'byte'): string =>
    form === 'float' ? String(Math.round(value01 * 1000) / 1000) : String(Math.round(value01 * 255));

/** A component to rewrite: its value node and the new literal to put in its place. */
type ChannelEdit = { node: ValueNode; text: string };

/**
 * Rebuild the source span `[spanStart, edits.at(-1).node.end)` as a single string, splicing each
 * component's new value into place and keeping every byte in between (the identifier, braces, field
 * names, whitespace, newlines) verbatim. Producing one contiguous edit rather than one edit per
 * component is deliberate: VS Code's inline colour picker desyncs and stops applying further changes
 * once a `ColorPresentation` carries `additionalTextEdits` (microsoft/vscode#136965), so a lone
 * `textEdit` is the only shape that keeps the picker working across repeated changes.
 *
 * @param source the full document text the value node offsets index into.
 * @param spanStart the source offset the replacement starts at (the colour's anchor).
 * @param edits the components to rewrite, sorted by source offset.
 * @returns the replacement text for the span from `spanStart` through the last component value.
 */
const spliceChannels = (source: string, spanStart: number, edits: ChannelEdit[]): string => {
    let out = '';
    let cursor = spanStart;
    for (const { node, text } of edits) {
        out += source.slice(cursor, node.position.start) + text;
        cursor = node.position.end;
    }
    return out;
};

/**
 * The colour-picker presentation for the colour at `range`: a single text edit that rewrites the
 * group's component values in place, leaving the identifier, braces and layout untouched. Re-finds the
 * group by its {@link colorRange} (whose start VS Code passes back), so a missing component (e.g. no
 * `Af`) is simply not written. The edit's range equals {@link colorRange} exactly — see that function
 * for why the two must match.
 *
 * @param document the parsed document the colour lives in.
 * @param source the full document text (value node offsets index into it).
 * @param range the colour range the client sent back (matches a {@link documentColors} entry, or the
 * range of the previously applied edit — which shares the same start).
 * @param color the colour the user picked.
 * @returns one presentation whose edit rewrites the component values, or an empty list if the colour
 * can no longer be located (the document changed under the picker).
 */
export const colorPresentations = (
    document: AbstractNodeDocument,
    source: string,
    range: Range,
    color: Color
): ColorPresentation[] => {
    for (const { group, form, components } of colorGroups(document)) {
        const bounds = colorRange(group, components, form);
        if (bounds.start.line !== range.start.line || bounds.start.character !== range.start.character) continue;

        const names: readonly string[] = form === 'float' ? FLOAT_COMPONENTS : BYTE_COMPONENTS;
        const channels = [color.red, color.green, color.blue, color.alpha];
        const channelOf = (name: string) => channels[names.indexOf(name)];
        const edits: ChannelEdit[] = names
            .map((name) => ({ node: components.get(name), text: formatChannel(channelOf(name), form) }))
            .filter((e): e is ChannelEdit => e.node !== undefined)
            .sort((a, b) => a.node.position.start - b.node.position.start);
        if (edits.length === 0) return [];

        const label = names
            .filter((name) => components.has(name))
            .map((name) => `${name}=${formatChannel(channelOf(name), form)}`)
            .join(' ');
        const spanStart = anchorPosition(group).start;
        return [{ label, textEdit: TextEdit.replace(bounds, spliceChannels(source, spanStart, edits)) }];
    }
    return [];
};
