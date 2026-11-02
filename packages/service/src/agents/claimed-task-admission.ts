import { randomUUID } from 'node:crypto';
import type { TaskAdmissionStore, TaskClaimLease, TaskClaimSnapshot, TaskClaimStore } from '@disclaude/core';

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
  start(owner: string, signal?: AbortSignal): ClaimedExecution<T> | Promise<ClaimedExecution<T>>;
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
  return ownClaimedTask(store, { key, revision: expectedRevision + 1, owner: randomUUID(), claimId: randomUUID() }, ports);
}

/** The durable variant saves its private lease before claim/projection I/O.
 * A recovered dispatch can only look up the ACTUAL original native handle or
 * settled result. Absence is uncertainty, never permission to start again.
 */
export async function prepareDurableClaimedTask<T>(options: {
  admissions: TaskAdmissionStore; claims: Pick<TaskClaimStore, 'claim' | 'release'>;
  operationKey: string; fingerprint: string; claimKey: string; expectedClaimRevision: number;
  ports: ClaimedTaskPorts<T> & { recover(nativeId: string): Promise<ClaimedExecution<T> | undefined> };
}): Promise<ReturnType<typeof prepareClaimedTask<T>>> {
  const { admissions, ports } = options;
  await ports.authorize();
  const intent = await admissions.prepare(options.operationKey, options.fingerprint, options.claimKey, options.expectedClaimRevision);
  const attempt = ownClaimedTask(options.claims, intent.claim, { ...ports, start: async (owner, signal) => {
    const dispatch = await admissions.beginDispatch(options.operationKey);
    signal?.throwIfAborted(); await ports.authorize(); signal?.throwIfAborted();
    if (dispatch.dispatch) { return await ports.start(owner, signal); }
    const id = dispatch.record.nativeId;
    const recovered = id ? await ports.recover(id) : undefined;
    if (!recovered || recovered.id !== id) { throw new Error('Original native admission needs reconciliation; work was not repeated'); }
    return recovered;
  } });
  return { owner: attempt.owner, release: attempt.release, start: async signal => {
    const native = await attempt.start(signal);
    // The inner attempt owns this actual handle before persisting its receipt.
    // Even a write failure retains physical cancellation/release settlement.
    await admissions.confirmDispatch(options.operationKey, native.id);
    return native;
  } };
}

function ownClaimedTask<T>(
  store: Pick<TaskClaimStore, 'claim' | 'release'>, savedLease: TaskClaimLease, ports: ClaimedTaskPorts<T>,
): ReturnType<typeof prepareClaimedTask<T>> {
  const lease = structuredClone(savedLease), { key, owner } = lease, expectedRevision = lease.revision - 1;
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
        const started = await ports.start(owner, signal);
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
