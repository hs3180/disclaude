/**
 * Scheduler - Executes scheduled tasks using cron and event-driven triggers.
 *
 * Uses node-cron to schedule task execution.
 * Integrates with ScheduleManager for task management.
 *
 * Issue #711: Uses short-lived ScheduleAgents instead of AgentPool.
 * - Each task execution creates a new ScheduleAgent
 * - Agent is disposed after execution completes
 * - No persistent agent state between executions
 *
 * Issue #1041: Refactored to use dependency injection for agent execution.
 * - Executor function is injected via options
 * - Decouples scheduler from agents module
 * - Allows scheduler to be migrated independently
 * - Migrated from @disclaude/worker-node to @disclaude/core
 *
 * Issue #1953: Added event-driven trigger support via file watching.
 * - Schedules can declare `watch` patterns in frontmatter
 * - File changes trigger immediate execution (debounced)
 * - Cron remains as fallback for reliability
 *
 * Features:
 * - Dynamic task scheduling
 * - Integration with executor function for task execution
 * - Automatic reload of tasks on schedule changes
 * - Event-driven triggers alongside cron (Issue #1953)
 *
 * @module @disclaude/core/scheduling
 */

import { CronJob } from 'cron';
import { createLogger } from '../utils/logger.js';
import { CooldownManager } from './cooldown-manager.js';
import { EventTriggerManager } from './event-trigger-manager.js';
import type { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';

const logger = createLogger('Scheduler');

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
 */
export type TaskExecutor = (chatId: string, prompt: string, userId?: string, model?: string) => Promise<void>;

/**
 * Scheduler options.
 *
 * Issue #711: No longer requires AgentPool.
 * Uses executor function for task execution.
 * Issue #869: Added cooldownManager for cooldown period support.
 * Issue #1041: Uses dependency injection for executor.
 * Issue #1953: Added baseDir for event trigger path resolution.
 */
export interface SchedulerOptions {
  /** ScheduleManager instance for task CRUD */
  scheduleManager: ScheduleManager;
  /** Callbacks for sending messages */
  callbacks: SchedulerCallbacks;
  /** Task executor function */
  executor: TaskExecutor;
  /** CooldownManager for cooldown period management */
  cooldownManager?: CooldownManager;
  /**
   * Base directory for resolving relative watch patterns.
   * Used by EventTriggerManager to resolve glob patterns to absolute paths.
   * Defaults to process.cwd() if not specified.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   */
  baseDir?: string;
}

/**
 * Scheduler - Manages cron-based and event-driven task execution.
 *
 * Issue #711: Uses short-lived ScheduleAgents (max 24h lifetime).
 * Each execution creates a fresh agent, ensuring isolation.
 * Issue #1041: Uses dependency injection for task execution.
 * Issue #1953: Supports event-driven triggers via file watching.
 *
 * Usage:
 * ```typescript
 * const scheduler = new Scheduler({
 *   scheduleManager,
 *   callbacks,
 *   baseDir: '/project/root',
 *   executor: async (chatId, prompt, userId) => {
 *     // Create and run agent
 *     const agent = AgentFactory.createScheduleAgent(chatId, callbacks);
 *     await agent.executeOnce(chatId, prompt, undefined, userId);
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
 * // Trigger a task manually (e.g., from event)
 * await scheduler.triggerTask(task.id);
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
  private baseDir: string;
  private activeJobs: Map<string, ActiveJob> = new Map();
  private running = false;
  /** Tracks tasks currently being executed (for blocking mechanism) */
  private runningTasks: Set<string> = new Set();
  /**
   * Event-driven trigger managers for tasks with watch configurations.
   * Key: taskId, Value: EventTriggerManager instance.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   */
  private eventTriggers: Map<string, EventTriggerManager> = new Map();

  constructor(options: SchedulerOptions) {
    this.scheduleManager = options.scheduleManager;
    this.callbacks = options.callbacks;
    this.executor = options.executor;
    this.cooldownManager = options.cooldownManager;
    this.baseDir = options.baseDir ?? process.cwd();
    logger.info('Scheduler created');
  }

  /**
   * Start the scheduler.
   * Loads all enabled tasks and schedules them.
   * Tasks with watch configurations also get event triggers.
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

    logger.info(
      { taskCount: this.activeJobs.size, eventTriggerCount: this.eventTriggers.size },
      'Scheduler started'
    );
  }

  /**
   * Stop the scheduler.
   * Stops all active cron jobs and event triggers.
   */
  stop(): void {
    this.running = false;

    // Stop all event triggers first
    for (const [taskId, trigger] of this.eventTriggers) {
      trigger.stop();
      logger.debug({ taskId }, 'Stopped event trigger');
    }
    this.eventTriggers.clear();

    // Stop all cron jobs
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
   * If the task has a watch configuration, also sets up an event trigger.
   *
   * Issue #1953: Tasks with `watch` field get an EventTriggerManager
   * that monitors file changes and triggers execution immediately.
   *
   * @param task - Task to add
   */
  addTask(task: ScheduledTask): void {
    // Remove existing job if any (also cleans up event triggers)
    this.removeTask(task.id);

    if (!task.enabled) {
      logger.debug({ taskId: task.id }, 'Task is disabled, not scheduling');
      return;
    }

    // Set up cron job (always, even with watch — cron serves as fallback)
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

    // Issue #1953: Set up event trigger if watch pattern is configured
    if (task.watch) {
      this.setupEventTrigger(task);
    }
  }

  /**
   * Remove a task from the scheduler.
   * Stops both the cron job and any associated event trigger.
   *
   * @param taskId - Task ID to remove
   */
  removeTask(taskId: string): void {
    // Stop and remove cron job
    const entry = this.activeJobs.get(taskId);
    if (entry) {
      void entry.job.stop();
      this.activeJobs.delete(taskId);
      logger.info({ taskId }, 'Removed scheduled task');
    }

    // Issue #1953: Stop and remove event trigger
    const trigger = this.eventTriggers.get(taskId);
    if (trigger) {
      trigger.stop();
      this.eventTriggers.delete(taskId);
      logger.info({ taskId }, 'Removed event trigger for task');
    }
  }

  /**
   * Trigger a task execution by ID.
   *
   * Issue #1953: Public API for event-driven triggers.
   * Can be called by EventTriggerManager or other external triggers.
   * Goes through the same cooldown/blocking checks as cron triggers.
   *
   * @param taskId - Task ID to trigger
   * @returns true if the task was found and triggered, false otherwise
   */
  async triggerTask(taskId: string): Promise<boolean> {
    const entry = this.activeJobs.get(taskId);
    if (!entry) {
      logger.warn({ taskId }, 'Cannot trigger task: task not found in active jobs');
      return false;
    }

    logger.info(
      { taskId, name: entry.task.name, source: 'event' },
      'Task triggered by event'
    );

    await this.executeTask(entry.task);
    return true;
  }

  /**
   * Set up an event trigger for a task with a watch configuration.
   *
   * Issue #1953: Creates an EventTriggerManager that watches the
   * specified glob pattern and triggers task execution on file changes.
   *
   * @param task - Task with watch configuration
   */
  private setupEventTrigger(task: ScheduledTask): void {
    if (!task.watch) {
      return;
    }

    const trigger = new EventTriggerManager({
      baseDir: this.baseDir,
      pattern: task.watch,
      debounceMs: task.watchDebounce,
      onTrigger: () => {
        void this.triggerTask(task.id);
      },
    });

    // Start the event trigger (async, but we don't await in addTask)
    void trigger.start().then(() => {
      if (trigger.isRunning()) {
        this.eventTriggers.set(task.id, trigger);
        logger.info(
          { taskId: task.id, pattern: task.watch, debounceMs: task.watchDebounce ?? 5000 },
          'Event trigger active for task'
        );
      }
    }).catch((error) => {
      logger.error(
        { err: error, taskId: task.id, pattern: task.watch },
        'Failed to start event trigger'
      );
    });
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
   * Called by cron job when the schedule triggers,
   * or by triggerTask() for event-driven execution.
   *
   * Issue #711: Creates a short-lived ScheduleAgent for each execution.
   * Agent is disposed after execution to free resources.
   * Issue #869: Added cooldown period check before execution.
   * Issue #1041: Uses injected executor function.
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
      // Send start notification
      await this.callbacks.sendMessage(
        task.chatId,
        `⏰ 定时任务「${task.name}」开始执行...`
      );

      // Build wrapped prompt with anti-recursion instructions
      const wrappedPrompt = this.buildScheduledTaskPrompt(task);

      // Issue #1041: Use injected executor function
      // Issue #1338: Pass model override for per-task model selection
      await this.executor(task.chatId, wrappedPrompt, task.createdBy, task.model);

      logger.info({ taskId: task.id }, 'Scheduled task completed');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, taskId: task.id }, 'Scheduled task failed');

      // Send error notification
      await this.callbacks.sendMessage(
        task.chatId,
        `❌ 定时任务「${task.name}」执行失败: ${errorMessage}`
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

  /**
   * Get all active event trigger patterns.
   *
   * Issue #1953: Useful for debugging and monitoring.
   *
   * @returns Array of { taskId, pattern } for all active event triggers
   */
  getActiveEventTriggers(): Array<{ taskId: string; pattern: string }> {
    return Array.from(this.eventTriggers.entries()).map(([taskId, trigger]) => ({
      taskId,
      pattern: trigger.getPattern(),
    }));
  }
}
