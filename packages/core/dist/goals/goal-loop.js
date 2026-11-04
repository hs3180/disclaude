/**
 * One sequential driver per explicitly started goal in its owning service.
 * Persistence, user authorization/controls and native execution are adapters;
 * this does not activate goals or restore them automatically after restart.
 */
export class GoalLoop {
    port;
    runs = new Map();
    constructor(port) {
        this.port = port;
    }
    start(id) {
        if (!id.trim() || id.length > 512) {
            throw new Error('Invalid goal ID');
        }
        const existing = this.runs.get(id);
        if (existing) {
            return existing;
        }
        const controller = new AbortController();
        let settle;
        const handle = { completion: new Promise(resolve => { settle = resolve; }), stop: () => controller.abort() };
        this.runs.set(id, handle);
        void this.advance(id, controller.signal).then(outcome => {
            if (this.runs.get(id) === handle) {
                this.runs.delete(id);
            }
            settle(outcome);
        });
        return handle;
    }
    async advance(id, signal) {
        try {
            while (!signal.aborted) {
                const snapshot = await this.port.read(id);
                if (signal.aborted) {
                    return { reason: 'stopped' };
                }
                if (!snapshot) {
                    return { reason: 'missing' };
                }
                if (snapshot.id !== id || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || typeof snapshot.status !== 'string') {
                    throw new Error('Invalid goal snapshot');
                }
                if (snapshot.status !== 'active') {
                    return { reason: 'inactive', status: snapshot.status };
                }
                await this.port.runTurn(structuredClone(snapshot), signal);
                // Yield to user input/cancellation even when a local turn settles
                // synchronously. Scheduling fairness is not a polling interval.
                await new Promise(resolve => setImmediate(resolve));
            }
            return { reason: 'stopped' };
        }
        catch (error) {
            return signal.aborted ? { reason: 'stopped', error } : { reason: 'failed', error };
        }
    }
}
