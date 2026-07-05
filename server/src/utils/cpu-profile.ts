import { Session } from 'inspector';
import { writeFile } from 'fs/promises';
import { join } from 'path';

// Scan-scoped CPU profiling, enabled by setting COSMOTEER_CPU_PROF to a directory. The profile
// covers exactly one workspace scan (not startup indexing), and is written through the inspector
// API rather than --cpu-prof, whose write is skipped by the language server's process.exit path.
// Used by the scan bench to attribute scan cost precisely; off in normal operation.

let session: Session | undefined;
let profileIndex = 0;

/** Starts a CPU profile when COSMOTEER_CPU_PROF is set, else does nothing. */
export const startScanCpuProfile = (): void => {
    if (!process.env.COSMOTEER_CPU_PROF || session) return;
    session = new Session();
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.start');
};

/**
 * Stops the running profile and writes it as `scan-<n>.cpuprofile` into the configured directory.
 *
 * @returns once the profile is written (or immediately when profiling is off).
 */
export const stopScanCpuProfile = async (): Promise<void> => {
    const dir = process.env.COSMOTEER_CPU_PROF;
    const active = session;
    if (!dir || !active) return;
    session = undefined;
    const profile = await new Promise<unknown>((resolve) => {
        active.post('Profiler.stop', (err, result) => resolve(err ? undefined : result.profile));
    });
    active.disconnect();
    if (!profile) return;
    await writeFile(join(dir, `scan-${profileIndex++}.cpuprofile`), JSON.stringify(profile)).catch(() => undefined);
};
