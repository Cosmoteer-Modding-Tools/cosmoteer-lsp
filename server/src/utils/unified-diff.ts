/** How many unchanged lines are shown around each change, the number `git diff` uses. */
const CONTEXT_LINES = 3;

/**
 * The largest line-pair product the exact comparison is run over. Past it the changed region is
 * reported as one wholesale replacement, which is still a truthful diff and keeps a pathological
 * file from stalling the preview.
 */
const MAX_COMPARISON_CELLS = 4_000_000;

/** One line of the edit script the hunks are cut out of. */
interface Step {
    kind: ' ' | '-' | '+';
    text: string;
}

/**
 * A file's lines, with line endings normalized and the final newline dropped, so a file ending in a
 * newline does not produce a phantom empty last line on both sides of every diff.
 *
 * @param text the file's contents.
 * @returns the lines.
 */
const splitLines = (text: string): string[] => {
    const normalized = text.replace(/\r\n/g, '\n');
    const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
    return body.length === 0 ? [] : body.split('\n');
};

/**
 * The longest common subsequence of two line arrays, as the edit script that turns the first into
 * the second.
 *
 * @param before the original lines.
 * @param after the rewritten lines.
 * @returns the steps, in output order.
 */
const editScript = (before: readonly string[], after: readonly string[]): Step[] => {
    if (before.length * after.length > MAX_COMPARISON_CELLS) {
        return [
            ...before.map((text): Step => ({ kind: '-', text })),
            ...after.map((text): Step => ({ kind: '+', text })),
        ];
    }
    // lengths[i][j] is the length of the longest common subsequence of before[i..] and after[j..].
    const lengths: number[][] = Array.from({ length: before.length + 1 }, () =>
        new Array<number>(after.length + 1).fill(0)
    );
    for (let i = before.length - 1; i >= 0; i--) {
        for (let j = after.length - 1; j >= 0; j--) {
            lengths[i][j] =
                before[i] === after[j]
                    ? lengths[i + 1][j + 1] + 1
                    : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
        }
    }
    const steps: Step[] = [];
    let i = 0;
    let j = 0;
    while (i < before.length && j < after.length) {
        if (before[i] === after[j]) {
            steps.push({ kind: ' ', text: before[i] });
            i++;
            j++;
        } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
            steps.push({ kind: '-', text: before[i] });
            i++;
        } else {
            steps.push({ kind: '+', text: after[j] });
            j++;
        }
    }
    for (; i < before.length; i++) steps.push({ kind: '-', text: before[i] });
    for (; j < after.length; j++) steps.push({ kind: '+', text: after[j] });
    return steps;
};

/** The index ranges of the edit script that hold a change, each already padded with its context. */
const hunkRanges = (steps: readonly Step[], context: number): Array<{ start: number; end: number }> => {
    const ranges: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < steps.length; index++) {
        if (steps[index].kind === ' ') continue;
        const start = Math.max(0, index - context);
        const end = Math.min(steps.length, index + context + 1);
        const last = ranges[ranges.length - 1];
        // Two changes closer than twice the context share one hunk, so the diff does not repeat the
        // lines between them.
        if (last && start <= last.end) last.end = Math.max(last.end, end);
        else ranges.push({ start, end });
    }
    return ranges;
};

/**
 * The unified diff between two versions of one file, in the format `git diff` prints and every
 * editor highlights.
 *
 * @param before the file's current contents, empty when the file is being created.
 * @param after the file's contents after the change.
 * @param label the path shown in the `---`/`+++` header, usually relative to the project.
 * @param context how many unchanged lines to show around each change.
 * @returns the diff, newline terminated, or the empty string when the two texts are identical.
 */
export const unifiedDiff = (before: string, after: string, label: string, context = CONTEXT_LINES): string => {
    if (before === after) return '';
    const beforeLines = splitLines(before);
    const afterLines = splitLines(after);
    const steps = editScript(beforeLines, afterLines);
    const ranges = hunkRanges(steps, context);
    if (ranges.length === 0) return '';

    const lines: string[] = [`--- a/${label}`, `+++ b/${label}`];
    // The line numbers the hunk headers carry are counted by walking the whole script, since a hunk
    // only knows where it starts in the script and not which source lines that is.
    let beforeLine = 1;
    let afterLine = 1;
    let cursor = 0;
    for (const range of ranges) {
        for (; cursor < range.start; cursor++) {
            if (steps[cursor].kind !== '+') beforeLine++;
            if (steps[cursor].kind !== '-') afterLine++;
        }
        let beforeCount = 0;
        let afterCount = 0;
        const body: string[] = [];
        for (let index = range.start; index < range.end; index++) {
            const step = steps[index];
            if (step.kind !== '+') beforeCount++;
            if (step.kind !== '-') afterCount++;
            body.push(`${step.kind}${step.text}`);
        }
        lines.push(
            `@@ -${beforeCount === 0 ? beforeLine - 1 : beforeLine},${beforeCount} ` +
                `+${afterCount === 0 ? afterLine - 1 : afterLine},${afterCount} @@`,
            ...body
        );
    }
    return `${lines.join('\n')}\n`;
};
