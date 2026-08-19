import { dirname } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { fieldOf } from '../../document/schema/schema';
import { registryForGroup, resolveGroupClass } from '../../document/schema/schema-context';
import { holdsList, isListLike, ownsItsLines } from '../refactor/shared-base/extractability';
import { inheritedMembersOf } from '../refactor/shared-base/inherited-value';
import {
    commentRanges,
    hasMultiLineString,
    normalizeMemberText,
    overlapsComment,
    topLevelMembersOf,
} from '../refactor/shared-base/member-record';
import { analyzeReferences, applyRebases } from '../refactor/shared-base/reference-safety';
import { uriToFsPath } from '../navigation/workspace-files';
import { ValidationError } from './validator';
import { referencedSegments } from './validator.ignored-field';
import * as l10n from '@vscode/l10n';

/**
 * Fields that name one particular thing rather than describe a kind of thing. A base and a deriver
 * spelling the same id is a bug somewhere else, not a redundant line, and the id indexes read the
 * declaration itself rather than the inherited value.
 */
const IDENTITY_FIELDS = new Set(['id', 'otherids']);

/**
 * The comparison form of a member, with its name folded so a base writing `Density` and a deriver
 * writing `density` still compare equal, the way the game matches them.
 *
 * @param key the member's folded name.
 * @param name the member's name as written.
 * @param normalized the member's normalized source, which starts with that name.
 * @returns the text two members are compared by.
 */
const comparable = (key: string, name: string, normalized: string): string =>
    key + normalized.slice(name.length);

/**
 * Whole-document pass fading a field whose value the container already inherits, so writing it
 * leaves the game exactly where deleting it would. The counterpart of the duplicate-field hint: that
 * one finds a value repeated across files that could move into a base, this one finds a value the
 * base already supplies.
 *
 * Conservative in the same way, and for the same reason. A field is only faded when the whole
 * inheritance chain could be followed and read, when neither copy carries a reference that resolves
 * against its own surroundings (`~`, `^`, `:`, a bare `&Name`), when every file path in both means
 * the same file from where it is written, when it is not a list (an inherited list is prepended to
 * the deriver's own rather than replaced, so an identical list is not a redundant one), when it is
 * neither an identity field nor the discriminator the class is resolved by, when no reference in the
 * file reads its name, when no comment touches it, and when it owns the lines it sits on. Anything
 * that cannot be established answers "not redundant".
 *
 * @param document the parsed document to validate.
 * @param text that document's current source text.
 * @param cancellationToken cancels the walk and the base-file reads.
 * @returns the hints for fields that restate an inherited value, each with a remove quick fix.
 */
export const validateRedundantOverrides = async (
    document: AbstractNodeDocument,
    text: string,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const declaringDir = dirname(uriToFsPath(document.uri)).replace(/\\/g, '/');
    const comments = commentRanges(text);
    const readNames = referencedSegments(document);
    const errors: ValidationError[] = [];

    const containers: GroupNode[] = [];
    const collect = (node: AbstractNode): void => {
        if (isGroupNode(node) && node.identifier && node.inheritance?.length) containers.push(node);
        if (isGroupNode(node) || isListNode(node)) for (const child of node.elements) collect(child);
    };
    for (const element of document.elements) collect(element);

    for (const container of containers) {
        if (cancellationToken.isCancellationRequested) return errors;
        const references: string[] = [];
        let readable = true;
        for (const base of container.inheritance ?? []) {
            if (!isValueNode(base) || base.valueType.type !== 'Reference') readable = false;
            else references.push(String(base.valueType.value));
        }
        if (!readable || references.length === 0) continue;
        const className = resolveGroupClass(container);
        if (!className) continue;
        const discriminator = (registryForGroup(container)?.typeField ?? 'Type').toLowerCase();

        const members = topLevelMembersOf(container, text);
        const seen = new Set<string>();
        const duplicated = new Set<string>();
        for (const member of members) {
            if (seen.has(member.key)) duplicated.add(member.key);
            seen.add(member.key);
        }
        // The gap before a member carries its banner comment, so it is judged with the member itself.
        let previousEnd = container.position.start + 1;
        const eligible: Array<{ member: (typeof members)[number]; rebased: string }> = [];
        for (const member of members) {
            const gapStart = previousEnd;
            previousEnd = member.end;
            if (duplicated.has(member.key)) continue;
            if (member.key === discriminator || member.key === 'type') continue;
            if (IDENTITY_FIELDS.has(member.key)) continue;
            if (holdsList(member.node)) continue;
            const field = fieldOf(className, member.name);
            if (!field || field.dead === true || isListLike(field.valueType.kind)) continue;
            if (readNames.has(member.key)) continue;
            if (overlapsComment(comments, gapStart, member.end)) continue;
            if (hasMultiLineString(member.raw)) continue;
            if (!ownsItsLines(text, member.start, member.end)) continue;
            // Judged against its own directory: nothing is being moved, so the point is only to
            // refuse the forms whose meaning depends on where they are written.
            const verdict = analyzeReferences(member.raw, declaringDir, declaringDir);
            if (!verdict.safe) continue;
            eligible.push({ member, rebased: applyRebases(member.raw, verdict.rebases) });
        }
        if (eligible.length === 0) continue;

        const inherited = await inheritedMembersOf(
            references,
            declaringDir,
            new Set(eligible.map((entry) => entry.member.key))
        );
        if (!inherited) continue;

        for (const { member, rebased } of eligible) {
            const supplied = inherited.get(member.key);
            if (!supplied) continue;
            // The base's copy is re-expressed as if it were written here, so a path that names the
            // same file from both directories compares equal and one that does not never can.
            const baseVerdict = analyzeReferences(supplied.raw, supplied.declaringDir, declaringDir);
            if (!baseVerdict.safe) continue;
            const baseText = applyRebases(supplied.raw, baseVerdict.rebases);
            const baseName = baseText.slice(0, baseText.search(/[\s={[:,;]|$/));
            if (
                comparable(member.key, member.name, normalizeMemberText(rebased)) !==
                comparable(member.key, baseName, normalizeMemberText(baseText))
            ) {
                continue;
            }
            const from = supplied.fsPath.split(/[\\/]/).pop() ?? supplied.fsPath;
            errors.push({
                message: l10n.t(
                    "'{0}' already has this value in {1}, which this group inherits, so writing it again changes nothing.",
                    member.name,
                    from
                ),
                node: container.identifier ?? container,
                range: { start: member.start, end: member.end },
                severity: 'hint',
                unnecessary: true,
                data: {
                    remove: { title: l10n.t("Remove '{0}'", member.name), start: member.start, end: member.end },
                },
            });
        }
    }
    return errors;
};
