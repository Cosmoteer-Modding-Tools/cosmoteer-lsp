import { getHeapStatistics, setFlagsFromString } from 'v8';
import { runInNewContext } from 'vm';
import { describe, expect, it } from 'vitest';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { Validator } from '../../src/features/diagnostics/validator';
import { ValidationForValue } from '../../src/features/diagnostics/validator.value';
import { ValidationForAssignment } from '../../src/features/diagnostics/validator.assignment';
import { ValidationForMath } from '../../src/features/diagnostics/validator.math';
import { ValidationForGroupDuplicates } from '../../src/features/diagnostics/validator.duplicate-key';
import { CancellationToken } from 'vscode-languageserver';

// The whole-workspace scan validates thousands of files whose ASTs must be discarded after their
// diagnostics are published (validateTextDocument `persist: false`). This test runs the scan's
// per-file core (lex, parse, validate, drop) over many synthetic documents and bounds the heap
// growth, so a change that starts retaining per-file state (an unbounded cache keyed by AST or
// uri, a registrar entry for unopened files) fails here instead of exhausting a user's machine.
// The bound is deliberately generous: it must survive GC lag and suite parallelism in CI while
// still catching wholesale retention, which would grow by hundreds of megabytes.

/** How many synthetic documents to push through the scan core. */
const FILE_COUNT = 1_500;

/** How many documents to run before taking the baseline, so allocator warm-up (lazy imports,
 *  inline caches, initial GC hysteresis) does not count as growth. */
const WARMUP_COUNT = 100;

/** Allowed post-collection heap growth across the run. Retaining the measured documents' ASTs
 *  would cost several hundred megabytes, so this bound catches even partial retention while
 *  leaving generous room for allocator noise. */
const MAX_HEAP_GROWTH_BYTES = 100 * 1024 * 1024;

/** The current isolate's used heap. Per-isolate (unlike process.memoryUsage), so parallel vitest
 *  workers in the same process cannot leak their allocations into this measurement. */
const usedHeap = (): number => getHeapStatistics().used_heap_size;

/**
 * A real garbage collection, so the measurement sees retained objects rather than floating
 * garbage. A reused suite worker arrives with a grown old generation where V8 defers major GC,
 * which made this test fail on uncollected garbage only when run inside the full suite. The test
 * runner does not pass --expose-gc, so the collector is obtained through the v8 flag escape hatch.
 *
 * @returns once the isolate has collected.
 */
const forceGc = (): void => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    gc();
    setFlagsFromString('--no-expose-gc');
};

/**
 * Builds one synthetic `.rules` document with groups, references, math, and lists, sized so that
 * retaining every parsed AST would visibly move the heap.
 *
 * @param index the file's index, varied into names so documents are not identical.
 * @returns the document text.
 */
const syntheticDocument = (index: number): string => {
    const lines: string[] = [`Part_${index}`, '{', `\tID = Mod.Part${index}`, '\tComponents', '\t{'];
    for (let member = 0; member < 60; member++) {
        lines.push(`\t\tComponent${member}_${index}`);
        lines.push('\t\t{');
        lines.push(`\t\t\tValue = ${member * 3}`);
        lines.push(`\t\t\tScaled = ${member} * 2.5`);
        lines.push('\t\t\tRef = &Value');
        lines.push(`\t\t\tList = [${member}, ${member + 1}, ${member + 2}]`);
        lines.push('\t\t}');
    }
    lines.push('\t}', '}');
    return lines.join('\n');
};

describe('scan memory', () => {
    // The generous timeout covers CPU contention when the whole suite runs in parallel workers.
    it('does not retain the ASTs of scanned documents', { timeout: 60_000 }, async () => {
        Validator.instance.registerValidation(ValidationForValue);
        Validator.instance.registerValidation(ValidationForAssignment);
        Validator.instance.registerValidation(ValidationForMath);
        Validator.instance.registerValidation(ValidationForGroupDuplicates);

        const scanOne = async (index: number): Promise<void> => {
            const parserResult = parser(lexer(syntheticDocument(index)), `file:///scan-mem/f${index}.rules`);
            for (const node of parserResult.value.elements) {
                await Validator.instance.validate(node, CancellationToken.None);
            }
        };

        for (let index = 0; index < WARMUP_COUNT; index++) await scanOne(index);
        forceGc();
        const heapBefore = usedHeap();
        for (let index = WARMUP_COUNT; index < FILE_COUNT; index++) await scanOne(index);
        forceGc();
        const heapAfter = usedHeap();

        expect(heapAfter - heapBefore).toBeLessThan(MAX_HEAP_GROWTH_BYTES);
    });
});
