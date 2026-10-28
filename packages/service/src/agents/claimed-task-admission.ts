import { randomUUID } from 'node:crypto';
import type { TaskClaimLease, TaskClaimSnapshot, TaskClaimStore } from '@disclaude/core';

export interface ClaimedExecution<T> {
  readonly id: string;
  /** Physical settlement, including native background work and callbacks. */
  readonly completion: Promise<T>;
  stop(): void;
}
export interface ClaimedTaskPorts<T> {
  authorize(): void | Promise<void>;
  /** Reconcile by known remote record ID before writing on an unknown ACK.
   * Resolve only after the exact owner/revision is confirmed remotely.
   * A normal Base update is a projection, never the atomic claim authority.
   */
  ensureProjection(claim: Readonly<TaskClaimSnapshot>): Promise<void>;
  /** Called at most once. Throwing leaves execution uncertain, never replayed. */
  start(owner: string): ClaimedExecution<T>;
}

/** Host-only prepared attempt; IDs/credentials are generated before any I/O.
 * The owning service must authorize and bind its canonical task key. This
 * neither accepts model identities nor restores attempts after a restart.
 */
export function prepareClaimedTask<T>(
  store: Pick<TaskClaimStore, 'claim' | 'release'>,
  key: string,
  expectedRevision: number,
  ports: ClaimedTaskPorts<T>,
): {
  readonly owner: string;
  start(signal?: AbortSignal): Promise<ClaimedExecution<T>>;
  release(): Promise<TaskClaimSnapshot>;
} {
  if (typeof key !== 'string' || !key.trim() || key.length > 2048 ||
    !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid canonical task claim or revision');
  }
  const owner = randomUUID();
  const lease: TaskClaimLease = { key, revision: expectedRevision + 1, owner, claimId: randomUUID() };
  let flight: Promise<ClaimedExecution<T>> | undefined;
  let execution: ClaimedExecution<T> | undefined;
  let startAttempted = false;
  let releaseRequested = false;
  let releaseFlight: Promise<TaskClaimSnapshot> | undefined;
  const check = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted(); await ports.authorize(); signal?.throwIfAborted();
    if (releaseRequested) { throw new Error('Task claim release has been requested'); }
  };
  return {
    owner,
    start: async signal => {
      if (releaseRequested) { throw new Error('Task claim release has been requested'); }
      if (flight) { await check(signal); return await flight; }
      if (startAttempted) { throw new Error('Native start outcome is uncertain; reconcile instead of repeating it'); }
      const admission = (async (): Promise<ClaimedExecution<T>> => {
        await check(signal);
        await store.claim(key, expectedRevision, owner, lease.claimId);
        await check(signal);
        await ports.ensureProjection(Object.freeze({ key, revision: lease.revision, owner }));
        await check(signal);
        startAttempted = true;
        const started = ports.start(owner);
        if (!started || typeof started.id !== 'string' || !started.id || !started.completion || typeof started.stop !== 'function') {
          throw new Error('Native start returned no owned execution; reconcile the uncertain attempt');
        }
        // Attach rejection handling without claiming that work has settled early.
        void started.completion.catch(() => {});
        execution = Object.freeze({ id: started.id, completion: started.completion, stop: started.stop.bind(started) });
        return execution;
      })();
      flight = admission;
      try { return await admission; }
      finally { if (!execution && flight === admission) { flight = undefined; } }
    },
    release: () => {
      releaseRequested = true;
      releaseFlight ??= (async () => {
        await flight?.catch(() => {});
        if (startAttempted && !execution) { throw new Error('Cannot release while native execution is uncertain'); }
        if (execution) { await execution.completion.catch(() => {}); }
        await ports.authorize();
        return await store.release({ ...lease });
      })();
      // Failed release may have committed. Reconcile the same lease on retry.
      const result = releaseFlight;
      void result.catch(() => { if (releaseFlight === result) { releaseFlight = undefined; } });
      return result;
    },
  };
}
