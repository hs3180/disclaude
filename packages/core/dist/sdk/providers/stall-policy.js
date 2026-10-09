/** Shared timeout policy for the provider-local watchdogs (#3706, #4813).
 * Progress detection and cancellation remain owned by each provider.
 */
export function readStallPolicy(env = process.env) {
    const positive = (value, fallback) => {
        const parsed = Number.parseInt(value ?? '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    return {
        timeoutMs: positive(env.DISCLAUDE_STALL_TIMEOUT_MS, 180_000),
        graceMs: positive(env.DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS, 5_000),
    };
}
