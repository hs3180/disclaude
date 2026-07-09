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
  /**
   * Reset (dispose) the persistent agent for a chat so the next message starts
   * a fresh session. Used by the `clearContext` schedule option (Issue #4206).
   * Optional: if not wired, `clearContext: true` logs a warning and is ignored.
   *
   * @param skipContext - When true (default for clearContext), the next agent
   *   for this chat skips reloading persisted history (true fresh session).
   *   When false, the next agent reloads history normally — used by the
   *   scheduler to CLEAR a stale skip flag if a clearContext task fails before
   *   its turn consumes it (Issue #4206 review nit), so the leaked flag does
   *   not drop history from a subsequent, unrelated message.
   */
  resetAgent?: (chatId: string, skipContext?: boolean) => void;
  /**
   * Report whether the agent for a chat is currently processing a message
   * (busy). Issue #4199: when wired, a `blocking: true` task whose target chat
   * is busy is skipped this tick instead of being dispatched into an in-flight
   * conversation. Optional; when absent, behavior is unchanged.
   */
  isChatBusy?: (chatId: string) => boolean;
}

/**
 * Scheduler options.
 *
 * Issue #3582: Uses InputMessageRouter for task execution.
 * Issue #869: Added cooldownManager for cooldown period support.
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
    // Opt-in allowChildSchedules: permit a bounded ONE-SHOT child schedule
    // (e.g. a holiday Monday postponing a reminder to the next working day)
    // while keeping the anti-recursion guard for every other task and still
    // forbidding recurring spawns / chains.
    if (task.allowChildSchedules) {
      return `⚠️ **Scheduled Task Execution Context (allowChildSchedules=true)**

You are executing a scheduled task named "${task.name}".

This task is explicitly permitted to create a **one-shot child schedule** for a bounded postpone/reschedule (e.g., a holiday Monday pushing a reminder to the next working day).

**ALLOWED (bounded):**
- Create at most ONE child schedule by writing \`/data/workspace/schedules/<slug>/SCHEDULE.md\` with a cron pinned to a specific future datetime.
- The child MUST self-disable (set \`enabled: false\`) immediately after it fires, so it runs exactly once.

**STILL FORBIDDEN (anti-recursion):**
- Do NOT create recurring child schedules.
- Do NOT create chains (a child that itself creates schedules).
- Do NOT create more than one child schedule per execution.

---

**Task Prompt:**
${task.prompt}`;
    }
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

    // Issue #4199: A blocking task should not be dispatched into a chat whose
    // agent is currently processing a message — that would interrupt / interleave
    // with the user's in-flight conversation. `isChatBusy` reflects the real
    // `isProcessingMessage` signal (non-sticky since #3985), so this gate skips
    // at most one tick and won't reintroduce the indefinite-skipping that #4102
    // removed. When no `isChatBusy` callback is wired, behavior is unchanged.
    if (task.blocking && task.chatId && this.callbacks.isChatBusy?.(task.chatId)) {
      logger.info(
        { taskId: task.id, name: task.name, chatId: task.chatId },
        'Task skipped - chat is busy (agent is processing a message)'
      );
      return;
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

    // Issue #4206 (review nit): tracks whether we already applied a clearContext
    // reset, so the catch path can undo the leaked skip-history flag if the
    // task fails before its turn consumes it.
    let contextCleared = false;

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

      // Issue #4206: opt-in clearContext — reset the persistent agent so this
      // task runs in a fresh session (no accumulated context). Done before the
      // start notification so the reset is visible in logs ahead of the turn.
      if (task.clearContext && task.chatId) {
        if (this.callbacks.resetAgent) {
          try {
            this.callbacks.resetAgent(task.chatId, true);
            contextCleared = true;
            logger.info(
              { taskId: task.id, name: task.name, chatId: task.chatId },
              'Cleared agent context before scheduled task (clearContext: true)'
            );
          } catch (err) {
            logger.warn(
              { err, taskId: task.id, chatId: task.chatId },
              'Failed to clear agent context before scheduled task; continuing with existing context'
            );
          }
        } else {
          logger.warn(
            { taskId: task.id, name: task.name, chatId: task.chatId },
            'Schedule has clearContext: true but no resetAgent callback wired; ignoring (running with existing context)'
          );
        }
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

      // Issue #4206 (review nit): if we cleared context for this task but it
      // then failed before its turn consumed the skip-history flag, clear that
      // stale flag so the next real message for this chat reloads history
      // normally. Otherwise a failed clearContext run would leak skip-history
      // to a subsequent, unrelated user message. resetAgent(chatId, false)
      // disposes any partial fresh agent and restores the with-history default.
      if (contextCleared && task.chatId && this.callbacks.resetAgent) {
        try {
          this.callbacks.resetAgent(task.chatId, false);
          logger.warn(
            { taskId: task.id, chatId: task.chatId },
            'Cleared stale skip-history flag after failed clearContext task'
          );
        } catch (cleanupErr) {
          logger.warn(
            { err: cleanupErr, taskId: task.id, chatId: task.chatId },
            'Failed to clear stale skip-history flag after failed clearContext task'
          );
        }
      }

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

}
