/**
 * Codex session/run concurrency governor (Issue #4634, S7 of #4627).
 *
 * Bounds how much of the shared ChatGPT subscription one disclaude process
 * can consume simultaneously — turning the epic's "quota contention" risk
 * into an explicit, configurable policy:
 *
 * - **Session cap** (`agent.codex.maxActiveSessions`, default 3): at most N
 *   concurrently-alive codex sessions (one per chatId's queryStream). When a
 *   NEW session arrives at cap, the IDLEST session is evicted (LRU by last
 *   activity — aligned with ChatAgent's idle cleanup) rather than rejecting
 *   the newcomer: active work always wins over idle sessions.
 *   App-server admissions pin running/queued turns and wait FIFO when all
 *   slots are busy. Only unpinned sessions can be selected as LRU victims.
 * - **Run cap** (`agent.codex.maxConcurrentRuns`, default 2): at most N
 *   `codex exec` children executing at once. Excess turns WAIT in a FIFO
 *   queue (they are per-chatId serial anyway; the queue only interleaves
 *   across chats) — never unbounded process forking.
 *
 * Eviction semantics: the victim's stream is aborted (its next user message
 * starts a new queryStream); the VICTIM'S thread id is handed to the caller
 * via the eviction hook so the provider can stash it — the evicted chat then
 * RESUMES its codex conversation on the next message. Normal teardown
 * (user /reset, idle GC) does NOT stash: reset means reset.
 *
 * Pure in-memory state, no timers: idleness is measured by the last activity
 * TOUCH (any turn boundary), mirroring how the caller drives the session.
 * Instance-scoped on the provider — the factory caches one provider per
 * process, making these limits process-wide by construction.
 */
/** Default caps (#4634): 3 sessions, 2 concurrent exec children. */
export const DEFAULT_MAX_ACTIVE_SESSIONS = 3;
export const DEFAULT_MAX_CONCURRENT_RUNS = 2;
export class CodexSessionGovernor {
    maxActiveSessions;
    maxConcurrentRuns;
    now;
    /** sessionKey → session; Map iteration order = registration order (LRU tie-break). */
    sessions = new Map();
    runningRuns = 0;
    evictedSessions = 0;
    nextRegId = 1;
    sessionWaiters = [];
    admitting = false;
    /** FIFO of waiters: resolve + enqueue position (for the "N ahead" notice). */
    runWaiters = [];
    constructor(options = {}) {
        this.maxActiveSessions = options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
        this.maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
        this.now = options.now ?? Date.now;
    }
    /**
     * Register a session. At cap, the IDLEST session is evicted first
     * (lowest lastActivityAt; registration order breaks ties — oldest wins).
     * Returns an unregister handle that removes ONLY this registration (a
     * chat's dying old stream must not unregister its replacement — cf.
     * ChatAgent's close-old-before-new, #3378).
     */
    registerSession(sessionKey, hooks) {
        let evictedKey;
        if (this.sessions.has(sessionKey)) {
            // Re-registration (stream restart for a known chat) — replace in place.
            this.sessions.delete(sessionKey);
        }
        else {
            // Evict WHILE at cap — a loop, because the cap may have been lowered
            // at runtime below the current session count (setLimits does not
            // proactively evict; the cap re-engages here).
            while (this.sessions.size >= this.maxActiveSessions) {
                const victim = this.evictIdlest();
                if (!victim) {
                    throw new Error('Codex session capacity is busy; use acquireSession');
                }
                evictedKey = victim;
            }
        }
        const regId = this.nextRegId++;
        this.sessions.set(sessionKey, {
            regId,
            busy: hooks.busy ?? false,
            lastActivityAt: this.now(),
            evict: hooks.evict,
        });
        return {
            ...(evictedKey ? { evictedKey } : {}),
            setBusy: (busy) => {
                const current = this.sessions.get(sessionKey);
                if (current?.regId !== regId) {
                    return;
                }
                current.busy = busy;
                current.lastActivityAt = this.now();
                if (!busy) {
                    this.pumpSessions();
                }
            },
            unregister: () => {
                const current = this.sessions.get(sessionKey);
                if (current?.regId === regId) {
                    this.sessions.delete(sessionKey);
                    this.pumpSessions();
                }
            },
        };
    }
    /** Issue #4987: FIFO admission; abort removes the waiter without taking a slot. */
    acquireSession(sessionKey, hooks, signal) {
        return new Promise((resolve, reject) => {
            const abort = () => {
                const index = this.sessionWaiters.indexOf(admit);
                if (index >= 0) {
                    this.sessionWaiters.splice(index, 1);
                }
                reject(new Error('Codex session admission cancelled'));
                this.pumpSessions();
            };
            const admit = () => {
                const busyCount = [...this.sessions.values()].filter(session => session.busy).length;
                if (!this.sessions.has(sessionKey) && busyCount >= this.maxActiveSessions) {
                    return false;
                }
                signal.removeEventListener('abort', abort);
                resolve(this.registerSession(sessionKey, { ...hooks, busy: true }));
                return true;
            };
            if (signal.aborted) {
                abort();
                return;
            }
            signal.addEventListener('abort', abort, { once: true });
            this.sessionWaiters.push(admit);
            this.pumpSessions();
        });
    }
    pumpSessions() {
        if (this.admitting) {
            return;
        }
        this.admitting = true;
        try {
            while (this.sessionWaiters[0]?.()) {
                this.sessionWaiters.shift();
            }
        }
        finally {
            this.admitting = false;
        }
    }
    /** Mark a session active (called at every turn boundary). */
    touchSession(sessionKey) {
        const session = this.sessions.get(sessionKey);
        if (session) {
            session.lastActivityAt = this.now();
        }
    }
    /**
     * Forget a session entirely (Issue #4644): drop its governor registration.
     *
     * Called by the provider's forgetSession on user /reset. Removing the
     * registration is REQUIRED, not hygiene: a still-registered session can be
     * LRU-evicted later, and the eviction hook would re-stash the conversation
     * anchor AFTER the reset already cleared it — resurrecting the conversation
     * the user reset away (the exact #4644 window). Counter stats are
     * cumulative history and stay untouched.
     *
     * @returns true when a live registration was dropped, false when unknown.
     */
    forgetSession(sessionKey) {
        const removed = this.sessions.delete(sessionKey);
        this.pumpSessions();
        return removed;
    }
    /** Evict the idlest session (lowest activity timestamp). */
    evictIdlest() {
        let idlestKey;
        let idlestAt = Infinity;
        for (const [key, session] of this.sessions) {
            if (session.busy) {
                continue;
            }
            // `<` (not `<=`) keeps the OLDEST registration on ties: a session that
            // has been idle equally long but longer-registered goes first.
            if (session.lastActivityAt < idlestAt) {
                idlestAt = session.lastActivityAt;
                idlestKey = key;
            }
        }
        if (idlestKey === undefined) {
            return undefined;
        }
        const victim = this.sessions.get(idlestKey);
        this.sessions.delete(idlestKey);
        this.evictedSessions += 1;
        victim?.evict();
        return idlestKey;
    }
    /**
     * Acquire a run slot; waits (FIFO) while `maxConcurrentRuns` children are
     * executing. Resolves with how many runs were ahead at acquisition time.
     */
    acquireRun() {
        if (this.runningRuns < this.maxConcurrentRuns) {
            return Promise.resolve(this.makeLease(0));
        }
        return new Promise((resolve) => {
            this.runWaiters.push({ resolve, position: this.runWaiters.length });
        });
    }
    makeLease(queuedBehind) {
        this.runningRuns += 1;
        let released = false;
        return {
            queuedBehind,
            release: () => {
                if (released) {
                    return;
                }
                released = true;
                this.runningRuns -= 1;
                this.pumpQueue();
            },
        };
    }
    /** Hand the freed slot to the longest-waiting run, if any. */
    pumpQueue() {
        // RE-CHECK the cap (S7 review): a runtime-lowered cap must not let
        // every release refill concurrency back to the old level.
        if (this.runningRuns >= this.maxConcurrentRuns) {
            return;
        }
        const next = this.runWaiters.shift();
        if (!next) {
            return;
        }
        next.resolve(this.makeLease(next.position));
    }
    getStats() {
        return {
            activeSessions: this.sessions.size,
            runningRuns: this.runningRuns,
            queuedRuns: this.runWaiters.length,
            evictedSessions: this.evictedSessions,
            maxActiveSessions: this.maxActiveSessions,
            maxConcurrentRuns: this.maxConcurrentRuns,
        };
    }
    /**
     * Runtime limit change (test/admin surface). Lowering the session cap
     * does NOT proactively evict — the cap re-engages on the next
     * registration; run cap applies to future acquisitions immediately.
     */
    setLimits(limits) {
        // Same fail-closed contract as config-load validation (S7 review): a
        // zero session cap would spin registerSession's eviction loop forever
        // (evictIdlest returns undefined on an empty map) on the SYNCHRONOUS
        // queryStream path — an event-loop freeze; a zero run cap queues every
        // turn forever.
        for (const [name, value] of [
            ['maxActiveSessions', limits.maxActiveSessions],
            ['maxConcurrentRuns', limits.maxConcurrentRuns],
        ]) {
            if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
                throw new Error(`CodexSessionGovernor.setLimits: ${name} must be a positive number (got ${value})`);
            }
        }
        if (limits.maxActiveSessions !== undefined) {
            this.maxActiveSessions = limits.maxActiveSessions;
        }
        if (limits.maxConcurrentRuns !== undefined) {
            this.maxConcurrentRuns = limits.maxConcurrentRuns;
        }
        this.pumpSessions();
    }
}
