/**
 * Scheduler - Executes scheduled tasks using cron and event triggers.
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
 * Issue #1953: Added event-driven trigger support.
 * - Tasks can be triggered immediately via triggerNow()
 * - EventTrigger watches file paths and calls triggerNow()
 * - Cron acts as fallback for missed events
 *
 * Features:
 * - Dynamic task scheduling
 * - Integration with executor function for task execution
 * - Automatic reload of tasks on schedule changes
 * - Event-driven triggering with file watchers
 *
 * @module @disclaude/core/scheduling
 */

import { CronJob } from 'cron';
import { createLogger } from '../utils/logger.js';
import { CooldownManager } from './cooldown-manager.js';
import { EventTrigger } from './event-trigger.js';
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
}

/**
 * Scheduler - Manages cron-based and event-driven task execution.
 *
 * Issue #711: Uses short-lived ScheduleAgents (max 24h lifetime).
 * Each execution creates a fresh agent, ensuring isolation.
 * Issue #1041: Uses dependency injection for task execution.
 * Issue #1953: Added event-driven trigger support (triggerNow + EventTrigger).
 *
 * Usage:
 * ```typescript
 * const scheduler = new Scheduler({
 *   scheduleManager,
 *   callbacks,
 *   executor: async (chatId, prompt, userId) => {
 *     // Create and run agent
 *     const agent = AgentFactory.createAgent(chatId, callbacks);
 *     await agent.executeOnce(chatId, prompt, undefined, userId);
 *     agent.dispose();
 *   },
 * });
 *
 * // Start scheduler (loads and schedules all enabled tasks)
 * await scheduler.start();
 *
 * // Add a new task dynamically
 * scheduler.addTask(task);
 *
 * // Trigger a task immediately (event-driven)
 * scheduler.triggerNow('schedule-my-task');
 *
 * // Stop scheduler
 * scheduler.stop();
 * ```
 */
export class Scheduler {
  private scheduleManager: ScheduleManager;
  private callbacks: SchedulerCallbacks;
  private executor: TaskExecutor;
  private cooldownManager?: CooldownManager;
  private activeJobs: Map<string, ActiveJob> = new Map();
  private running = false;
  /** Tracks tasks currently being executed (for blocking mechanism) */
  private runningTasks: Set<string> = new Set();
  /** Issue #1953: Active event triggers indexed by task ID */
  private eventTriggers: Map<string, EventTrigger> = new Map();

  constructor(options: SchedulerOptions) {
    this.scheduleManager = options.scheduleManager;
    this.callbacks = options.callbacks;
    this.executor = options.executor;
    this.cooldownManager = options.cooldownManager;
    logger.info('Scheduler created');
  }

  /**
   * Start the scheduler.
   * Loads all enabled tasks and schedules them.
   * Issue #1953: Also starts event triggers for tasks with trigger config.
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
      this.addTask(task);
    }

    // Issue #1953: Start event triggers for tasks with trigger config
    await this.startEventTriggers();

    logger.info({ taskCount: this.activeJobs.size }, 'Scheduler started');
  }

  /**
   * Stop the scheduler.
   * Stops all active cron jobs and event triggers.
   */
  stop(): void {
    this.running = false;

    // Stop event triggers
    this.stopEventTriggers();

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
   * Issue #1953: Also sets up event trigger if trigger config is present.
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

    // Issue #1953: Set up event trigger if configured
    if (task.trigger && task.trigger.watch.length > 0) {
      this.setupEventTrigger(task);
    }
  }

  /**
   * Remove a task from the scheduler.
   * Also removes associated event trigger.
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

    // Issue #1953: Remove event trigger
    const trigger = this.eventTriggers.get(taskId);
    if (trigger) {
      trigger.stop();
      this.eventTriggers.delete(taskId);
      logger.info({ taskId }, 'Removed event trigger');
    }
  }

  /**
   * Immediately trigger a task execution, bypassing the cron schedule.
   *
   * Issue #1953: Direct invocation method (Method D).
   * This is the primary API for event-driven scheduling.
   *
   * Respects:
   * - Blocking: skips if task is already running
   * - Cooldown: skips if in cooldown period
   *
   * @param taskId - The task ID to trigger
   * @returns true if the task was triggered, false if skipped
   */
  async triggerNow(taskId: string): Promise<boolean> {
    const entry = this.activeJobs.get(taskId);
    if (!entry) {
      logger.warn({ taskId }, 'triggerNow: task not found');
      return false;
    }

    const {task} = entry;

    // Check blocking
    if (task.blocking && this.runningTasks.has(task.id)) {
      logger.info(
        { taskId: task.id, name: task.name },
        'triggerNow: skipped - previous execution still running',
      );
      return false;
    }

    // Check cooldown
    if (task.cooldownPeriod && this.cooldownManager) {
      const isInCooldown = await this.cooldownManager.isInCooldown(task.id, task.cooldownPeriod);
      if (isInCooldown) {
        logger.info(
          { taskId: task.id, name: task.name },
          'triggerNow: skipped - in cooldown period',
        );
        return false;
      }
    }

    logger.info({ taskId: task.id, name: task.name, source: 'event-trigger' }, 'Triggering task immediately');

    // Execute in background (don't await to allow debounced triggers to return quickly)
    void this.executeTask(task);
    return true;
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
   * Called by cron job when the schedule triggers or by triggerNow().
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
   * Issue #1953: Set up an EventTrigger for a task.
   *
   * @param task - Task with trigger configuration
   */
  private setupEventTrigger(task: ScheduledTask): void {
    // Remove existing trigger if any
    const existing = this.eventTriggers.get(task.id);
    if (existing) {
      existing.stop();
    }

    // Safe to use trigger config — caller guarantees it exists
    const triggerConfig = task.trigger as import('./scheduled-task.js').ScheduleTriggerConfig;

    const trigger = new EventTrigger({
      taskId: task.id,
      watchPaths: triggerConfig.watch,
      debounce: triggerConfig.debounce,
      onTrigger: (taskId) => {
        void this.triggerNow(taskId);
      },
    });

    this.eventTriggers.set(task.id, trigger);

    // Start the trigger if scheduler is running
    if (this.running) {
      void trigger.start();
    }

    logger.info(
      { taskId: task.id, watchPaths: triggerConfig.watch, debounce: triggerConfig.debounce },
      'Event trigger configured for task',
    );
  }

  /**
   * Issue #1953: Start all configured event triggers.
   */
  private async startEventTriggers(): Promise<void> {
    for (const [taskId, trigger] of this.eventTriggers) {
      try {
        await trigger.start();
      } catch (error) {
        logger.error(
          { err: error, taskId },
          'Failed to start event trigger — cron fallback will handle this task',
        );
      }
    }
  }

  /**
   * Issue #1953: Stop all event triggers.
   */
  private stopEventTriggers(): void {
    for (const [taskId, trigger] of this.eventTriggers) {
      trigger.stop();
      logger.debug({ taskId }, 'Stopped event trigger');
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
   * Issue #1953: Get active event triggers.
   */
  getEventTriggers(): Map<string, EventTrigger> {
    return this.eventTriggers;
  }
}
