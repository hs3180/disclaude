/**
 * ProgressReporter - Periodic progress card sender for running subagents.
 *
 * Issue #857: Provides simple progress reporting for long-running tasks.
 * Sends periodic card updates to the user's chat while a subagent is running.
 *
 * Design:
 * - Subscribes to subagent lifecycle events
 * - Sends progress cards at configurable intervals (default: 60 seconds)
 * - Sends completion/failure cards when tasks end
 * - Uses the platform's sendCard callback for message delivery
 *
 * Architecture:
 * ```
 * SubagentManager
 *       │
 *       ├─ spawn() ──► ProgressReporter.startTracking()
 *       │                     │
 *       │                     ├─ Timer (every 60s) ──► sendCard(progress)
 *       │
 *       ├─ status change ──► ProgressReporter.updateStatus()
 *       │
 *       └─ complete/fail ──► ProgressReporter.stopTracking()
 *                                  │
 *                                  └─ sendCard(final status)
 * ```
 *
 * @module agents/progress-reporter
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('ProgressReporter');

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Callback for sending a card message.
 */
export type SendCardCallback = (
  chatId: string,
  card: Record<string, unknown>,
  description?: string,
) => Promise<void>;

/**
 * Configuration for ProgressReporter.
 */
export interface ProgressReporterConfig {
  /** Callback to send card messages to the platform */
  sendCard: SendCardCallback;
  /** Report interval in milliseconds (default: 60000 = 60 seconds) */
  reportIntervalMs?: number;
}

/**
 * Information about a tracked task's progress.
 */
export interface TaskProgressInfo {
  /** Unique agent/task ID */
  agentId: string;
  /** Human-readable name */
  name: string;
  /** Target chat ID */
  chatId: string;
  /** Current status */
  status: 'starting' | 'running' | 'completed' | 'failed' | 'stopped';
  /** Start time */
  startedAt: Date;
  /** Elapsed time in milliseconds */
  elapsed: number;
  /** Number of progress cards sent */
  reportCount: number;
}

/**
 * Tracked task internal state.
 */
interface TrackedTask {
  agentId: string;
  name: string;
  chatId: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: Date;
  timer: ReturnType<typeof setInterval> | null;
  reportCount: number;
}

// ============================================================================
// ProgressReporter Implementation
// ============================================================================

/**
 * ProgressReporter - Sends periodic progress cards for running subagents.
 *
 * Usage:
 * ```typescript
 * const reporter = new ProgressReporter({
 *   sendCard: async (chatId, card) => { ... },
 *   reportIntervalMs: 60000,
 * });
 *
 * // Start tracking when a subagent begins
 * reporter.startTracking('agent-123', 'chat-456', 'issue-solver');
 *
 * // Stop tracking when the subagent completes
 * reporter.stopTracking('agent-123', 'completed');
 *
 * // Cleanup on shutdown
 * reporter.dispose();
 * ```
 */
export class ProgressReporter {
  private readonly sendCard: SendCardCallback;
  private readonly reportIntervalMs: number;
  private readonly trackedTasks: Map<string, TrackedTask> = new Map();

  constructor(config: ProgressReporterConfig) {
    this.sendCard = config.sendCard;
    this.reportIntervalMs = config.reportIntervalMs ?? 60_000;
  }

  /**
   * Start tracking a subagent and send periodic progress cards.
   *
   * @param agentId - Unique agent/task ID
   * @param chatId - Target chat ID for progress cards
   * @param name - Human-readable name for the task
   */
  startTracking(agentId: string, chatId: string, name: string): void {
    // Don't double-track
    if (this.trackedTasks.has(agentId)) {
      logger.debug({ agentId }, 'Already tracking agent, skipping');
      return;
    }

    const task: TrackedTask = {
      agentId,
      name,
      chatId,
      status: 'starting',
      startedAt: new Date(),
      timer: null,
      reportCount: 0,
    };

    // Send initial "started" card
    void this.sendProgressCard(task);

    // Start periodic timer
    task.timer = setInterval(() => {
      void this.sendProgressCard(task);
    }, this.reportIntervalMs);

    this.trackedTasks.set(agentId, task);
    logger.info({ agentId, name, chatId }, 'Started tracking subagent progress');
  }

  /**
   * Update the status of a tracked task.
   *
   * @param agentId - Agent/task ID
   * @param status - New status
   */
  updateStatus(agentId: string, status: TrackedTask['status']): void {
    const task = this.trackedTasks.get(agentId);
    if (!task) {
      logger.debug({ agentId }, 'Cannot update status: not tracked');
      return;
    }
    task.status = status;
    logger.debug({ agentId, status }, 'Updated tracked task status');
  }

  /**
   * Stop tracking a subagent and send a final status card.
   *
   * @param agentId - Agent/task ID
   * @param finalStatus - Final status (completed, failed, stopped)
   */
  async stopTracking(agentId: string, finalStatus: 'completed' | 'failed' | 'stopped'): Promise<void> {
    const task = this.trackedTasks.get(agentId);
    if (!task) {
      logger.debug({ agentId }, 'Cannot stop tracking: not tracked');
      return;
    }

    // Stop the timer
    if (task.timer) {
      clearInterval(task.timer);
    }

    task.status = finalStatus;

    // Send final status card
    await this.sendFinalCard(task);

    this.trackedTasks.delete(agentId);
    logger.info({ agentId, finalStatus }, 'Stopped tracking subagent progress');
  }

  /**
   * Get progress info for a tracked task.
   *
   * @param agentId - Agent/task ID
   * @returns Progress info or undefined
   */
  getProgress(agentId: string): TaskProgressInfo | undefined {
    const task = this.trackedTasks.get(agentId);
    if (!task) {return undefined;}

    return {
      agentId: task.agentId,
      name: task.name,
      chatId: task.chatId,
      status: task.status,
      startedAt: task.startedAt,
      elapsed: Date.now() - task.startedAt.getTime(),
      reportCount: task.reportCount,
    };
  }

  /**
   * Get all currently tracked task progress info.
   */
  getAllProgress(): TaskProgressInfo[] {
    return Array.from(this.trackedTasks.values()).map(task => ({
      agentId: task.agentId,
      name: task.name,
      chatId: task.chatId,
      status: task.status,
      startedAt: task.startedAt,
      elapsed: Date.now() - task.startedAt.getTime(),
      reportCount: task.reportCount,
    }));
  }

  /**
   * Stop all tracking and clean up.
   */
  dispose(): void {
    for (const task of this.trackedTasks.values()) {
      if (task.timer) {
        clearInterval(task.timer);
      }
    }
    this.trackedTasks.clear();
    logger.info('ProgressReporter disposed');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Send a progress card for a running task.
   */
  private async sendProgressCard(task: TrackedTask): Promise<void> {
    const elapsed = Date.now() - task.startedAt.getTime();
    const elapsedStr = formatDuration(elapsed);

    task.reportCount++;

    const card = buildProgressCard({
      name: task.name,
      status: task.status,
      elapsed: elapsedStr,
      reportCount: task.reportCount,
    });

    try {
      await this.sendCard(task.chatId, card, `Progress: ${task.name}`);
      logger.debug({ agentId: task.agentId, reportCount: task.reportCount }, 'Progress card sent');
    } catch (error) {
      logger.error({ err: error, agentId: task.agentId }, 'Failed to send progress card');
    }
  }

  /**
   * Send a final status card when a task completes/fails/stops.
   */
  private async sendFinalCard(task: TrackedTask): Promise<void> {
    const elapsed = Date.now() - task.startedAt.getTime();
    const elapsedStr = formatDuration(elapsed);

    const statusEmoji = task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : '⏹️';
    const statusText = task.status === 'completed' ? '任务完成' : task.status === 'failed' ? '任务失败' : '任务停止';

    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: `${statusEmoji} ${statusText}`, tag: 'plain_text' },
        template: task.status === 'completed' ? 'green' : task.status === 'failed' ? 'red' : 'grey',
      },
      elements: [
        { tag: 'markdown', content: `**任务**: ${task.name}` },
        { tag: 'markdown', content: `**耗时**: ${elapsedStr}` },
        { tag: 'markdown', content: `_共发送 ${task.reportCount} 次进度报告_` },
      ],
    };

    try {
      await this.sendCard(task.chatId, card, `Final: ${task.name}`);
      logger.debug({ agentId: task.agentId, status: task.status }, 'Final card sent');
    } catch (error) {
      logger.error({ err: error, agentId: task.agentId }, 'Failed to send final card');
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Build a progress card for a running task.
 */
function buildProgressCard(opts: {
  name: string;
  status: string;
  elapsed: string;
  reportCount: number;
}): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { content: '🔄 任务执行中', tag: 'plain_text' },
      template: 'blue',
    },
    elements: [
      { tag: 'markdown', content: `**任务**: ${opts.name}` },
      { tag: 'markdown', content: `**状态**: ${opts.status === 'starting' ? '启动中...' : '执行中'}` },
      { tag: 'markdown', content: `**已运行**: ${opts.elapsed}` },
      { tag: 'markdown', content: `_进度报告 #${opts.reportCount}_` },
    ],
  };
}
