import { globalSettings } from '../settings';

/**
 * Error thrown when an operation is requested to cancelled trough a cancellation token.
 */
export class CancellationError extends Error {
    constructor() {
        super('Operation was cancelled');
        this.name = 'CancellationError';
    }
}

/**
 * Logs a failure to the server console while the client asked for message tracing, ignoring the
 * cancellation an outdated request raises on its way out.
 * @param e The value a request handler caught.
 * @returns Nothing.
 */
export const traceFailure = (e: unknown): void => {
    if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
};
