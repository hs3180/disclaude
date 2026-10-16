/**
 * A provider has confirmed that a live instruction was not accepted.
 * Hosts may enqueue it once. Timeouts, lost acknowledgements and ambiguous
 * backend failures must retain their original error instead of using this type.
 */
export class LiveInputRejectedError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'LiveInputRejectedError';
    }
}
