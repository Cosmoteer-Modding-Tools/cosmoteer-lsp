/**
 * Error thrown when an operation is requested to cancelled trough a cancellation token.
 */
export class CancellationError extends Error {
    constructor() {
        super('Operation was cancelled');
        this.name = 'CancellationError';
    }
}
