import { mkdir, rm, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'path';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { AbstractNodeDocument, GroupNode, isGroupNode } from '../../../core/ast/ast';
import { ROOT_GROUP_CLASSES } from '../../../document/schema/schema-context';
import { findModRoot } from '../../../mod/mod-root';
import { globalSettings } from '../../../settings';
import { parseText } from '../../../utils/ast.utils';
import { cachedPathExists } from '../../../workspace/fs-cache';
import { filePathToUri } from '../../navigation/navigation-strategy';
import { uriToFsPath } from '../../navigation/workspace-files';
import { documentFor, lineEndingOf, openBuffers } from '../command-host';
import { relativeRulesReference } from '../shared-base/base-file.emitter';
import { hasMultiLineString, memberSpanOf } from '../shared-base/member-record';
import { analyzeReferences, applyRebases } from '../shared-base/reference-safety';
import { ExtractGroupArgs, ExtractGroupFailure, ExtractGroupHost, ExtractGroupResult } from './extract-group.types';

/**
 * The `workspace/executeCommand` id that moves an inline group into a file of its own. Both clients
 * invoke it twice: without a file name it reports what would be moved and what to call it, and with
 * one it writes the file and replaces the group with a reference to it.
 */
export const EXTRACT_GROUP_COMMAND = 'cosmoteer.extractGroupToFile';

/**
 * The command the lightbulb's refactoring carries, deliberately absent from the server's
 * `executeCommandProvider` so that it is never executed here. What the new file is called is a name
 * only the author can give, and a code action has no way to ask for one.
 */
export const EXTRACT_GROUP_ACTION_COMMAND = 'cosmoteer.extractGroupToFileFromAction';

/** `ShotEffect` becomes `shot_effect.rules`, the spelling the game's own files are named with. */
const fileNameFor = (groupName: string): string =>
    `${groupName
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9_]+/g, '_')
        .toLowerCase()
        .replace(/^_+|_+$/g, '')}.rules`;

/**
 * The innermost named group the offset falls in, so a caret inside a nested block moves that block
 * rather than the part around it.
 *
 * @param container the group or document to search.
 * @param offset the caret's byte offset.
 * @returns the group, or undefined when the offset falls in no named group.
 */
export const locateGroup = (container: AbstractNodeDocument | GroupNode, offset: number): GroupNode | undefined => {
    for (const element of container.elements) {
        const span = memberSpanOf(element);
        if (!span || offset < span.start || offset >= span.end) continue;
        if (!isGroupNode(element)) return undefined;
        const deeper = offset >= element.position.start ? locateGroup(element, offset) : undefined;
        return deeper ?? (element.identifier ? element : undefined);
    }
    return undefined;
};

/**
 * Whether a group is what gives its file a meaning: the only thing the file declares, or a name
 * the schema roots a whole file by. Moving one of those leaves an empty file behind, or a file
 * whose members no longer have the class the name gave them.
 *
 * @param document the parsed document.
 * @param group the group being moved.
 * @returns true when the group has to stay where it is.
 */
const isRootGroup = (document: AbstractNodeDocument, group: GroupNode): boolean => {
    if (group.identifier && ROOT_GROUP_CLASSES[group.identifier.name]) return true;
    const topLevel = document.elements.filter((element) => memberSpanOf(element) !== undefined);
    return topLevel.length === 1 && topLevel[0] === group;
};

/**
 * The body of a group, dedented to sit at the root of a file of its own, with every path it carries
 * re-expressed against the new file's folder.
 *
 * @param text the source of the file the group is written in.
 * @param group the group being moved.
 * @param sourceDir the folder the group's file sits in.
 * @param targetDir the folder the new file goes in.
 * @param lineEnding the ending the source file uses, which the new file keeps.
 * @returns the new file's text, or the reason the group cannot be moved.
 */
const bodyOf = (
    text: string,
    group: GroupNode,
    sourceDir: string,
    targetDir: string,
    lineEnding: '\n' | '\r\n'
): { text: string } | { failure: ExtractGroupFailure } => {
    const open = text.indexOf('{', group.identifier?.position.end ?? group.position.start);
    const close = group.position.end;
    if (open < 0 || close <= open) return { failure: 'stale' };
    const raw = text.slice(open + 1, close - 1);
    if (hasMultiLineString(raw)) return { failure: 'multiLineText' };
    const verdict = analyzeReferences(raw, sourceDir, targetDir);
    if (!verdict.safe) return { failure: 'scopeRelativeValue' };
    const rebased = applyRebases(raw, verdict.rebases);
    // The body sits one level deeper than the file it is moving into, so every line loses the depth
    // the group gave it. The indentation of the first written line is what that depth is.
    const lines = rebased.split('\n').map((line) => line.replace(/\r$/, ''));
    while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
    const depth = /^[ \t]*/.exec(lines[0] ?? '')?.[0] ?? '';
    const body = lines.map((line) => (line.startsWith(depth) ? line.slice(depth.length) : line.replace(/^[ \t]+/, '')));
    return { text: `${body.join(lineEnding)}${lineEnding}` };
};

/**
 * Moves an inline group into a file of its own and leaves a reference in its place. Called twice: the
 * first round reports what would move and what the file would be called, the second writes it.
 *
 * The whole-file form is what the game's own data uses for exactly this (`Bullet = &<./Data/shots/
 * bullet_med/bullet_med.rules>`), so the extracted file carries the group's members at its root
 * rather than the group around them.
 *
 * @param args what the client sent.
 * @param host the server facilities the buffers and the edit go through.
 * @param token cancellation for the file read.
 * @returns what would move, what was written, or why nothing can be.
 */
export const extractGroupToFile = async (
    args: ExtractGroupArgs,
    host: ExtractGroupHost,
    token: CancellationToken
): Promise<ExtractGroupResult> => {
    if (!args?.uri) return { failure: 'stale' };
    if (!findModRoot(args.uri) && !globalSettings.allowEditingVanillaFiles) return { failure: 'notEditable' };
    const fsPath = uriToFsPath(args.uri);
    if (!fsPath) return { failure: 'stale' };
    const textDocument = await documentFor(fsPath, openBuffers(host));
    if (!textDocument || token.isCancellationRequested) return { failure: 'stale' };
    const text = textDocument.getText();
    const document = parseText(text, fsPath);
    const group = locateGroup(document, args.offset);
    if (!group?.identifier) return { failure: 'notAGroup' };
    // A group deriving from somewhere else carries members no copy of its body holds, so moving it
    // would silently drop them.
    if (group.inheritance?.length) return { failure: 'inheritedGroup' };
    if (isRootGroup(document, group)) return { failure: 'rootGroup' };
    const span = memberSpanOf(group);
    if (!span) return { failure: 'stale' };
    const name = group.identifier.name;
    const sourceDir = dirname(fsPath);

    if (!args.fileName) {
        return { offer: { name, fileName: fileNameFor(name), members: group.elements.length } };
    }

    const requested = normalize(args.fileName).replace(/\\/g, '/');
    if (isAbsolute(requested) || requested.startsWith('..') || !/\.rules$/i.test(requested)) {
        return { failure: 'badFileName' };
    }
    const targetPath = resolve(join(sourceDir, requested));
    if (cachedPathExists(targetPath)) return { failure: 'fileExists' };

    const lineEnding = lineEndingOf(text);
    const built = bodyOf(text, group, sourceDir, dirname(targetPath), lineEnding);
    if ('failure' in built) return built;

    const reference = `${name} = &${relativeRulesReference(sourceDir, targetPath)}`;
    const edit: TextEdit = {
        range: { start: textDocument.positionAt(span.start), end: textDocument.positionAt(span.end) },
        newText: reference,
    };
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, built.text, { encoding: 'utf-8' });
    host.filesChanged([targetPath]);
    const applied = await host.applyEdit({ [args.uri]: [edit] }).catch(() => false);
    // An editor that refuses the edit leaves a file nothing references, so it goes again.
    if (!applied) {
        await rm(targetPath, { force: true }).catch(() => undefined);
        host.filesChanged([targetPath]);
        return { failure: 'editRejected' };
    }
    return { written: { uri: filePathToUri(targetPath), reference } };
};
