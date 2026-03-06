/**
 * Scheduler - Executes scheduled tasks using cron.
 *
 * Uses node-cron to schedule task execution.
 * Integrates with ScheduleManager for task management.
 *
 * Issue #711: Uses short-lived ScheduleAgents instead of AgentPool.
 * - Each task execution creates a new ScheduleAgent
 * - Agent is disposed after execution completes
 * - No persistent agent state between executions
 *
 * Issue #869: Cooldown period support.
 * - Tasks can have a cooldown period to prevent duplicate executions
 * - Cooldown state is persisted to survive service restarts
 *
 * Features:
 * - Dynamic task scheduling
 * - Integration with AgentFactory for task execution
 * - Automatic reload of tasks on schedule changes
 * - Cooldown period support (Issue #869)
 */

import { CronJob } from 'cron';
import { createLogger } from '../utils/logger.js';
import { AgentFactory } from '../agents/index.js';
import { CooldownManager } from './cooldown-manager.js';
import type { ScheduleManager, ScheduledTask } from './schedule-manager.js';
import type { PilotCallbacks } from '../agents/pilot/index.js';
import type { ChatAgent } from '../agents/types.js';

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
 * Scheduler options.
 *
 * Issue #711: No longer requires AgentPool.
 * Uses AgentFactory.createScheduleAgent for short-lived agents.
 *
 * Issue #869: Added cooldownManager for cooldown period support.
 */
export interface SchedulerOptions {
  /** ScheduleManager instance for task CRUD */
  scheduleManager: ScheduleManager;
  /** Callbacks for sending messages */
  callbacks: PilotCallbacks;
  /**
   * CooldownManager instance for cooldown period management.
   * If not provided, a default one will be created.
   * @see Issue #869
   */
  cooldownManager?: CooldownManager;
  /**
   * Directory for cooldown state files.
   * Only used if cooldownManager is not provided.
   * @default './workspace/schedules/.cooldown'
   */
  cooldownDir?: string;
}

/**
 * Scheduler - Manages cron-based task execution.
 *
 * Issue #711: Uses short-lived ScheduleAgents (max 24h lifetime).
 * Each execution creates a fresh agent, ensuring isolation.
 *
 * Issue #869: Supports cooldown period to prevent duplicate executions.
 *
 * Usage:
 * ```typescript
 * const scheduler = new Scheduler({
 *   scheduleManager,
 *   callbacks,
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
  private callbacks: PilotCallbacks;
  private cooldownManager: CooldownManager;
  private activeJobs: Map<string, ActiveJob> = new Map();
  private running = false;
  /** Tracks tasks currently being executed (for blocking mechanism) */
  private runningTasks: Set<string> = new Set();

  constructor(options: SchedulerOptions) {
    this.scheduleManager = options.scheduleManager;
    this.callbacks = options.callbacks;

    // Initialize CooldownManager (Issue #869)
    if (options.cooldownManager) {
      this.cooldownManager = options.cooldownManager;
    } else {
      const cooldownDir = options.cooldownDir || './workspace/schedules/.cooldown';
      this.cooldownManager = new CooldownManager({ cooldownDir });
    }

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
   * Issue #711: Creates a short-lived ScheduleAgent for each execution.
   * Agent is disposed after execution to free resources.
   *
   * Issue #869: Checks cooldown period before execution.
   *
   * @param task - Task to execute
   */
  private async executeTask(task: ScheduledTask): Promise<void> {
    // Check cooldown period (Issue #869)
    const cooldownPeriod = task.cooldownPeriod || 0;
    if (cooldownPeriod > 0) {
      const cooldownStatus = await this.cooldownManager.checkCooldown(task.id, cooldownPeriod);

      if (cooldownStatus.inCooldown) {
        const remainingMinutes = Math.ceil(cooldownStatus.remainingMs / 60000);
        logger.info(
          {
            taskId: task.id,
            name: task.name,
            lastExecution: cooldownStatus.lastExecutionTime,
            cooldownEndsAt: cooldownStatus.cooldownEndsAt,
            remainingMs: cooldownStatus.remainingMs,
          },
          'Task skipped - in cooldown period'
        );

        // Send cooldown notification
        await this.callbacks.sendMessage(
          task.chatId,
          `⏰ 定时任务「${task.name}」冷静期中，跳过执行
- 上次执行: ${cooldownStatus.lastExecutionTime}
- 冷静期结束: ${cooldownStatus.cooldownEndsAt}
- 剩余时间: ${remainingMinutes} 分钟`
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

    // Issue #711: Create a short-lived ScheduleAgent
    // Not stored in AgentPool - disposed after execution
    let agent: ChatAgent | undefined;

    try {
      // Send start notification
      await this.callbacks.sendMessage(
        task.chatId,
        `⏰ 定时任务「${task.name}」开始执行...`
      );

      // Build wrapped prompt with anti-recursion instructions
      const wrappedPrompt = this.buildScheduledTaskPrompt(task);

      // Issue #711: Create ScheduleAgent (short-lived, not in AgentPool)
      agent = AgentFactory.createScheduleAgent(task.chatId, this.callbacks);

      // Execute task using agent's executeOnce method
      // messageId is undefined - scheduled tasks send new messages, not replies
      await agent.executeOnce(
        task.chatId,
        wrappedPrompt,
        undefined,
        task.createdBy
      );

      // Record execution for cooldown tracking (Issue #869)
      if (cooldownPeriod > 0) {
        await this.cooldownManager.recordExecution(task.id, cooldownPeriod);
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

      // Issue #711: Always dispose the agent after execution
      if (agent) {
        try {
          agent.dispose();
          logger.debug({ taskId: task.id }, 'ScheduleAgent disposed');
        } catch (err) {
          logger.error({ err, taskId: task.id }, 'Error disposing ScheduleAgent');
        }
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
   * Get the CooldownManager instance.
   * Used for cooldown status queries and manual clearing.
   *
   * @returns The CooldownManager instance
   * @see Issue #869
   */
  getCooldownManager(): CooldownManager {
    return this.cooldownManager;
  }
}
