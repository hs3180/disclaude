export function sanitizeLifecycleReason(reason) {
    if (reason === undefined || reason === null) {
        return undefined;
    }
    return String(reason).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 240);
}
