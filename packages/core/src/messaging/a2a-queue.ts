/**
 * A2A Task Queue — In-memory queue for Agent-to-Agent task delegation.
 *
 * Provides:
 * - Per-target queuing with priority ordering
 * - Rate limiting per source chatId
 * - Anti-recursion protection
 * - Source traceability
 *
 * Issue #3334: A2A messaging — Agent-to-Agent task delegation.
 */

import { createLogger, type Logger } from '../utils/logger.js';
import {
  generateTaskId,
  type A2ATask,
  type A2APriority,
  type A2AProjectResolver,
  type EnqueueTaskParams,
  type EnqueueTaskResult,
} from './a2a-types.js';

const defaultLogger = createLogger('A2AQueue');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Priority Ordering
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PRIORITY_ORDER: Record<A2APriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Rate Limit Tracker
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Tracks A2A task counts per source chatId within a time window.
 */
class RateLimitTracker {
  private readonly counts = new Map<string, number[]>();
  private readonly maxTasks: number;
  private readonly windowMs: number;

  constructor(config: { maxTasks: number; windowMs: number }) {
    this.maxTasks = config.maxTasks;
    this.windowMs = config.windowMs;
  }

  /**
   * Check if the source chatId is within rate limits.
   * Also prunes expired entries.
   */
  isWithinLimit(sourceChatId: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.counts.get(sourceChatId);
    if (!timestamps) {
      return true;
    }

    // Prune expired timestamps
    timestamps = timestamps.filter(t => t > cutoff);
    this.counts.set(sourceChatId, timestamps);

    return timestamps.length < this.maxTasks;
  }

  /**
   * Record a task from the given source chatId.
   */
  record(sourceChatId: string): void {
    const now = Date.now();
    let timestamps = this.counts.get(sourceChatId);
    if (!timestamps) {
      timestamps = [];
      this.counts.set(sourceChatId, timestamps);
    }
    timestamps.push(now);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// A2A Queue
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Callback for delivering A2A tasks to target agents.
 */
export type A2ADeliveryCallback = (targetChatId: string, task: A2ATask) => Promise<boolean>;

/**
 * Configuration for A2AQueue.
 */
export interface A2AQueueConfig {
  /** Project key resolver */
  projectResolver: A2AProjectResolver;
  /** Rate limit configuration */
  rateLimit?: { maxTasks: number; windowMs: number };
  /** Delivery callback */
  onDeliver?: A2ADeliveryCallback;
  /** Logger */
  logger?: Logger;
}

/**
 * A2AQueue — Manages Agent-to-Agent task delegation.
 *
 * Thread-safety: This class is designed for single-process use
 * (all agents run in the same primary node process).
 */
export class A2AQueue {
  private readonly projectResolver: A2AProjectResolver;
  private readonly rateLimiter: RateLimitTracker;
  private readonly deliveryCallback: A2ADeliveryCallback | undefined;
  private readonly log: Logger;

  /** Per-target queues: targetChatId → sorted A2ATask[] */
  private readonly queues = new Map<string, A2ATask[]>();

  /** Track all tasks by ID for status queries */
  private readonly tasks = new Map<string, A2ATask>();

  constructor(config: A2AQueueConfig) {
    this.projectResolver = config.projectResolver;
    this.rateLimiter = new RateLimitTracker(config.rateLimit ?? { maxTasks: 10, windowMs: 60_000 });
    this.deliveryCallback = config.onDeliver;
    this.log = config.logger ?? defaultLogger;
  }

  /**
   * Enqueue an A2A task from a source agent to a target project agent.
   *
   * This is the main entry point for the enqueue_task tool.
   *
   * @param sourceChatId - The chatId of the agent creating this task
   * @param params - Task parameters
   * @returns Result indicating success or failure
   */
  enqueue(sourceChatId: string, params: EnqueueTaskParams): EnqueueTaskResult {
    const { projectKey, payload, priority = 'normal' } = params;

    // 1. Validate inputs
    if (!projectKey || projectKey.trim().length === 0) {
      return { success: false, message: 'projectKey cannot be empty' };
    }
    if (!payload || payload.trim().length === 0) {
      return { success: false, message: 'payload cannot be empty' };
    }

    // 2. Resolve target chatId
    const targetChatId = this.projectResolver.resolve(projectKey);
    if (!targetChatId) {
      return {
        success: false,
        message: `Project "${projectKey}" not found or has no bound chatId`,
      };
    }

    // 3. Anti-recursion check
    if (targetChatId === sourceChatId) {
      return {
        success: false,
        message: 'Cannot enqueue task to own project (anti-recursion protection)',
      };
    }

    // 4. Rate limit check
    if (!this.rateLimiter.isWithinLimit(sourceChatId)) {
      return {
        success: false,
        message: 'Rate limit exceeded: too many A2A tasks from this agent',
      };
    }

    // 5. Create task
    const task: A2ATask = {
      id: generateTaskId(),
      sourceChatId,
      projectKey,
      payload,
      priority,
      status: 'pending',
      createdAt: new Date().toISOString(),
      targetChatId,
    };

    // 6. Record for rate limiting
    this.rateLimiter.record(sourceChatId);

    // 7. Add to queue
    this.addToQueue(targetChatId, task);
    this.tasks.set(task.id, task);

    this.log.info({
      taskId: task.id,
      sourceChatId,
      targetChatId,
      projectKey,
      priority,
    }, 'A2A task enqueued');

    // 8. Attempt immediate delivery (non-blocking)
    this.attemptDelivery(targetChatId, task).catch(err => {
      this.log.error({ err, taskId: task.id }, 'A2A delivery failed');
    });

    return {
      success: true,
      message: `Task enqueued for project "${projectKey}" (chatId: ${targetChatId}). The agent will process it.`,
      taskId: task.id,
    };
  }

  /**
   * Get the queue for a specific target chatId.
   */
  getQueue(targetChatId: string): A2ATask[] {
    return this.queues.get(targetChatId) ?? [];
  }

  /**
   * Get a task by its ID.
   */
  getTask(taskId: string): A2ATask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Drain the next pending task from a target's queue.
   * Called when a target agent becomes available.
   */
  drainNext(targetChatId: string): A2ATask | undefined {
    const queue = this.queues.get(targetChatId);
    if (!queue || queue.length === 0) {
      return undefined;
    }

    // Sort by priority then by creation time
    queue.sort((a, b) => {
      const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (pDiff !== 0) {return pDiff;}
      return a.createdAt.localeCompare(b.createdAt);
    });

    return queue.shift();
  }

  /**
   * Mark a task as delivered.
   */
  markDelivered(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'delivered';
    }
  }

  /**
   * Mark a task as failed.
   */
  markFailed(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'failed';
      task.error = error;
    }
  }

  /**
   * Get the number of pending tasks across all queues.
   */
  pendingCount(): number {
    let count = 0;
    for (const queue of this.queues.values()) {
      count += queue.length;
    }
    return count;
  }

  // ───────────────────────────────────────────
  // Private Methods
  // ───────────────────────────────────────────

  private addToQueue(targetChatId: string, task: A2ATask): void {
    let queue = this.queues.get(targetChatId);
    if (!queue) {
      queue = [];
      this.queues.set(targetChatId, queue);
    }
    queue.push(task);
  }

  private async attemptDelivery(targetChatId: string, task: A2ATask): Promise<void> {
    if (!this.deliveryCallback) {
      return;
    }

    try {
      const delivered = await this.deliveryCallback(targetChatId, task);
      if (delivered) {
        this.markDelivered(task.id);
        this.removeFromQueue(targetChatId, task.id);
      }
    } catch (err) {
      this.log.warn({ err, taskId: task.id }, 'Immediate delivery failed, task remains queued');
    }
  }

  private removeFromQueue(targetChatId: string, taskId: string): void {
    const queue = this.queues.get(targetChatId);
    if (!queue) {return;}

    const idx = queue.findIndex(t => t.id === taskId);
    if (idx !== -1) {
      queue.splice(idx, 1);
    }
  }
}
