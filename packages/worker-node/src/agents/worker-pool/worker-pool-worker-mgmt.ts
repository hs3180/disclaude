/**
 * Worker Pool Worker Management - Worker CRUD operations and status tracking.
 *
 * Contains functions for creating, disposing, and querying worker handles.
 *
 * Extracted from worker-pool.ts as part of Issue #2345 Phase 4.
 *
 * @module agents/worker-pool/worker-pool-worker-mgmt
 */

import { randomUUID } from 'crypto';
import type {
  WorkerHandle,
  WorkerOptions,
  WorkerStatus,
  WorkerType,
  WorkerPoolConfig,
} from './types.js';
import type { EmitData } from './worker-pool-health.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Context for worker management operations.
 */
export interface WorkerMgmtContext {
  /** Pool configuration */
  config: Required<WorkerPoolConfig>;
  /** Emit pool event */
  emit(type: string, data?: EmitData): void;
}

// ============================================================================
// Worker Creation
// ============================================================================

/**
 * Create a new worker handle.
 *
 * Generates a unique worker ID and initializes the handle with
 * default values based on pool configuration and provided options.
 *
 * @param ctx - Worker management context
 * @param workers - Workers map to register the handle in
 * @param options - Optional worker configuration
 * @returns The created worker handle
 */
export function createWorkerHandle(
  ctx: WorkerMgmtContext,
  workers: Map<string, WorkerHandle>,
  options?: Partial<WorkerOptions>,
): WorkerHandle {
  const workerId = options?.id ?? `worker-${randomUUID().slice(0, 8)}`;
  const workerType: WorkerType = options?.type ?? 'general';

  const handle: WorkerHandle = {
    id: workerId,
    type: workerType,
    skillName: options?.skillName,
    maxConcurrent: options?.maxConcurrent ?? 1,
    defaultTimeout: options?.defaultTimeout ?? ctx.config.defaultTimeout,
    status: 'idle',
    currentTaskIds: [],
    createdAt: new Date(),
    stats: {
      tasksCompleted: 0,
      tasksFailed: 0,
      totalExecutionTime: 0,
      averageExecutionTime: 0,
    },
  };

  workers.set(workerId, handle);
  ctx.emit('worker:created', { workerId });

  return handle;
}

// ============================================================================
// Worker Query
// ============================================================================

/**
 * Find an idle worker from the workers map.
 *
 * @param workers - Workers map
 * @returns First idle worker or undefined
 */
export function findIdleWorker(workers: Map<string, WorkerHandle>): WorkerHandle | undefined {
  return Array.from(workers.values()).find(w => w.status === 'idle');
}

/**
 * Get all idle workers from the workers map.
 *
 * @param workers - Workers map
 * @returns Array of idle workers
 */
export function getIdleWorkers(workers: Map<string, WorkerHandle>): WorkerHandle[] {
  return Array.from(workers.values()).filter(w => w.status === 'idle');
}

/**
 * Update a worker's status and emit the appropriate event.
 *
 * @param workers - Workers map
 * @param workerId - Worker ID to update
 * @param status - New status
 * @param emit - Event emitter function
 */
export function updateWorkerStatus(
  workers: Map<string, WorkerHandle>,
  workerId: string,
  status: WorkerStatus,
  emit: (type: string, data?: EmitData) => void,
): void {
  const worker = workers.get(workerId);
  if (!worker) { return; }

  worker.status = status;
  worker.stats.lastActivityAt = new Date();

  const eventType = status === 'idle' ? 'worker:idle' : 'worker:busy';
  emit(eventType, { workerId });
}

// ============================================================================
// Worker Lifecycle
// ============================================================================

/**
 * Ensure minimum number of idle workers are maintained.
 *
 * Creates new general workers if the count of idle workers
 * is below the configured minimum.
 *
 * @param ctx - Worker management context
 * @param workers - Workers map
 * @param minIdle - Minimum idle workers to maintain
 */
export function ensureMinIdleWorkers(
  ctx: WorkerMgmtContext,
  workers: Map<string, WorkerHandle>,
  minIdle: number,
): void {
  const idleCount = getIdleWorkers(workers).length;
  const needed = minIdle - idleCount;

  for (let i = 0; i < needed; i++) {
    createWorkerHandle(ctx, workers, { type: 'general' });
  }
}
