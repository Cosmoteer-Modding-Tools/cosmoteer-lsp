import { CancellationToken, DocumentLink, Location, Position, Range } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument } from '../../core/ast/ast';
import { findNodeAtPosition } from '../../utils/ast.utils';
import { isReferenceValue } from './definition.service';
import { isAssetValue } from './asset-resolver';
import { DefinitionService } from './definition.service';
import { FullNavigationStrategy } from './full.navigation-strategy';
import { definitionLocationOf } from './reference-location';
import { filePathToUri } from './navigation-strategy';
import { FileTree, FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';

/**
 * `textDocument/documentLink`: turn every reference (`&Name`, `&<…>`, `/…`, inheritance refs) and
 * every asset value (`Sprite`/`Sound`/`Shader`) into clickable underlines, so a reader sees at a
 * glance what is navigable and can Ctrl-click it without first placing the cursor, the discoverable
 * counterpart to go-to-definition.
 *
 * A reference is split **per path segment**: `&<file>/Weapon/Damage` yields three links. The `<file>`
 * part jumps to the file, `Weapon` to that group, `Damage` to the field, where go-to-definition only
 * ever lands on the final target. Each segment resolves its own longest-prefix. The final segment goes
 * through the full {@link DefinitionService} so mod-action / ID / channel targets keep resolving.
 *
 * Links are produced cheaply here (ranges only). Targets are resolved lazily in
 * {@link resolveDocumentLink}, so an unfollowed link costs nothing.
 */

const ZERO_RANGE = Range.create(0, 0, 0, 0);
const navigation = new FullNavigationStrategy();

/** Payload on an unresolved link: where the token sits (to re-find it) and which prefix this segment resolves. */
export interface DocumentLinkData {
    uri: string;
    line: number;
    character: number;
    /** The reference prefix this segment resolves (e.g. `&<file>/Weapon`). Absent for an asset link. */
    prefix?: string;
    /** True when this segment is the whole token, resolved through full go-to-definition. */
    isFull: boolean;
}

const childrenOf = (node: AbstractNode): AbstractNode[] => {
    const out: AbstractNode[] = [];
    const n = node as unknown as {
        elements?: AbstractNode[];
        inheritance?: AbstractNode[];
        arguments?: AbstractNode[];
        right?: AbstractNode;
    };
    if (n.inheritance) out.push(...n.inheritance);
    if (n.elements) out.push(...n.elements);
    if (n.arguments) out.push(...n.arguments);
    if (n.right) out.push(n.right);
    return out;
};

function* walk(node: AbstractNode): Generator<AbstractNode> {
    yield node;
    for (const child of childrenOf(node)) yield* walk(child);
}

/**
 * Split a reference's raw text into its navigable segments. Each segment is `[start, end)` character
 * offsets within `raw` plus the cumulative `prefix` (`raw` up to the segment's end) that resolves it.
 * Splits on `/` outside any `<…>` file path, and skips pure operator runs (`&`, `^`, `~`, `.`, `/`)
 * that are not targets on their own but still contribute to the following segments' prefixes.
 */
const referenceSegments = (raw: string): Array<{ start: number; end: number; prefix: string }> => {
    const segments: Array<{ start: number; end: number; prefix: string }> = [];
    let segStart = 0;
    let inFile = false;
    for (let j = 0; j <= raw.length; j++) {
        const c = raw[j];
        if (c === '<') inFile = true;
        else if (c === '>') inFile = false;
        if (j === raw.length || (c === '/' && !inFile)) {
            const chunk = raw.slice(segStart, j);
            // Keep chunks that name something; drop pure operator runs (`&`, `&~`, `^`, `..`).
            if (chunk && !/^[&^~./]+$/.test(chunk)) segments.push({ start: segStart, end: j, prefix: raw.slice(0, j) });
            segStart = j + 1;
        }
    }
    return segments;
};

/**
 * The clickable links in a document: per-segment for each reference, one whole-token link for each
 * asset. Targets are unset here and filled by {@link resolveDocumentLink}.
 */
export const computeDocumentLinks = (document: AbstractNodeDocument): DocumentLink[] => {
    const links: DocumentLink[] = [];
    const push = (line: number, from: number, to: number, data: DocumentLinkData) =>
        links.push(DocumentLink.create(Range.create(line, from, line, to), undefined, data));

    for (const node of walk(document)) {
        const p = node.position;
        if (isAssetValue(node)) {
            push(p.line, p.characterStart, p.characterEnd, { uri: document.uri, line: p.line, character: p.characterStart, isFull: true });
            continue;
        }
        if (!isReferenceValue(node)) continue;
        const raw = String(node.valueType.value);
        // Per-segment ranges only line up when the stored value matches the single-line source span
        // exactly. If it doesn't (whitespace normalization, a `\`-continued multi-line ref), fall back
        // to one whole-token link so the reference is still clickable, just not sub-divided.
        const span = p.characterEnd - p.characterStart;
        const segments = raw.length === span && !raw.includes('\n') ? referenceSegments(raw) : [];
        if (segments.length === 0) {
            push(p.line, p.characterStart, p.characterEnd, { uri: document.uri, line: p.line, character: p.characterStart, isFull: true });
            continue;
        }
        for (const seg of segments) {
            push(p.line, p.characterStart + seg.start, p.characterStart + seg.end, {
                uri: document.uri,
                line: p.line,
                character: p.characterStart,
                prefix: seg.prefix,
                isFull: seg.end === raw.length,
            });
        }
    }
    return links;
};

/** A `file://` link target from a resolved {@link Location}, encoding the in-file position as a `#L` fragment. */
export const linkTargetFromLocation = (location: Location): string => {
    const { start, end } = location.range;
    // A whole-file target (asset, or a `&<…>` file reference) resolves to a zero range, so link to the
    // file itself. A member target carries a real position, so encode it as VS Code's 1-based `#L<line>,<col>`.
    if (start.line === 0 && start.character === 0 && end.line === 0 && end.character === 0) return location.uri;
    return `${location.uri}#L${start.line + 1},${start.character + 1}`;
};

const locationOfTarget = (target: AbstractNode | FileWithPath): Location =>
    isFile(target as FileTree)
        ? { uri: filePathToUri((target as FileWithPath).path), range: ZERO_RANGE }
        : definitionLocationOf(target as AbstractNode);

/**
 * Resolve a single link's target on demand. The final segment (or an asset) runs full go-to-definition
 * so every reference kind resolves; an intermediate segment resolves its own prefix through the shared
 * navigation strategy. Leaves the link targetless (unclickable) when nothing resolves.
 */
export const resolveDocumentLink = async (
    link: DocumentLink,
    document: AbstractNodeDocument,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<DocumentLink> => {
    const data = link.data as DocumentLinkData | undefined;
    if (!data) return link;
    const position = Position.create(data.line, data.character);

    if (data.isFull || data.prefix === undefined) {
        const location = await DefinitionService.instance
            .getDefinition(document, position, cancellationToken, folderPaths)
            .catch(() => null);
        // A virtual-inheritance reference resolves to several override sites; a document link is a single
        // target, so follow the first (the base's own declaration, when present).
        const single = Array.isArray(location) ? location[0] : location;
        if (single) link.target = linkTargetFromLocation(single);
        return link;
    }

    const node = findNodeAtPosition(document, position);
    if (!node) return link;
    const target = (await navigation
        .navigate(data.prefix, node, data.uri, cancellationToken)
        .catch(() => null)) as AbstractNode | FileWithPath | null;
    if (target) link.target = linkTargetFromLocation(locationOfTarget(target));
    return link;
};
