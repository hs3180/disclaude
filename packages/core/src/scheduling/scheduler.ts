/**
 * Scheduler - Executes scheduled tasks using cron.
 *
 * Uses node-cron to schedule task execution.
 * Integrates with ScheduleManager for task management.
 *
 * Issue #711: Uses short-lived ChatAgents instead of AgentPool.
 * - Each task execution creates a new ChatAgent via injected executor
 * - ChatAgent is disposed after execution completes
 * - No persistent agent state between executions
 *
 * Issue #1041: Refactored to use dependency injection for agent execution.
 * - Executor function is injected via options
 * - Decouples scheduler from agents module
 * - Allows scheduler to be migrated independently
 * - Migrated from @disclaude/worker-node to @disclaude/core
 *
 * Issue #3333: Scheduler integration with NonUserMessage.
 * - Tasks with `projectKey` route via ScheduledMessageRouter to project-bound agents
 * - Tasks without `projectKey` use existing short-lived agent path (backward compatible)
 * - Added `triggerTask()` for manual on-demand execution
 *
 * Features:
 * - Dynamic task scheduling
 * - Integration with executor function for task execution
 * - Project-bound routing via ScheduledMessageRouter
 * - Manual task triggering via triggerTask()
 * - Automatic reload of tasks on schedule changes
 *
 * @module @disclaude/core/scheduling
 */

import { CronJob } from 'cron';
import { createLogger } from '../utils/logger.js';
import { CooldownManager } from './cooldown-manager.js';
import type { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';
import type { ModelTier } from '../config/types.js';

const logger = createLogger('Scheduler');

/**
 * Default timeout for scheduled task execution.
 * 30 minutes — generous enough for long-running agent tasks,
 * but prevents indefinite hangs that block subsequent executions.
 *
 * Issue #3346: Timeout protection for scheduled tasks.
 */
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Error thrown when a scheduled task exceeds its timeout.
 *
 * Issue #3346: Timeout protection for scheduled tasks.
 */
export class TaskTimeoutError extends Error {
  /** The timeout duration in milliseconds */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Scheduled task timed out after ${timeoutMs}ms`);
    this.name = 'TaskTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error thrown when a task is not found.
 *
 * Issue #3333: Scheduler integration with NonUserMessage.
 */
export class TaskNotFoundError extends Error {
  /** The task ID that was not found */
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Scheduled task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
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
 * Task executor function type.
 * This function is called to execute a scheduled task.
 *
 * @param chatId - Chat ID to send messages to
 * @param prompt - The task prompt to execute
 * @param userId - Optional user ID for context
 * @param model - Optional model override for this task (Issue #1338)
 * @param modelTier - Optional model tier for tier-based model resolution (Issue #3059)
 */
export type TaskExecutor = (chatId: string, prompt: string, userId?: string, model?: string, modelTier?: ModelTier) => Promise<void>;

/**
 * Result of routing a scheduled message via ScheduledMessageRouter.
 *
 * Issue #3333: Scheduler integration with NonUserMessage.
 */
export interface ScheduledMessageRouteResult {
  /** Whether routing succeeded */
  ok: boolean;
  /** Chat ID the message was routed to (on success) */
  chatId?: string;
  /** Error description (on failure) */
  error?: string;
}

/**
 * ScheduledMessageRouter — abstraction for routing scheduled tasks to
 * project-bound ChatAgent instances.
 *
 * This interface decouples the Scheduler from the concrete UnifiedMessageRouter
 * (Phase 1, Issue #3331). The application layer wires the implementation at startup:
 *
 * ```typescript
 * const messageRouter: ScheduledMessageRouter = {
 *   route: async (options) => {
 *     const message = createSystemMessage({ ... });
 *     return unifiedMessageRouter.route(message);
 *   },
 * };
 * ```
 *
 * Issue #3333: Scheduler integration with NonUserMessage.
 */
export interface ScheduledMessageRouter {
  /**
   * Route a scheduled task to its target project-bound agent.
   *
   * @param options - Routing options
   * @param options.projectKey - Target project key (e.g., 'owner/repo')
   * @param options.payload - Task prompt content
   * @param options.taskName - Name of the scheduled task
   * @param options.trigger - Trigger type ('scheduled' | 'command')
   * @param options.modelTier - Optional model tier override
   * @returns Route result indicating success/failure
   */
  route(options: {
    projectKey: string;
    payload: string;
    taskName: string;
    trigger: 'scheduled' | 'command';
    modelTier?: ModelTier;
  }): Promise<ScheduledMessageRouteResult>;
}

/**
 * Scheduler options.
 *
 * Issue #711: No longer requires AgentPool.
 * Uses executor function for task execution.
 * Issue #869: Added cooldownManager for cooldown period support.
 * Issue #1041: Uses dependency injection for executor.
 * Issue #3333: Added optional messageRouter for project-bound agent routing.
 */
export interface SchedulerOptions {
  /** ScheduleManager instance for task CRUD */
  scheduleManager: ScheduleManager;
  /** Callbacks for sending messages */
  callbacks: SchedulerCallbacks;
  /** Task executor function (used when projectKey is not set) */
  executor: TaskExecutor;
  /** CooldownManager for cooldown period management */
  cooldownManager?: CooldownManager;
  /**
   * Optional message router for project-bound agent routing.
   * When a task has `projectKey` and a router is provided, the task is routed
   * to the existing project-bound ChatAgent instead of creating a short-lived one.
   *
   * Issue #3333: Scheduler integration with NonUserMessage.
   */
  messageRouter?: ScheduledMessageRouter;
}

/**
 * Scheduler - Manages cron-based task execution.
 *
 * Issue #711: Uses short-lived ChatAgents (max 24h lifetime).
 * Each execution creates a fresh ChatAgent, ensuring isolation.
 * Issue #1041: Uses dependency injection for task execution.
 *
 * Usage:
 * ```typescript
 * const scheduler = new Scheduler({
 *   scheduleManager,
 *   callbacks,
 *   executor: async (chatId, prompt, userId) => {
 *     // Create and run agent
 *     const agent = AgentFactory.createAgent(chatId, callbacks);
 *     await agent.processMessage(chatId, prompt, messageId, userId);
 *     await agent.taskComplete;
 *     agent.dispose();
 *   },
 * });
 *
 * // Start scheduler (loads and schedules all enabled tasks)
 * await scheduler.start();
 *
 * // Add a new task dynamically
 * await scheduler.addTask(task);
 *
 * // Stop scheduler
 * await scheduler.stop();
 * ```
 */
export class Scheduler {
  private scheduleManager: ScheduleManager;
  private callbacks: SchedulerCallbacks;
  private executor: TaskExecutor;
  private cooldownManager?: CooldownManager;
  private messageRouter?: ScheduledMessageRouter;
  private activeJobs: Map<string, ActiveJob> = new Map();
  private running = false;
  /** Tracks tasks currently being executed (for blocking mechanism) */
  private runningTasks: Set<string> = new Set();

  constructor(options: SchedulerOptions) {
    this.scheduleManager = options.scheduleManager;
    this.callbacks = options.callbacks;
    this.executor = options.executor;
    this.cooldownManager = options.cooldownManager;
    this.messageRouter = options.messageRouter;
    logger.info({ hasMessageRouter: !!this.messageRouter }, 'Scheduler created');
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
   * Stop the scheduler.
   * Stops all active cron jobs.
   */
  stop(): void {
    this.running = false;

    for (const [taskId, entry] of this.activeJobs) {
      void entry.job.stop();
      logger.debug({ taskId }, 'Stopped cron job');
    }

    this.activeJobs.clear();
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
      const job = new CronJob(
        task.cron,
        () => this.executeTask(task),
        null,
        true, // start
        'Asia/Shanghai' // timezone
      );

      this.activeJobs.set(task.id, { taskId: task.id, job, task });
      logger.info({ taskId: task.id, cron: task.cron, name: task.name }, 'Scheduled task');
    } catch (error) {
      logger.error({ err: error, taskId: task.id, cron: task.cron }, 'Invalid cron expression');
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
      void entry.job.stop();
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
   * Issue #711: Creates a short-lived ChatAgent for each execution.
   * ChatAgent is disposed after execution to free resources.
   * Issue #869: Added cooldown period check before execution.
   * Issue #1041: Uses injected executor function.
   * Issue #3333: Routes via messageRouter when projectKey is set.
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

    logger.info({ taskId: task.id, name: task.name }, 'Executing scheduled task');

    // Mark task as running
    this.runningTasks.add(task.id);

    try {
      // Issue #3333: Route via messageRouter when projectKey is set
      if (task.projectKey && this.messageRouter) {
        await this.executeViaRouter(task);
      } else {
        await this.executeViaExecutor(task);
      }

      logger.info({ taskId: task.id }, 'Scheduled task completed');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = error instanceof TaskTimeoutError;

      if (isTimeout) {
        logger.warn(
          { taskId: task.id, name: task.name, timeoutMs: error.timeoutMs },
          'Scheduled task timed out'
        );
      } else {
        logger.error({ err: error, taskId: task.id }, 'Scheduled task failed');
      }

      // Send error notification
      await this.callbacks.sendMessage(
        task.chatId,
        isTimeout
          ? `⏰ 定时任务「${task.name}」执行超时 (${error.timeoutMs / 1000}s)`
          : `❌ 定时任务「${task.name}」执行失败: ${errorMessage}`
      );
    } finally {
      // Always remove from running tasks
      this.runningTasks.delete(task.id);

      // Issue #869: Record execution for cooldown period
      if (task.cooldownPeriod && this.cooldownManager) {
        await this.cooldownManager.recordExecution(task.id, task.cooldownPeriod);
        logger.debug({ taskId: task.id, cooldownPeriod: task.cooldownPeriod }, 'Recorded task execution for cooldown');
      }
    }
  }

  /**
   * Execute a task via the ScheduledMessageRouter (project-bound agent path).
   *
   * When a task has `projectKey`, it is routed to an existing project-bound
   * ChatAgent instead of creating a short-lived agent. This enables stateful
   * scheduled runs where the agent maintains context between executions.
   *
   * Issue #3333: Scheduler integration with NonUserMessage.
   *
   * @param task - Task with projectKey to route
   */
  private async executeViaRouter(task: ScheduledTask): Promise<void> {
    // Send start notification
    await this.callbacks.sendMessage(
      task.chatId,
      `⏰ 定时任务「${task.name}」开始执行（项目代理: ${task.projectKey}）...`
    );

    // Build wrapped prompt with anti-recursion instructions
    const wrappedPrompt = this.buildScheduledTaskPrompt(task);

    // Route via messageRouter to project-bound agent
    // Issue #3346: Wrap with timeout to prevent indefinite hangs
    const timeoutMs = task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new TaskTimeoutError(timeoutMs)), timeoutMs);
    });

    try {
      // Guard: executeViaRouter is only called when both are present
      const router = this.messageRouter;
      const {projectKey} = task;
      if (!router || !projectKey) {
        throw new Error('executeViaRouter called without messageRouter or projectKey');
      }

      const routeResult = await Promise.race([
        router.route({
          projectKey,
          payload: wrappedPrompt,
          taskName: task.name,
          trigger: 'scheduled',
          modelTier: task.modelTier,
        }),
        timeoutPromise,
      ]);

      // Check if routing itself failed (distinct from agent execution failure)
      if (!routeResult.ok) {
        throw new Error(`Message routing failed: ${routeResult.error ?? 'unknown error'}`);
      }
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Execute a task via the injected executor (short-lived agent path).
   *
   * This is the original execution path — creates a fresh ChatAgent,
   * runs the task, and disposes the agent. No state is preserved between runs.
   *
   * Issue #1041: Uses injected executor function.
   *
   * @param task - Task to execute via short-lived agent
   */
  private async executeViaExecutor(task: ScheduledTask): Promise<void> {
    // Send start notification
    await this.callbacks.sendMessage(
      task.chatId,
      `⏰ 定时任务「${task.name}」开始执行...`
    );

    // Build wrapped prompt with anti-recursion instructions
    const wrappedPrompt = this.buildScheduledTaskPrompt(task);

    // Issue #1041: Use injected executor function
    // Issue #1338: Pass model override for per-task model selection
    // Issue #3059: Pass modelTier for tier-based model resolution
    // Issue #3346: Wrap with timeout to prevent indefinite hangs
    const timeoutMs = task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new TaskTimeoutError(timeoutMs)), timeoutMs);
    });

    try {
      await Promise.race([
        this.executor(task.chatId, wrappedPrompt, task.createdBy, task.model, task.modelTier),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Manually trigger a scheduled task by its task ID.
   *
   * The task is loaded from ScheduleManager and executed immediately,
   * bypassing the cron schedule. Cooldown and blocking checks still apply.
   *
   * This enables on-demand execution from admin commands or external triggers:
   * ```typescript
   * await scheduler.triggerTask('schedule-daily-maintenance');
   * ```
   *
   * Issue #3333: Scheduler integration with NonUserMessage.
   *
   * @param taskId - ID of the task to trigger
   * @throws {TaskNotFoundError} If the task does not exist
   */
  async triggerTask(taskId: string): Promise<void> {
    const task = await this.scheduleManager.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }
    logger.info({ taskId, name: task.name }, 'Manually triggering scheduled task');
    await this.executeTask(task);
  }

  /**
   * Reload all tasks from ScheduleManager.
   * Useful after external changes to the schedule storage.
   */
  async reload(): Promise<void> {
    await this.stop();
    await this.start();
    logger.info('Scheduler reloaded all tasks');
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
