import * as l10n from '@vscode/l10n';
import { CancellationToken, Position } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    ValueNode,
    isIdentifierNode,
    isListNode,
    isValueNode,
} from '../../../core/ast/ast';
import { basenameOf } from '../../../document/document-kind';
import { findNodeAtPosition } from '../../../utils/ast.utils';
import { findReferenceTargetAtPosition } from '../reference-index';
import {
    AvailableAt,
    HopKind,
    ReferenceHop,
    ReferenceTrace,
    TracePlace,
    traceReference,
} from './reference-trace';

/**
 * The "why does this reference not resolve" report.
 *
 * A reference path is the one thing in a rules file that fails silently: the game loads the file,
 * the field simply contributes nothing, and the editor can only say that the whole name is not
 * known. This renders the walk instead. The centre of it is the failure: the last hop that did
 * resolve, and the member names the game really has at that place, inheritance chain folded in and
 * mod additions included, so the next thing to type is on the page rather than in another file.
 *
 * The renderer is modelled on the effective-group report, down to the `vscode://file/…` deep links,
 * because the two are read side by side and a reader should not have to learn two layouts.
 */

/** How many characters of a written value a line shows before it is cut. */
const VALUE_WIDTH = 60;

/** Markdown-safe inline code. */
const code = (text: string): string => '`' + text.replace(/`/g, "'") + '`';

/**
 * A markdown link to a place, labeled `file.rules:line`. Uses the `vscode://file/…` deep link with a
 * `:line` suffix, since markdown-it rejects the `file:` scheme outright. This is the effective-group
 * report's own encoding, kept identical so the two reports link the same way.
 *
 * @param place the place to link to.
 * @returns the markdown link.
 */
const placeLink = (place: TracePlace): string => {
    // A parsed cross-file document carries a plain OS path while the open document carries a real
    // uri, so both shapes reach here and only the second arrives encoded.
    const path = place.uri.startsWith('file://')
        ? decodeURIComponent(place.uri.slice('file://'.length)).replace(/^\/(?=[A-Za-z]:)/, '')
        : place.uri;
    const encoded = path
        .replace(/\\/g, '/')
        .split('/')
        .map((segment: string) => encodeURIComponent(segment).replace(/\(/g, '%28').replace(/\)/g, '%29'))
        .join('/');
    if (place.line === undefined) return `[${basenameOf(place.uri)}](vscode://file/${encoded})`;
    const line = place.line + 1;
    return `[${basenameOf(place.uri)}:${line}](vscode://file/${encoded}:${line})`;
};

/** A written value cut to one readable line. */
const shortValue = (text: string): string => (text.length > VALUE_WIDTH ? `${text.slice(0, VALUE_WIDTH)}…` : text);

/**
 * What a segment of the path does, in words.
 *
 * @param kind the hop kind.
 * @returns the description.
 */
const kindText = (kind: HopKind): string => {
    switch (kind) {
        case 'file':
            return l10n.t('file');
        case 'member':
            return l10n.t('member');
        case 'index':
            return l10n.t('list position');
        case 'base':
            return l10n.t('base number');
        case 'baseAnchor':
            return l10n.t('the base list of the node');
        case 'parent':
            return l10n.t('the containing node');
        case 'runtimeRoot':
            return l10n.t('the runtime root');
        case 'virtual':
            return l10n.t('the most derived inheritor');
        case 'unmodelled':
            return l10n.t('a segment the editor has no rule for');
    }
};

/**
 * What a hop landed on, in words.
 *
 * @param hop the hop.
 * @returns the description, empty when the hop did not resolve.
 */
const landedText = (hop: ReferenceHop): string => {
    if (!hop.landedOn) return '';
    const where = placeLink(hop.landedOn);
    switch (hop.landedKind) {
        case 'file':
            return l10n.t('the file {0}', where);
        case 'document':
            return l10n.t('the whole file {0}', where);
        case 'group':
            return l10n.t('a group in {0}', where);
        case 'list':
            return l10n.t('a list in {0}', where);
        case 'value':
            return l10n.t('a value in {0}', where);
        default:
            return where;
    }
};

/**
 * One row of the steps table.
 *
 * @param hop the hop to render.
 * @param index the hop's position in the path.
 * @param failedAt the index of the failing hop, or -1 when the whole path resolved.
 * @returns the markdown row.
 */
const hopRow = (hop: ReferenceHop, index: number, failedAt: number): string => {
    const notes: string[] = [];
    if (hop.inherited) notes.push(l10n.t('found through the inheritance chain'));
    if (hop.aliasText && hop.resolved) notes.push(l10n.t('follows {0}', code(shortValue(hop.aliasText))));
    let landing: string;
    if (hop.resolved) {
        landing = [landedText(hop), ...notes].filter(Boolean).join(' · ');
    } else if (index !== failedAt) {
        landing = l10n.t('not reached');
    } else if (hop.aliasBroken) {
        landing = `**${l10n.t('the reference this member holds leads nowhere')}**${
            hop.aliasText ? ` · ${code(shortValue(hop.aliasText))}` : ''
        }`;
    } else {
        landing = `**${l10n.t('not found')}**`;
    }
    return `| ${index + 1} | ${code(hop.segment)} | ${kindText(hop.kind)} | ${landing} |`;
};

/**
 * The sentence that says what the whole walk amounts to.
 *
 * @param trace the finished trace.
 * @returns the markdown paragraph.
 */
const verdictText = (trace: ReferenceTrace): string => {
    if (trace.hops.length === 0) return l10n.t('This path has no segments to walk, so there is nothing to resolve.');
    const failing = trace.failedAt >= 0 ? code(trace.hops[trace.failedAt].segment) : '';
    switch (trace.verdict) {
        case 'resolved': {
            const last = trace.hops[trace.hops.length - 1];
            return last?.landedOn
                ? l10n.t('Every step resolves. This points at {0}.', landedText(last))
                : l10n.t('Every step resolves.');
        }
        case 'resolved-via-mod':
            return l10n.t(
                'The game folder on its own does not have this, but the mod adds it, so it resolves everywhere inside this mod. It comes from {0}.',
                trace.modOrigin ? placeLink(trace.modOrigin) : ''
            );
        case 'runtime-only':
            return l10n.t(
                'This path starts at "~", the object the rule is built into, and which object that is only becomes known when the game builds it. The editor stands the root of this file in for it, which is right for a file that reaches into itself and wrong for a group that is inherited into a part elsewhere. The walk stopped at {0}, and that says nothing about whether the game finds it.',
                failing
            );
        case 'virtual':
            return l10n.t(
                'This path goes through ":", which the game answers with whichever inheritor is being built. The base itself does not have to declare the member, so the walk stopping at {0} says nothing about whether the game finds it.',
                failing
            );
        case 'optional-target':
            return l10n.t(
                'The target is not there, and this action says that is allowed. With "IgnoreIfNotExisting" the game skips the action, and with "CreateIfNotExisting" it creates the target, so nothing here is broken.'
            );
        case 'extends-missing-member':
            return l10n.t(
                'This is a base a group inherits, and the base itself is there. It does not declare {0}, which the game allows: the base then contributes nothing to that member and the group keeps what it writes itself.',
                failing
            );
        case 'unmodelled-segment':
            return l10n.t(
                'The segment {0} is allowed by the path grammar, but the editor has no rule for it and does not guess. Nothing here says whether the game resolves it.',
                failing
            );
        case 'cycle':
            return l10n.t(
                'The step {0} leads into a chain of references that comes back to itself. The game fails to load a file over this, so it has to be broken somewhere along the chain.',
                failing
            );
        case 'cancelled':
            return l10n.t('The walk was stopped before it finished, so this report is only as far as it got.');
        case 'broken':
            return trace.lastGood
                ? l10n.t('The step {0} does not resolve. The walk got as far as {1}.', failing, placeLink(trace.lastGood))
                : l10n.t('The step {0} does not resolve, and nothing before it resolved either.', failing);
    }
};

/**
 * The heart of the report: where the walk stopped and what the game has there.
 *
 * @param trace the finished trace.
 * @returns the markdown lines, empty when the whole path resolved.
 */
const stoppedSection = (trace: ReferenceTrace): string[] => {
    // Nothing to explain when the path resolved, and nothing to explain when the mod supplies it:
    // the vanilla walk stopping somewhere is not a defect there, so a table of what it stopped at
    // would read as one.
    if (trace.failedAt < 0 || trace.verdict === 'resolved-via-mod') return [];
    const lines: string[] = [];
    const failing = trace.hops[trace.failedAt];
    const available: AvailableAt = trace.available;
    lines.push('');
    lines.push(`## ${l10n.t('Where it stops')}`);
    lines.push('');
    switch (available.kind) {
        case 'members': {
            lines.push(
                trace.lastGood
                    ? l10n.t('The walk got as far as {0}, which holds these members.', placeLink(trace.lastGood))
                    : l10n.t('These are the members the walk had to choose from.')
            );
            if (trace.suggestion) {
                lines.push('');
                lines.push(`**${l10n.t('Did you mean {0}?', code(trace.suggestion))}**`);
            }
            if (available.incomplete) {
                lines.push('');
                lines.push(
                    `> ⚠ ${l10n.t('A base of this container could not be read, so the game may have members this list does not show.')}`
                );
            }
            lines.push('');
            lines.push(`| ${l10n.t('Member')} | ${l10n.t('Where it comes from')} |`);
            lines.push('| --- | --- |');
            if (available.names.length === 0) {
                lines.push(`| *${l10n.t('none')}* | |`);
            } else {
                for (const member of available.names) {
                    lines.push(
                        `| ${code(member.name)} | ${
                            member.inherited
                                ? l10n.t('inherited from {0}', placeLink(member.origin))
                                : l10n.t('written in {0}', placeLink(member.origin))
                        } |`
                    );
                }
            }
            if (available.total > available.names.length) {
                lines.push('');
                lines.push(l10n.t('{0} more members are not listed.', String(available.total - available.names.length)));
            }
            break;
        }
        case 'entries':
            lines.push(
                available.count === 0
                    ? l10n.t('The walk stopped at a list that has no entries at all, so no position resolves in it.')
                    : l10n.t(
                          'The walk stopped at a list of {0} entries, so the positions that resolve there are 0 to {1}.',
                          String(available.count),
                          String(available.count - 1)
                      )
            );
            if (available.incomplete) {
                lines.push('');
                lines.push(
                    `> ⚠ ${l10n.t('A base of this list could not be read, so the game may read more entries than this.')}`
                );
            }
            break;
        case 'bases':
            lines.push(
                available.count === 0
                    ? l10n.t('This container declares no bases at all, so no base number resolves on it.')
                    : l10n.t(
                          'This container declares {0} bases, so the base numbers that resolve on it are 0 to {1}.',
                          String(available.count),
                          String(available.count - 1)
                      )
            );
            break;
        case 'value':
            lines.push(
                l10n.t(
                    'The walk stopped at a value, {0}. A value has no members, so nothing can follow it.',
                    code(shortValue(available.text))
                )
            );
            break;
        case 'alias':
            lines.push(
                available.declaredAt
                    ? l10n.t(
                          'The member {0} is there, written in {1}. What does not resolve is the reference it holds, {2}, so the fix belongs there rather than here.',
                          code(failing.segment),
                          placeLink(available.declaredAt),
                          code(shortValue(available.text))
                      )
                    : l10n.t(
                          'The member {0} is there. What does not resolve is the reference it holds, {1}, so the fix belongs there rather than here.',
                          code(failing.segment),
                          code(shortValue(available.text))
                      )
            );
            break;
        case 'file':
            lines.push(
                l10n.t(
                    'There is no such file. The game looks for it in {0}, which is the folder this path is resolved against.',
                    code(available.directory)
                )
            );
            break;
        case 'withheld':
            lines.push(
                available.reason === 'runtime-root'
                    ? l10n.t(
                          'No member names are listed here on purpose. Everything past "~" stands in the object the game builds this rule into, and this file is only a stand-in for it, so any list of names would come from the wrong place and any correction offered from it would be wrong.'
                      )
                    : l10n.t(
                          'No member names are listed here on purpose. Everything past ":" stands in whichever inheritor the game builds, so any list of names would come from the wrong place.'
                      )
            );
            break;
        case 'none':
            lines.push(l10n.t('The place the walk stopped at cannot be read, so there is nothing to list.'));
            break;
    }
    return lines;
};

/**
 * The inheritors a `:` path reaches, which is what the game picks between when it builds one.
 *
 * @param trace the finished trace.
 * @returns the markdown lines, empty when the path has no `:`.
 */
const virtualSection = (trace: ReferenceTrace): string[] => {
    if (trace.virtualTargets.length === 0) return [];
    const lines: string[] = [];
    lines.push('');
    lines.push(`## ${l10n.t('What the inheritors give it')}`);
    lines.push('');
    lines.push(
        l10n.t(
            'The ":" picks the most derived version at run time. These are the places that give this member a value.'
        )
    );
    lines.push('');
    for (const target of trace.virtualTargets) lines.push(`- ${placeLink(target)}`);
    return lines;
};

/**
 * Renders the explanation of one reference as markdown.
 *
 * @param trace the finished trace.
 * @returns the markdown report.
 */
export const renderReferenceTrace = (trace: ReferenceTrace): string => {
    const lines: string[] = [];
    lines.push(`# ${l10n.t('What {0} points at', code(shortValue(trace.written)))}`);
    lines.push('');
    lines.push(l10n.t('Written in {0}.', placeLink(trace.at)));
    if (trace.actionTarget) {
        lines.push('');
        lines.push(
            l10n.t(
                'This is a mod action target, so the game resolves it from the game Data folder rather than from the folder this file is in. The path walked is {0}.',
                code(trace.walked)
            )
        );
    }
    lines.push('');
    lines.push(verdictText(trace));
    lines.push(...stoppedSection(trace));

    lines.push('');
    lines.push(`## ${l10n.t('Every step')}`);
    lines.push('');
    lines.push(`| ${l10n.t('Step')} | ${l10n.t('Segment')} | ${l10n.t('Kind')} | ${l10n.t('Where it lands')} |`);
    lines.push('| --- | --- | --- | --- |');
    if (trace.hops.length === 0) {
        lines.push(`| | ${code(trace.written)} | ${l10n.t('this path has no segments to walk')} | |`);
    } else {
        for (let index = 0; index < trace.hops.length; index++) {
            lines.push(hopRow(trace.hops[index], index, trace.failedAt));
        }
    }

    lines.push(...virtualSection(trace));
    return lines.join('\n');
};

/**
 * The reference a node stands for, or undefined for anything else.
 *
 * A bare `&…` standing alone as a list element (`MediaEffects [ &/PARTICLES/Foo ]`) parses to an
 * identifier rather than to a value, because the element before it is not a value. It is a reference
 * all the same, so it is wrapped exactly as the value validator wraps it, with the same parent and
 * position, and explained like any other.
 *
 * @param node the node under the caret.
 * @returns the reference value, or undefined.
 */
const asReference = (node: AbstractNode | null | undefined): ValueNode | undefined => {
    if (!node) return undefined;
    if (isValueNode(node) && node.valueType.type === 'Reference') return node;
    if (isIdentifierNode(node) && typeof node.name === 'string' && node.name.startsWith('&') && isListNode(node.parent)) {
        return {
            type: 'Value',
            valueType: { type: 'Reference', value: node.name },
            parent: node.parent,
            position: node.position,
        };
    }
    return undefined;
};

/**
 * The reference a caret is asking about. The caret is normally on the path itself, and go to
 * definition reads it exactly this way. Resting on the field's name is the same question asked from
 * one character further left, so that reaches the value it assigns as well.
 *
 * @param document the parsed document.
 * @param position the caret.
 * @returns the reference value, or undefined when the caret is on something else.
 */
const referenceAt = (document: AbstractNodeDocument, position: Position): ValueNode | undefined =>
    asReference(findNodeAtPosition(document, position)) ?? asReference(findReferenceTargetAtPosition(document, position));

/**
 * Renders the reference report for the reference under a caret.
 *
 * @param document the parsed document.
 * @param position the caret.
 * @param token cancels the cross-file walk.
 * @returns the markdown report, or null when the caret is not on a reference.
 */
export const generateReferenceTraceReport = async (
    document: AbstractNodeDocument,
    position: Position,
    token: CancellationToken
): Promise<string | null> => {
    const node = referenceAt(document, position);
    if (!node) return null;
    const trace = await traceReference(node, token);
    return trace ? renderReferenceTrace(trace) : null;
};
