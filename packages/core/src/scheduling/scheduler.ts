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
 * Issue #1953: Added event-driven trigger support.
 * - Tasks can declare trigger.events in frontmatter
 * - Scheduler subscribes to TriggerBus events for matching tasks
 * - Scheduler.trigger(taskId) allows direct invocation
 * - Cron remains as fallback
 *
 * Features:
 * - Dynamic task scheduling (cron + event-driven)
 * - Integration with executor function for task execution
 * - Automatic reload of tasks on schedule changes
 * - Direct task invocation via trigger()
 *
 * @module @disclaude/core/scheduling
 */

import { CronJob } from 'cron';
import { createLogger } from '../utils/logger.js';
import { CooldownManager } from './cooldown-manager.js';
import type { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';
import { TriggerBus, type TriggerHandler } from './trigger-bus.js';

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
  /**
   * TriggerBus for event-driven schedule triggering.
   * When provided, the scheduler will subscribe to events declared
   * in task trigger configurations and execute matching tasks.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   */
  triggerBus?: TriggerBus;
}

/**
 * Scheduler - Manages cron-based task execution.
 *
 * Issue #711: Uses short-lived ScheduleAgents (max 24h lifetime).
 * Each execution creates a fresh agent, ensuring isolation.
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
 * // Stop scheduler
 * await scheduler.stop();
 * ```
 */
export class Scheduler {
  private scheduleManager: ScheduleManager;
  private callbacks: SchedulerCallbacks;
  private executor: TaskExecutor;
  private cooldownManager?: CooldownManager;
  private triggerBus?: TriggerBus;
  private activeJobs: Map<string, ActiveJob> = new Map();
  private running = false;
  /** Tracks tasks currently being executed (for blocking mechanism) */
  private runningTasks: Set<string> = new Set();
  /**
   * Registered event trigger subscriptions.
   * Maps eventName -> Set of taskIds that should be triggered.
   *
   * Issue #1953: Event-driven trigger support.
   */
  private eventSubscriptions: Map<string, Set<string>> = new Map();
  /** Registered TriggerBus handler references for cleanup */
  private registeredHandlers: Map<string, TriggerHandler> = new Map();

  constructor(options: SchedulerOptions) {
    this.scheduleManager = options.scheduleManager;
    this.callbacks = options.callbacks;
    this.executor = options.executor;
    this.cooldownManager = options.cooldownManager;
    this.triggerBus = options.triggerBus;
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
   * Stop the scheduler.
   * Stops all active cron jobs and cleans up event subscriptions.
   *
   * Issue #1953: Also removes TriggerBus subscriptions.
   */
  stop(): void {
    this.running = false;

    // Issue #1953: Clean up all event trigger subscriptions
    for (const [event, handler] of this.registeredHandlers) {
      this.triggerBus?.off(event, handler);
    }
    this.registeredHandlers.clear();
    this.eventSubscriptions.clear();

    for (const [taskId, entry] of this.activeJobs) {
      void entry.job.stop();
      logger.debug({ taskId }, 'Stopped cron job');
    }

    this.activeJobs.clear();
    logger.info('Scheduler stopped');
  }

  /**
   * Add a task to the scheduler.
   * Creates a cron job for the task and registers event triggers if configured.
   *
   * Issue #1953: Also registers TriggerBus subscriptions for event-driven tasks.
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

    // Issue #1953: Register event-driven triggers
    if (task.trigger?.events && this.triggerBus) {
      this.registerEventTriggers(task);
    }
  }

  /**
   * Remove a task from the scheduler.
   * Stops the cron job and removes event trigger subscriptions.
   *
   * Issue #1953: Also cleans up TriggerBus subscriptions.
   *
   * @param taskId - Task ID to remove
   */
  removeTask(taskId: string): void {
    // Issue #1953: Unregister event triggers
    this.unregisterEventTriggers(taskId);

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
   * Trigger a task to execute immediately, bypassing cron schedule.
   *
   * Issue #1953: Direct invocation for event-driven triggering.
   * This is the core API for the event-driven trigger mechanism.
   *
   * The task must be:
   * 1. Currently loaded in the scheduler (added via addTask)
   * 2. Either have `trigger.invocable: true` or have any trigger config
   *
   * If the task is blocking and currently running, the trigger is skipped.
   * If the task is in cooldown, the trigger is skipped.
   *
   * @param taskId - Task ID to trigger
   * @returns true if the task was triggered, false if skipped
   */
  async trigger(taskId: string): Promise<boolean> {
    const entry = this.activeJobs.get(taskId);
    if (!entry) {
      logger.warn({ taskId }, 'Cannot trigger unknown task');
      return false;
    }

    const { task } = entry;

    // Check if task allows direct invocation
    const isInvocable = task.trigger?.invocable ?? (task.trigger?.events !== undefined || task.trigger?.watch !== undefined);
    if (!isInvocable) {
      logger.warn({ taskId, name: task.name }, 'Task is not invocable (no trigger config or invocable: false)');
      return false;
    }

    logger.info({ taskId, name: task.name, source: 'event-trigger' }, 'Triggering task immediately');
    await this.executeTask(task);
    return true;
  }

  /**
   * Trigger all tasks that listen for a specific event.
   *
   * Issue #1953: Maps TriggerBus events to task executions.
   *
   * @param event - Event name
   * @returns Array of task IDs that were triggered
   */
  async triggerByEvent(event: string): Promise<string[]> {
    const taskIds = this.eventSubscriptions.get(event);
    if (!taskIds || taskIds.size === 0) {
      return [];
    }

    const triggered: string[] = [];
    for (const taskId of taskIds) {
      const success = await this.trigger(taskId);
      if (success) {
        triggered.push(taskId);
      }
    }

    return triggered;
  }

  /**
   * Register event trigger subscriptions for a task.
   *
   * Issue #1953: Subscribes to TriggerBus events declared in task config.
   *
   * @param task - Task with trigger.events configuration
   */
  private registerEventTriggers(task: ScheduledTask): void {
    const events = task.trigger?.events;
    if (!events || !this.triggerBus) { return; }

    for (const event of events) {
      // Track subscription
      if (!this.eventSubscriptions.has(event)) {
        this.eventSubscriptions.set(event, new Set());

        // Register a single handler per event that dispatches to triggerByEvent
        const handler: TriggerHandler = () => {
          void this.triggerByEvent(event);
        };

        this.registeredHandlers.set(event, handler);
        this.triggerBus.on(event, handler);
      }

      this.eventSubscriptions.get(event)?.add(task.id);
      logger.info({ taskId: task.id, event, name: task.name }, 'Registered event trigger');
    }
  }

  /**
   * Unregister event trigger subscriptions for a task.
   *
   * Issue #1953: Cleans up TriggerBus subscriptions when task is removed.
   *
   * @param taskId - Task ID to unregister
   */
  private unregisterEventTriggers(taskId: string): void {
    if (!this.triggerBus) { return; }

    for (const [event, taskIds] of this.eventSubscriptions) {
      if (taskIds.delete(taskId)) {
        logger.debug({ taskId, event }, 'Unregistered event trigger');

        // If no more tasks listen to this event, remove the handler
        if (taskIds.size === 0) {
          const handler = this.registeredHandlers.get(event);
          if (handler) {
            this.triggerBus.off(event, handler);
            this.registeredHandlers.delete(event);
          }
          this.eventSubscriptions.delete(event);
        }
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
