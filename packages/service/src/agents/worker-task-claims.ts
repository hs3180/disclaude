import { randomUUID } from 'node:crypto';
import type { TaskClaimLease, TaskClaimSnapshot, TaskClaimStore, ToolDefinition } from '@disclaude/core';

export interface WorkerClaimTask { readonly id: string; readonly key: string }
export interface ClaimWorker {
  /** Host-created native execution ID; never an owner supplied by the model. */
  readonly id: string;
  /** Must settle after the native query, background work and callbacks drain. */
  readonly completion: Promise<unknown>;
}
export interface WorkerTaskClaimsOptions {
  store: Pick<TaskClaimStore, 'get' | 'claim' | 'release'>;
  worker: ClaimWorker;
  tasks: readonly WorkerClaimTask[];
  /** The service checks current task/Project permission on every operation. */
  authorize(task: Readonly<WorkerClaimTask>): void | Promise<void>;
}
const valid = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;

/** One host-bound worker capability. Only read/claim is exposed to its model;
 * explicit release remains with the host and waits for physical settlement.
 * New process/worker identities cannot adopt previous held claims.
 */
export function createWorkerTaskClaims(options: WorkerTaskClaimsOptions): {
  tool: ToolDefinition; release(taskId: string): Promise<TaskClaimSnapshot>;
} {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(options.worker.id)) {
    throw new Error('Task claims require a host-created worker execution ID');
  }
  const owner = options.worker.id;
  const tasks = new Map<string, Readonly<WorkerClaimTask>>();
  for (const task of options.tasks) {
    if (!valid(task.id, 256) || !valid(task.key, 2048) || tasks.has(task.id) || [...tasks.values()].some(value => value.key === task.key)) {
      throw new Error('Task claim scope must have unique task IDs and canonical resource keys');
    }
    tasks.set(task.id, Object.freeze({ id: task.id, key: task.key }));
  }
  let settled = false;
  const completion = options.worker.completion.then(() => { settled = true; }, () => { settled = true; });
  // Retain the predicted lease BEFORE publishing. A failed/lost ACK can still
  // have committed, so the host can reconcile or release the exact attempt.
  const attempts = new Map<string, { expected: number; lease: TaskClaimLease }>();
  const taskFor = (id: unknown): Readonly<WorkerClaimTask> => {
    const task = typeof id === 'string' ? tasks.get(id) : undefined;
    if (!task) { throw new Error('Task is outside this worker scope'); }
    return task;
  };
  const authorize = async (task: Readonly<WorkerClaimTask>): Promise<void> => { await options.authorize(task); };
  const tool: ToolDefinition = {
    name: 'board_task_claim',
    description: 'Read or claim an allowed board task before working. Use its current revision. Only a successful claim grants ownership; failure or an unknown acknowledgement does not. Owner and resource are bound by the host. Release is performed by the host after this worker settles.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'taskId'], properties: {
      action: { type: 'string', enum: ['get', 'claim'] }, taskId: { type: 'string', minLength: 1, maxLength: 256 },
      expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
    } },
    outputSchema: { type: 'object', additionalProperties: false, required: ['taskId', 'revision'], properties: {
      taskId: { type: 'string' }, revision: { type: 'integer', minimum: 0 }, owner: { type: 'string' },
    } },
    execute: async (input, context) => {
      if (Object.keys(input).some(name => !['action', 'taskId', 'expectedRevision'].includes(name)) ||
        !['get', 'claim'].includes(input.action as string)) { throw new Error('Invalid task claim operation'); }
      const task = taskFor(input.taskId);
      context.signal.throwIfAborted(); await authorize(task); context.signal.throwIfAborted();
      if (settled) { throw new Error('Worker has already settled'); }
      let snapshot: TaskClaimSnapshot;
      if (input.action === 'get') { snapshot = await options.store.get(task.key); }
      else {
        const expected = input.expectedRevision;
        if (!Number.isSafeInteger(expected) || (expected as number) < 0 || (expected as number) >= Number.MAX_SAFE_INTEGER) {
          throw new Error('Claim requires the current task revision');
        }
        let attempt = attempts.get(task.id);
        if (attempt && attempt.expected !== expected) { throw new Error('Retry the original claim revision or reconcile the held attempt'); }
        if (!attempt) {
          attempt = { expected: expected as number, lease: { key: task.key, revision: (expected as number) + 1, owner, claimId: randomUUID() } };
          attempts.set(task.id, attempt);
        }
        snapshot = await options.store.claim(task.key, attempt.expected, owner, attempt.lease.claimId);
      }
      await authorize(task);
      context.signal.throwIfAborted();
      return { taskId: task.id, revision: snapshot.revision, ...(snapshot.owner ? { owner: snapshot.owner } : {}) };
    },
  };
  return { tool, release: async taskId => {
    const task = taskFor(taskId);
    await completion; await authorize(task);
    const attempt = attempts.get(task.id);
    if (!attempt) { throw new Error('This worker has no claim attempt to release'); }
    return await options.store.release({ ...attempt.lease });
  } };
}
