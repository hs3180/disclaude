/**
 * Scheduler - Executes scheduled tasks using cron.
 *
 * Uses node-cron to schedule task execution.
 * Integrates with ScheduleManager for task management.
 *
 * Issue #3582: Routes tasks through InputMessageRouter as SystemMessage.
 * Tasks are delivered to existing persistent agents via AgentPool.
 *
 * Features:
 * - Dynamic task scheduling
 * - Automatic reload of tasks on schedule changes
 *
 * @module @disclaude/core/scheduling
 */

import { CronJob } from 'cron';
import { createLogger } from '../utils/logger.js';
import { CooldownManager } from './cooldown-manager.js';
import type { ScheduleManager } from './schedule-manager.js';
import { DEFAULT_TIMEZONE, type ScheduledTask } from './scheduled-task.js';
import type { MessageRouter as InputMessageRouter } from '../messaging/message-router.js';
import type { SystemMessage } from '../types/message.js';

const logger = createLogger('Scheduler');

/**
 * Format timeout duration for display.
 * Shows seconds when under 1 minute, otherwise shows minutes.
 */
function formatTimeout(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) {
    return `${Math.round(ms / 1000)}秒`;
  }
  return `${minutes}分钟`;
}

/**
 * Default task execution timeout (5 minutes).
 * Issue #3894: Prevents indefinitely hung scheduled tasks from blocking
 * subsequent executions.
 */
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Error thrown when a scheduled task execution times out.
 *
 * Issue #3894: Used to distinguish timeout errors from other failures,
 * allowing specific error notification to the user.
 */
export class TaskTimeoutError extends Error {
  /** Task ID that timed out */
  readonly taskId: string;
  /** Timeout duration in milliseconds */
  readonly timeoutMs: number;

  constructor(taskId: string, timeoutMs: number) {
    super(`Scheduled task "${taskId}" timed out after ${formatTimeout(timeoutMs)}`);
    this.name = 'TaskTimeoutError';
    this.taskId = taskId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Active cron job entry.
 */
interface ActiveJob {
  taskId: string;
  job: CronJob;
  task: ScheduledTask;
}

/**
 * Callbacks for sending messages.
 * Simplified interface for dependency injection.
 */
export interface SchedulerCallbacks {
  /** Send a text message to a chat */
  sendMessage: (chatId: string, message: string) => Promise<void>;
}

/**
 * Scheduler options.
 *
 * Issue #3582: Uses InputMessageRouter for task execution.
 * Issue #869: Added cooldownManager for cooldown period support.
 * Issue #3931: Added isAgentBusy callback for blocking task agent-idle check.
 */
export interface SchedulerOptions {
  /** ScheduleManager instance for task CRUD */
  scheduleManager: ScheduleManager;
  /** Callbacks for sending messages */
  callbacks: SchedulerCallbacks;
  /** CooldownManager for cooldown period management */
  cooldownManager?: CooldownManager;
  /**
   * Input MessageRouter for routing scheduled tasks as SystemMessage.
   * Issue #3582: Routes through existing agents via AgentPool.
   */
  inputMessageRouter?: InputMessageRouter;
  /**
   * Check if the agent for a chatId is currently busy processing.
   * Issue #3931: Blocking tasks skip execution when the agent is busy,
   * preventing context interference with ongoing user conversations.
   *
   * @param chatId - Chat ID to check
   * @returns true if the agent is busy processing a message
   */
  isAgentBusy?: (chatId: string) => boolean;
}

/**
 * Scheduler - Manages cron-based task execution.
 *
 * Issue #3582: Routes tasks through InputMessageRouter to existing agents.
 *
 * Usage:
 * ```typescript
 * const scheduler = new Scheduler({
 *   scheduleManager,
 *   callbacks,
 *   inputMessageRouter,
 * });
 *
 * // Start scheduler (loads and schedules all enabled tasks)
 * await scheduler.start();
 *
 * // Stop scheduler
 * await scheduler.stop();
 * ```
 */
export class Scheduler {
  private scheduleManager: ScheduleManager;
  private callbacks: SchedulerCallbacks;
  private cooldownManager?: CooldownManager;
  private inputMessageRouter?: InputMessageRouter;
  /** Issue #3931: Callback to check if agent is busy for a chatId */
  private isAgentBusy?: (chatId: string) => boolean;
  /** Issue #3931: Track consecutive agent-busy skips per task for notification throttling */
  private agentBusySkipCount = new Map<string, number>();
  private activeJobs: Map<string, ActiveJob> = new Map();
  private running = false;
  /** Tracks tasks currently being executed (for blocking mechanism) */
  private runningTasks: Set<string> = new Set();
  /**
   * Issue #4102: Tracks chatIds that currently have a blocking scheduled task running.
   * Blocking tasks only skip when ANOTHER blocking scheduled task is running for the
   * same chatId — not when the agent is busy with user messages.
   */
  private runningBlockingTaskChatIds = new Set<string>();
  /**
   * Resolves when all running tasks have completed.
   * Created lazily when the first task starts; resolved and cleared when
   * runningTasks drains to zero. Used by stop() for graceful shutdown
   * without polling.
   *
   * Issue #3415.
   */
  private _drainPromise: Promise<void> | null = null;
  private _drainResolve: (() => void) | null = null;

  constructor(options: SchedulerOptions) {
    this.scheduleManager = options.scheduleManager;
    this.callbacks = options.callbacks;
    this.cooldownManager = options.cooldownManager;
    this.inputMessageRouter = options.inputMessageRouter;
    this.isAgentBusy = options.isAgentBusy;
    logger.info('Scheduler created');
  }

  /**
   * Start the scheduler.
   * Loads all enabled tasks and schedules them.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Scheduler already running');
      return;
    }

    this.running = true;

    // Load and schedule all enabled tasks
    const tasks = await this.scheduleManager.listEnabled();
    for (const task of tasks) {
      await this.addTask(task);
    }

    logger.info({ taskCount: this.activeJobs.size }, 'Scheduler started');
  }

  /**
   * Graceful shutdown timeout for waiting on running tasks.
   * After this period, running tasks are abandoned.
   *
   * Issue #3415: Ensures test processes exit cleanly by waiting
   * for in-flight task executions to complete.
   */
  private static readonly GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;

  /**
   * Stop the scheduler.
   * Stops all active cron jobs and waits for running tasks to complete.
   *
   * Issue #3415: Made async to allow graceful shutdown of in-flight
   * task executions. Previously fire-and-forget, which caused test
   * processes to be killed (SIGKILL) before cron cleanup could finish.
   *
   * @param timeoutMs - Optional timeout in ms to wait for running tasks
   *   (default: 5000ms). Set to 0 to skip waiting.
   */
  async stop(timeoutMs?: number): Promise<void> {
    this.running = false;

    // Stop all cron timers first (prevents new executions)
    for (const [taskId, entry] of this.activeJobs) {
      entry.job.stop();
      logger.debug({ taskId }, 'Stopped cron job');
    }

    this.activeJobs.clear();

    // Wait for currently running tasks to complete (graceful shutdown).
    // Issue #3415: Uses a drain promise instead of polling.
    const waitTimeout = timeoutMs ?? Scheduler.GRACEFUL_SHUTDOWN_TIMEOUT_MS;
    if (this._drainPromise && waitTimeout > 0) {
      logger.info(
        { taskIds: Array.from(this.runningTasks), timeoutMs: waitTimeout },
        'Waiting for running tasks to complete...'
      );

      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (this.runningTasks.size > 0) {
            logger.warn(
              { taskIds: Array.from(this.runningTasks) },
              'Graceful shutdown timed out, abandoning running tasks'
            );
          }
          resolve();
        }, waitTimeout);
      });

      await Promise.race([this._drainPromise, timeoutPromise]);
    }

    logger.info('Scheduler stopped');
  }

  /**
   * Add a task to the scheduler.
   * Creates a cron job for the task.
   *
   * @param task - Task to add
   */
  addTask(task: ScheduledTask): void {
    // Remove existing job if any
    this.removeTask(task.id);

    if (!task.enabled) {
      logger.debug({ taskId: task.id }, 'Task is disabled, not scheduling');
      return;
    }

    try {
      const timezone = task.timezone || DEFAULT_TIMEZONE;
      const job = new CronJob(
        task.cron,
        () => this.executeTask(task),
        null,
        true, // start
        timezone
      );

      this.activeJobs.set(task.id, { taskId: task.id, job, task });
      logger.info({ taskId: task.id, cron: task.cron, name: task.name, timezone }, 'Scheduled task');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isCronError = errorMsg.toLowerCase().includes('cron');
      logger.error(
        { err: error, taskId: task.id, cron: task.cron, timezone: task.timezone || DEFAULT_TIMEZONE },
        isCronError ? 'Invalid cron expression' : 'Failed to schedule task (check cron expression and timezone)'
      );
    }
  }

  /**
   * Resolve the drain promise if no tasks are running.
   * Extracted to avoid duplication between stale-job cleanup and finally block.
   */
  private resolveDrainIfNeeded(): void {
    if (this.runningTasks.size === 0 && this._drainResolve) {
      this._drainResolve();
      this._drainPromise = null;
      this._drainResolve = null;
    }
  }

  /**
   * Clean up task tracking state after a task finishes or is aborted.
   * Issue #4102: Also cleans up per-chatId blocking task tracking.
   */
  private cleanupTaskTracking(task: ScheduledTask): void {
    this.runningTasks.delete(task.id);
    if (task.blocking && task.chatId) {
      this.runningBlockingTaskChatIds.delete(task.chatId);
    }
  }

  /**
   * Remove a task from the scheduler.
   *
   * @param taskId - Task ID to remove
   */
  removeTask(taskId: string): void {
    const entry = this.activeJobs.get(taskId);
    if (entry) {
      entry.job.stop();
      this.activeJobs.delete(taskId);
      logger.info({ taskId }, 'Removed scheduled task');
    }
  }

  /**
   * Build wrapped prompt with anti-recursion instructions.
   * Provides defense-in-depth against infinite recursion.
   *
   * @param task - Task being executed
   * @returns Wrapped prompt with explicit anti-recursion instructions
   */
  private buildScheduledTaskPrompt(task: ScheduledTask): string {
    return `⚠️ **Scheduled Task Execution Context**

You are executing a scheduled task named "${task.name}".

**IMPORTANT RULES:**
1. Do NOT create new scheduled tasks
2. Do NOT modify existing scheduled tasks
3. Focus on completing the task described below
4. If you need to run something periodically, report this need to the user instead

Scheduled task creation is blocked during scheduled task execution to prevent infinite recursion.

---

**Task Prompt:**
${task.prompt}`;
  }

  /**
   * Execute a scheduled task.
   * Called by cron job when the schedule triggers.
   *
   * Issue #3582: Routes task through InputMessageRouter to existing agents.
   * Issue #869: Added cooldown period check before execution.
   * Issue #3894: Added timeout protection for route execution.
   *
   * @param task - Task to execute
   */
  private async executeTask(task: ScheduledTask): Promise<void> {
    // Issue #869: Check cooldown period first
    if (task.cooldownPeriod && this.cooldownManager) {
      const isInCooldown = await this.cooldownManager.isInCooldown(task.id, task.cooldownPeriod);
      if (isInCooldown) {
        const status = await this.cooldownManager.getCooldownStatus(task.id, task.cooldownPeriod);
        const remainingMinutes = Math.ceil(status.remainingMs / 60000);

        logger.info(
          { taskId: task.id, name: task.name, remainingMinutes },
          'Task skipped - in cooldown period'
        );

        // Send cooldown notification
        await this.callbacks.sendMessage(
          task.chatId,
          `⏰ 定时任务「${task.name}」冷静期中，跳过执行\n` +
          `   上次执行: ${status.lastExecutionTime?.toLocaleString('zh-CN')}\n` +
          `   冷静期结束: ${status.cooldownEndsAt?.toLocaleString('zh-CN')}\n` +
          `   剩余时间: ${remainingMinutes} 分钟`
        );
        return;
      }
    }

    // Check blocking mechanism
    if (task.blocking && this.runningTasks.has(task.id)) {
      logger.info(
        { taskId: task.id, name: task.name },
        'Task skipped - previous execution still running'
      );
      return;
    }

    // Issue #4102: Check if another blocking scheduled task is running for this chatId.
    // Previously used isAgentBusy() which also blocked on user-initiated conversations,
    // causing scheduled tasks to be indefinitely skipped in active chats.
    // Now we only block on OTHER scheduled blocking tasks for the same chatId.
    if (task.blocking && task.chatId && this.runningBlockingTaskChatIds.has(task.chatId)) {
      logger.info(
        { taskId: task.id, name: task.name, chatId: task.chatId },
        'Task skipped - another blocking scheduled task is running for this chatId'
      );
      return;
    }

    // Task executed successfully (or was not agent-busy) — reset skip counter
    if (this.agentBusySkipCount.has(task.id)) {
      this.agentBusySkipCount.delete(task.id);
    }

    logger.info({ taskId: task.id, name: task.name }, 'Executing scheduled task');

    // Mark task as running
    this.runningTasks.add(task.id);
    // Issue #4102: Track blocking tasks by chatId for per-chat serialization
    if (task.blocking && task.chatId) {
      this.runningBlockingTaskChatIds.add(task.chatId);
    }
    // Create drain promise if this is the first running task
    if (!this._drainPromise) {
      this._drainPromise = new Promise<void>((resolve) => {
        this._drainResolve = resolve;
      });
    }

    // Issue #3929: Verify the schedule file still exists before executing.
    // Placed after runningTasks.add() so that the blocking mechanism still
    // works synchronously. fs.watch may miss deletion events on Linux and
    // the periodic fullRescan may not have run yet.
    try {
      const currentTask = await this.scheduleManager.get(task.id);
      if (!currentTask) {
        logger.info(
          { taskId: task.id, name: task.name },
          'Task file no longer exists, removing stale cron job'
        );
        this.cleanupTaskTracking(task);
        this.removeTask(task.id);
        this.resolveDrainIfNeeded();
        return;
      }
    } catch (error) {
      logger.error(
        { err: error, taskId: task.id },
        'Failed to verify schedule file existence, skipping execution'
      );
      this.cleanupTaskTracking(task);
      this.removeTask(task.id);
      this.resolveDrainIfNeeded();
      return;
    }

    try {
      // Build wrapped prompt with anti-recursion instructions
      const wrappedPrompt = this.buildScheduledTaskPrompt(task);

      // Issue #3582: Route through InputMessageRouter
      if (!this.inputMessageRouter || !task.chatId) {
        logger.warn(
          { taskId: task.id, hasRouter: !!this.inputMessageRouter, hasChatId: !!task.chatId },
          'Cannot execute scheduled task: InputMessageRouter not configured or task has no chatId'
        );
        await this.callbacks.sendMessage(
          task.chatId,
          `⚠️ 定时任务「${task.name}」无法执行: InputMessageRouter 未配置或任务缺少 chatId`
        );
        return;
      }

      // Send start notification
      await this.callbacks.sendMessage(
        task.chatId,
        `⏰ 定时任务「${task.name}」开始执行...`
      );

      {
        const systemMessage: SystemMessage = {
          id: `sched-${task.id}-${Date.now()}`,
          source: 'system',
          payload: wrappedPrompt,
          chatId: task.chatId,
          trigger: 'scheduled',
          taskName: task.name,
          modelTier: task.modelTier,
          data: {
            taskId: task.id,
            createdBy: task.createdBy,
            model: task.model,
          },
          createdAt: new Date().toISOString(),
        };

        logger.debug({ taskId: task.id, chatId: task.chatId }, 'Routing scheduled task via InputMessageRouter');

        // Issue #3894: Timeout protection for InputMessageRouter route.
        // Prevents hung routes from keeping task in runningTasks forever.
        const timeoutMs = task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new TaskTimeoutError(task.id, timeoutMs)), timeoutMs);
        });
        try {
          await Promise.race([
            this.inputMessageRouter.route(systemMessage),
            timeoutPromise,
          ]);
        } finally {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
        }

        logger.info({ taskId: task.id }, 'Scheduled task completed (via InputMessageRouter)');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, taskId: task.id }, 'Scheduled task failed');

      // Issue #3894: Send specific timeout notification
      const userMessage = error instanceof TaskTimeoutError
        ? `⏱️ 定时任务「${task.name}」执行超时 (${formatTimeout(error.timeoutMs)})，已自动终止`
        : `❌ 定时任务「${task.name}」执行失败: ${errorMessage}`;

      await this.callbacks.sendMessage(task.chatId, userMessage);
    } finally {
      // Always remove from running tasks
      this.cleanupTaskTracking(task);

      // Resolve drain promise when all tasks have completed
      this.resolveDrainIfNeeded();

      // Issue #869: Record execution for cooldown period
      if (task.cooldownPeriod && this.cooldownManager) {
        await this.cooldownManager.recordExecution(task.id, task.cooldownPeriod);
        logger.debug({ taskId: task.id, cooldownPeriod: task.cooldownPeriod }, 'Recorded task execution for cooldown');
      }
    }
  }

  /**
   * Get all active jobs.
   */
  getActiveJobs(): ActiveJob[] {
    return Array.from(this.activeJobs.values());
  }

  /**
   * Check if scheduler is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Check if a task is currently being executed.
   *
   * @param taskId - Task ID to check
   * @returns true if the task is currently running
   */
  isTaskRunning(taskId: string): boolean {
    return this.runningTasks.has(taskId);
  }

  /**
   * Check if any scheduled task is currently being executed.
   * Used to prevent recursive schedule creation.
   *
   * @returns true if any scheduled task is currently running
   */
  isAnyTaskRunning(): boolean {
    return this.runningTasks.size > 0;
  }

  /**
   * Get the IDs of all currently running tasks.
   *
   * @returns Array of running task IDs
   */
  getRunningTaskIds(): string[] {
    return Array.from(this.runningTasks);
  }

  /**
   * Get cooldown status for a task.
   *
   * @param taskId - Task ID to check
   * @param cooldownPeriod - Cooldown period in milliseconds
   * @returns Cooldown status or null if not applicable
   */
  async getCooldownStatus(taskId: string, cooldownPeriod?: number): Promise<{
    isInCooldown: boolean;
    lastExecutionTime: Date | null;
    cooldownEndsAt: Date | null;
    remainingMs: number;
  } | null> {
    if (!this.cooldownManager) { return null; }
    return await this.cooldownManager.getCooldownStatus(taskId, cooldownPeriod);
  }

  /**
   * Clear cooldown for a task (for debugging).
   *
   * @param taskId - Task ID to clear cooldown for
   * @returns true if cooldown was cleared, false otherwise
   */
  async clearCooldown(taskId: string): Promise<boolean> {
    if (!this.cooldownManager) { return false; }
    return await this.cooldownManager.clearCooldown(taskId);
  }

  /**
   * Check if the agent busy callback is configured.
   * Issue #3931: Used for testing and status reporting.
   */
  hasAgentBusyCheck(): boolean {
    return !!this.isAgentBusy;
  }
}
