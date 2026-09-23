import { readFile } from 'fs/promises';
import * as l10n from '@vscode/l10n';
import { TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { AbstractNode, GroupNode, isAssignmentNode, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { basenameOf } from '../../document/document-kind';
import { uriToFsPath } from '../../workspace/workspace-files';
import { appendMemberEdit, replaceSpan, spanIsCurrent, valueSpan } from '../refactor/rules-edit';
import { clientUri, fileKey, isDerivedPath, reachedAt, rewalkedPartFor } from './part-table.service';
import { PartTableEditHooks, PartTableEditResult } from './part-table.types';

/**
 * The part table's writer: it turns a number the reader typed into a table cell into an edit of the
 * file the value really comes from. The reader beside it, `part-table.service.ts`, walks the parts
 * and works out what each cell shows, and hands this file the walked part and the value a cell was
 * read from.
 *
 * The three ways a value reaches a cell decide where the edit lands. A value the part writes itself
 * is written over in place. A value a mod's manifest merges into the part is written where the
 * manifest writes it, since the manifest is applied after the part's own file. A value the part only
 * inherits is added to the part's own group as an override, so the base keeps its value for every
 * other part that reads it.
 *
 * The spans, the appends and the indentation all come from `refactor/rules-edit.ts`, which the grid
 * editor's writer uses as well.
 */

/** What a reader may type over a cell: a number, with or without one of the game's suffixes. */
const WRITABLE_NUMBER = /^-?\d*\.?\d+([eE][-+]?\d+)?[%dr]?$/;

/** How much of a replaced value the note repeats before it is cut. */
const NOTE_SNIPPET_LENGTH = 40;

/**
 * The direct member of a group by name, in either `Name = value` or `Name { }` form, matched the way
 * the game matches names.
 *
 * @param container the group to look in.
 * @param name the member name.
 * @returns the member's value node, or null when the group writes no such member itself.
 */
const ownMember = (container: GroupNode, name: string): AbstractNode | null => {
    const lower = name.toLowerCase();
    for (const element of container.elements) {
        if (isAssignmentNode(element) && element.left.name.toLowerCase() === lower && element.right) {
            return element.right;
        }
        if ((isGroupNode(element) || isListNode(element)) && element.identifier?.name.toLowerCase() === lower) {
            return element;
        }
    }
    return null;
};

/**
 * The current text of a file an edit may land in: the editor's buffer when it is open, the file on
 * disk otherwise.
 *
 * @param uri the file's uri or path.
 * @param hooks the request layer's hooks.
 * @returns the text, or null when the file could not be read.
 */
const textOf = async (uri: string, hooks: PartTableEditHooks): Promise<string | null> => {
    const open = hooks.openText(clientUri(uri));
    if (open !== undefined) return open;
    return readFile(uriToFsPath(uri), { encoding: 'utf-8' }).catch(() => null);
};

/**
 * Whether a file is one of the game's own, which a mod cannot edit.
 *
 * @param uri the file's uri or path.
 * @param hooks the request layer's hooks, carrying the game's root.
 * @returns true when the file sits under the game's data root.
 */
const isGameFile = (uri: string, hooks: PartTableEditHooks): boolean => {
    if (!hooks.dataRootPath) return false;
    const root = fileKey(hooks.dataRootPath).replace(/\/+$/, '');
    const file = fileKey(uri);
    return file === root || file.startsWith(`${root}/`);
};

/**
 * The edit that writes a number over a value in place, with the note saying what it replaced when
 * that was more than a number. A reference or an expression is what a reader loses by typing over
 * it, and the note is the one place that says so.
 *
 * @param uri the file the value is written in.
 * @param node the value node.
 * @param written the number as the reader typed it.
 * @param hooks the request layer's hooks.
 * @param where what the note says about the file, absent for the plain form.
 * @returns the edit, or the reason none can be made.
 */
const overwriteInPlace = async (
    uri: string,
    node: AbstractNode,
    written: string,
    hooks: PartTableEditHooks,
    where?: string
): Promise<PartTableEditResult> => {
    if (isGameFile(uri, hooks)) {
        return {
            status: 'refused',
            message: l10n.t("{0} is one of the game's own files, which a mod cannot edit.", basenameOf(uri)),
        };
    }
    const current = await textOf(uri, hooks);
    // The walk keeps nodes from the parse of the moment, so a buffer that has moved on since would
    // take the edit somewhere else in the file.
    if (current === null || !spanIsCurrent(current, node)) {
        return { status: 'notFound', message: l10n.t('The table has to be read again before it can be edited.') };
    }
    // The span is read out as well as written over, since the note repeats what the reader lost.
    const span = valueSpan(current, node);
    const replaced = current.slice(span.start, span.end).trim();
    const edit: TextEdit = replaceSpan(current, span.start, span.end, written);
    const file = basenameOf(uri);
    const plain = isValueNode(node) && node.valueType.type !== 'Reference';
    const snippet = replaced.length > NOTE_SNIPPET_LENGTH ? `${replaced.slice(0, NOTE_SNIPPET_LENGTH - 1)}…` : replaced;
    let note: string;
    if (where && plain) note = l10n.t('Written into {0}, {1}.', file, where);
    else if (where) note = l10n.t('Written into {0}, {1}, in place of {2}.', file, where, snippet);
    else if (plain) note = l10n.t('Written into {0}.', file);
    else note = l10n.t('Written into {0} in place of {1}.', file, snippet);
    return { status: 'ok', edit: { changes: { [clientUri(uri)]: [edit] } }, note };
};

/**
 * Builds the edit that writes a typed-over value into the file. A value the part writes itself is
 * written over in place, and so is one a mod's manifest merges into the part, in the manifest,
 * since the manifest is applied after the part's own file. A value the part inherits is added to
 * the part's own group as an override, with the groups on the way to it created inline, so the base
 * keeps its value for every other part that reads it. A value inside an inherited list cannot be
 * overridden one element at a time, and the game's own files cannot be written at all, so those are
 * refused with the reason.
 *
 * @param rowKey the row's key.
 * @param path the column path.
 * @param text the value as the reader typed it.
 * @param hooks the request layer's hooks.
 * @returns the edit, or the reason none can be made.
 */
export const buildPartTableEdit = async (
    rowKey: string,
    path: string,
    text: string,
    hooks: PartTableEditHooks
): Promise<PartTableEditResult> => {
    // The part is read again before anything is worked out from it, since the edit is a span of the
    // text the reader has in front of them and the walk behind the table may be older than it.
    const entry = await rewalkedPartFor(rowKey);
    if (!entry)
        return { status: 'notFound', message: l10n.t('The table has to be read again before it can be edited.') };
    const written = text.trim();
    if (!WRITABLE_NUMBER.test(written)) {
        return {
            status: 'refused',
            message: l10n.t('Write a number, with the % d or r suffix the value already has.'),
        };
    }
    if (isDerivedPath(path)) {
        return {
            status: 'refused',
            message: l10n.t('{0} is worked out from other columns. Edit those instead.', path),
        };
    }
    const reached = reachedAt(entry, path);
    if (!reached) return { status: 'refused', message: l10n.t('The part holds no value at {0}.', path) };

    if (!reached.inherited) return overwriteInPlace(reached.origin.uri, reached.node, written, hooks);

    // A manifest's value is the one the game ends up with whatever the part's file says, so it is
    // written where the manifest writes it. The declaration may sit in a file the manifest reads
    // its overrides from, which is still the mod's own.
    if (reached.injected) {
        return overwriteInPlace(
            reached.origin.uri,
            reached.node,
            written,
            hooks,
            l10n.t('where the mod overrides the part')
        );
    }

    // The value comes from a base. The part gets its own copy, nested as deep as the path goes,
    // inside the deepest group the part already writes on the way there.
    const ownUri = entry.part.fsPath;
    if (isGameFile(ownUri, hooks)) {
        return {
            status: 'refused',
            message: l10n.t("{0} is one of the game's own files, which a mod cannot edit.", basenameOf(ownUri)),
        };
    }
    const segments = path.split('/');
    let container: GroupNode = entry.group;
    let index = 0;
    while (index < segments.length - 1) {
        const next = ownMember(container, segments[index]);
        if (!next) break;
        if (!isGroupNode(next)) {
            return {
                status: 'refused',
                message: l10n.t(
                    '{0} sits inside a list the part inherits, which cannot be overridden one value at a time.',
                    path
                ),
            };
        }
        container = next;
        index++;
    }
    const remaining = segments.slice(index);
    if (remaining.some((segment) => /^\d+$/.test(segment))) {
        return {
            status: 'refused',
            message: l10n.t(
                '{0} sits inside a list the part inherits, which cannot be overridden one value at a time.',
                path
            ),
        };
    }
    const current = await textOf(ownUri, hooks);
    if (current === null) {
        return { status: 'notFound', message: l10n.t('The table has to be read again before it can be edited.') };
    }
    const existing = remaining.length === 1 ? ownMember(container, remaining[0]) : null;
    if (existing && !isGroupNode(existing) && !isListNode(existing)) {
        return overwriteInPlace(ownUri, existing, written, hooks);
    }
    let elementText = `${remaining[remaining.length - 1]} = ${written}`;
    for (let depth = remaining.length - 2; depth >= 0; depth--) elementText = `${remaining[depth]} { ${elementText} }`;
    // The member goes on a line of its own after the group's last member. A one-line group is broken
    // open rather than continued inline, since an override the reader has to find again reads better
    // on its own line than appended to a row of members.
    const edit = appendMemberEdit(current, container, elementText);
    if (!edit)
        return { status: 'notFound', message: l10n.t('The table has to be read again before it can be edited.') };
    const workspaceEdit: WorkspaceEdit = { changes: { [clientUri(ownUri)]: [edit] } };
    return {
        status: 'ok',
        edit: workspaceEdit,
        note: l10n.t('Added to {0} as an override. The base keeps its value.', basenameOf(ownUri)),
    };
};
