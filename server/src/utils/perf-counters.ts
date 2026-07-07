// Always-on counters for the hot paths of whole-workspace scans and reference resolution. The
// counts answer the questions a wall-clock number cannot: how many stat syscalls a warm scan still
// pays, how often the same reference is re-resolved, and how often the schema memo epoch is bumped.
// Incrementing a map entry is orders of magnitude cheaper than any of the counted operations, so
// the counters stay on in production builds. The scan bench (server/test/perf/scan-bench.mjs)
// reads them through the custom `cosmoteer/perfStats` request.

const counters: Map<string, number> = new Map();

let peakHeapBytes = 0;

/**
 * Increments a named counter.
 *
 * @param name the counter to increment.
 * @param by the amount to add, 1 when omitted.
 */
export const perfCount = (name: string, by = 1): void => {
    counters.set(name, (counters.get(name) ?? 0) + by);
};

/**
 * Samples the current heap usage into the peak-heap watermark. Called from per-file loops (the
 * workspace scan) so the watermark reflects the scan's real high point, not just its end state.
 */
export const perfSampleMemory = (): void => {
    const used = process.memoryUsage().heapUsed;
    if (used > peakHeapBytes) peakHeapBytes = used;
};

/**
 * Snapshots all counters and the peak-heap watermark.
 *
 * @returns the counter values and the highest sampled heap usage in bytes.
 */
export const perfSnapshot = (): { counters: Record<string, number>; peakHeapBytes: number } => ({
    counters: Object.fromEntries(counters),
    peakHeapBytes,
});

/** Resets all counters and the peak-heap watermark. */
export const perfReset = (): void => {
    counters.clear();
    peakHeapBytes = 0;
};
