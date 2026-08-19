import { dirname, relative } from 'path';
import { BaseTarget } from './base-index';
import { ExtractionPlan } from './plan.types';
import { analyzeReferences, applyRebases } from './reference-safety';

/** The indentation the game's own `.rules` files use, which the generated base file matches. */
const INDENT = '\t';

/**
 * An inheritance reference naming a group inside another file, in the spelling the game's own data
 * uses (`<../base_part_terran.rules>/Part`, with no leading `&`, and forward slashes on every OS).
 *
 * @param fromDir the directory of the file the reference is written in.
 * @param toFile the on-disk path of the file being referenced.
 * @param member the name of the group inside that file, omitted to reference the file itself.
 * @returns the reference text.
 */
export const relativeRulesReference = (fromDir: string, toFile: string, member?: string): string => {
    const rel = relative(fromDir, toFile).replace(/\\/g, '/');
    return `<${rel}>${member ? `/${member}` : ''}`;
};

/**
 * Re-indent a member's source for its new depth: the first line carries no indentation (the span
 * starts at the name), and every continuation line carries the depth it had in the file it came
 * from, which is replaced by the target depth.
 *
 * @param raw the member's source.
 * @param sourceIndent the indentation of the line the member was written on.
 * @param targetIndent the indentation it gets in the base file.
 * @returns the re-indented source, with `\n` line endings.
 */
export const reindent = (raw: string, sourceIndent: string, targetIndent: string): string =>
    raw
        .split('\n')
        .map((line, index) => {
            const body = line.replace(/\r$/, '');
            if (index === 0) return targetIndent + body;
            const dedented = body.startsWith(sourceIndent)
                ? body.slice(sourceIndent.length)
                : body.replace(/^[ \t]+/, '');
            return dedented.length === 0 ? '' : targetIndent + dedented;
        })
        .join('\n');

/**
 * The full text of the base file a plan creates: the extracted group, carrying over whatever the
 * participants inherited, with every moved member written in the donor's own spelling and its file
 * paths re-expressed relative to the base file's own directory.
 *
 * @param plan the plan to emit.
 * @param lineEnding the ending to write, so a base file added to a mod written with `\r\n` does not
 * arrive with a different one than every file around it.
 * @returns the file's contents, newline terminated.
 */
export const buildBaseFileText = (plan: ExtractionPlan, lineEnding: '\n' | '\r\n' = '\n'): string => {
    const head = plan.inheritedRef ? `${plan.groupName} : ${plan.inheritedRef}` : plan.groupName;
    const lines: string[] = [head, '{', ...movedMemberLines(plan, dirname(plan.baseFsPath), INDENT), '}', ''];
    return lines.join('\n').split('\n').join(lineEnding);
};

/**
 * The text inserted into a base file that already exists, when the fields move onto the base the
 * participants already inherit rather than into a new one.
 *
 * The insertion point sits just past the group's last member, so the text opens its own line and the
 * closing brace stays where the author put it.
 *
 * @param plan the plan being applied.
 * @param target the resolved group in the existing base file.
 * @param lineEnding the ending the base file already uses, so the insert matches it.
 * @returns the text to insert at the target's insertion offset.
 */
export const buildBaseInsertText = (
    plan: ExtractionPlan,
    target: BaseTarget,
    lineEnding: '\n' | '\r\n' = '\n'
): string => {
    const lines = movedMemberLines(plan, dirname(target.fsPath), target.indent);
    return lines.length === 0 ? '' : ['', ...lines].join('\n').split('\n').join(lineEnding);
};

/**
 * The moved members in the donor's spelling, re-indented for their new home and with every file path
 * re-expressed relative to it.
 *
 * @param plan the plan being applied.
 * @param baseDir the directory the members end up in.
 * @param indent the indentation they are written with.
 * @returns one entry per member, each possibly several lines, with `\n` line endings.
 */
const movedMemberLines = (plan: ExtractionPlan, baseDir: string, indent: string): string[] => {
    const donorDir = dirname(plan.donor.fsPath);
    const lines: string[] = [];
    for (const key of plan.fields) {
        const member = plan.donor.members.get(key);
        if (!member) continue;
        const verdict = analyzeReferences(member.raw, donorDir, baseDir);
        const moved = verdict.safe ? applyRebases(member.raw, verdict.rebases) : member.raw;
        lines.push(reindent(moved, member.indent, indent));
    }
    return lines;
};
