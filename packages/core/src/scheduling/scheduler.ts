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
 * Features:
 * - Dynamic task scheduling
 * - Integration with executor function for task execution
 * - Automatic reload of tasks on schedule changes
 *
 * @module @disclaude/core/scheduling
 */

import { CronJob } from 'cron';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger.js';
import { CooldownManager } from './cooldown-manager.js';
import type { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';
import type { ModelTier } from '../config/types.js';
import type { INonUserMessageRouter, NonUserMessage, NonUserMessagePriority } from '../non-user-message/types.js';

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
 * @param modelTier - Optional model tier for tier-based model resolution (Issue #3059)
 */
export type TaskExecutor = (chatId: string, prompt: string, userId?: string, model?: string, modelTier?: ModelTier) => Promise<void>;

/**
 * Scheduler options.
 *
 * Issue #711: No longer requires AgentPool.
 * Uses executor function for task execution.
 * Issue #869: Added cooldownManager for cooldown period support.
 * Issue #1041: Uses dependency injection for executor.
 * Issue #3333: Added nonUserMessageRouter for project-bound task routing.
 */
export interface SchedulerOptions {
  /** ScheduleManager instance for task CRUD */
  scheduleManager: ScheduleManager;
  /** Callbacks for sending messages */
  callbacks: SchedulerCallbacks;
  /** Task executor function (for tasks without projectKey) */
  executor: TaskExecutor;
  /** CooldownManager for cooldown period management */
  cooldownManager?: CooldownManager;
  /**
   * NonUserMessageRouter for project-bound task routing.
   *
   * When provided, tasks with `projectKey` will be routed via the router
   * to a persistent project-bound ChatAgent instead of creating a short-lived agent.
   *
   * Issue #3333: Scheduler integration with NonUserMessage (Phase 3 of RFC #3329).
   */
  nonUserMessageRouter?: INonUserMessageRouter;
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
  private nonUserMessageRouter?: INonUserMessageRouter;
  private activeJobs: Map<string, ActiveJob> = new Map();
  private running = false;
  /** Tracks tasks currently being executed (for blocking mechanism) */
  private runningTasks: Set<string> = new Set();

  constructor(options: SchedulerOptions) {
    this.scheduleManager = options.scheduleManager;
    this.callbacks = options.callbacks;
    this.executor = options.executor;
    this.cooldownManager = options.cooldownManager;
    this.nonUserMessageRouter = options.nonUserMessageRouter;
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
   * Issue #3333: When task has `projectKey`, routes via NonUserMessageRouter
   *   to a persistent project-bound ChatAgent instead of creating a short-lived agent.
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
      // Issue #3333: Route via NonUserMessageRouter when projectKey is set
      if (task.projectKey && this.nonUserMessageRouter) {
        await this.executeViaRouter(task);
      } else {
        await this.executeViaShortLivedAgent(task);
      }

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
   * Execute a task by routing it as a NonUserMessage to a project-bound ChatAgent.
   *
   * Issue #3333: Project-bound agents maintain context between scheduled executions,
   * unlike short-lived agents which start fresh each time.
   *
   * @param task - Task with projectKey set
   */
  private async executeViaRouter(task: ScheduledTask): Promise<void> {
    // Defensive check: this method is only called when both projectKey and router are set
    if (!task.projectKey || !this.nonUserMessageRouter) {
      throw new Error('executeViaRouter called without projectKey or router');
    }
    const { projectKey } = task;
    const router = this.nonUserMessageRouter;

    // Send start notification
    await this.callbacks.sendMessage(
      task.chatId,
      `⏰ 定时任务「${task.name}」开始执行 (project: ${projectKey})...`
    );

    // Build wrapped prompt with anti-recursion instructions
    const wrappedPrompt = this.buildScheduledTaskPrompt(task);

    // Construct NonUserMessage for routing
    const message: NonUserMessage = {
      id: randomUUID(),
      type: 'scheduled',
      source: `scheduler:${task.id}`,
      projectKey,
      payload: wrappedPrompt,
      priority: this.resolveMessagePriority(task),
      createdAt: new Date().toISOString(),
    };

    logger.info(
      { taskId: task.id, projectKey, messageId: message.id },
      'Routing scheduled task via NonUserMessageRouter'
    );

    const result = await router.route(message);

    if (!result.ok) {
      throw new Error(`NonUserMessage routing failed: ${result.error ?? 'unknown error'}`);
    }

    logger.info(
      { taskId: task.id, projectKey: task.projectKey, messageId: message.id },
      'NonUserMessage routed successfully'
    );
  }

  /**
   * Execute a task using the existing short-lived agent path.
   *
   * This is the original execution path that creates a fresh ChatAgent
   * for each execution and disposes it afterward.
   *
   * @param task - Task without projectKey (or no router configured)
   */
  private async executeViaShortLivedAgent(task: ScheduledTask): Promise<void> {
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
    await this.executor(task.chatId, wrappedPrompt, task.createdBy, task.model, task.modelTier);
  }

  /**
   * Resolve NonUserMessage priority from task configuration.
   *
   * Maps task model tier to message priority for queue ordering.
   * This allows high-priority tasks to be processed before normal ones.
   *
   * @param task - Scheduled task
   * @returns Message priority level
   */
  private resolveMessagePriority(task: ScheduledTask): NonUserMessagePriority {
    // Future: could be a configurable field on the task itself
    // For now, map model tier to priority as a reasonable default
    switch (task.modelTier) {
      case 'high': return 'high';
      case 'low': return 'low';
      default: return 'normal';
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
}
