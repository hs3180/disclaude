/**
 * Scheduler - Executes scheduled tasks using cron.
 *
 * Uses node-cron to schedule task execution.
 * Integrates with ScheduleManager for task management.
 *
 * Features:
 * - Dynamic task scheduling
 * - Integration with Pilot for task execution
 * - Automatic reload of tasks on schedule changes
 */

import { CronJob } from 'cron';
import { createLogger } from '../utils/logger.js';
import type { ScheduleManager, ScheduledTask } from './schedule-manager.js';
import type { Pilot } from '../agents/pilot.js';
import type { PilotCallbacks } from '../agents/pilot.js';

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
 */
export interface SchedulerOptions {
  /** ScheduleManager instance for task CRUD */
  scheduleManager: ScheduleManager;
  /** Pilot instance for task execution */
  pilot: Pilot;
  /** Callbacks for sending messages */
  callbacks: PilotCallbacks;
}

/**
 * Scheduler - Manages cron-based task execution.
 *
 * Usage:
 * ```typescript
 * const scheduler = new Scheduler({
 *   scheduleManager,
 *   pilot,
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
  private pilot: Pilot;
  private callbacks: PilotCallbacks;
  private activeJobs: Map<string, ActiveJob> = new Map();
  private running = false;

  constructor(options: SchedulerOptions) {
    this.scheduleManager = options.scheduleManager;
    this.pilot = options.pilot;
    this.callbacks = options.callbacks;
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
  async stop(): Promise<void> {
    this.running = false;

    for (const [taskId, entry] of this.activeJobs) {
      entry.job.stop();
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
  async addTask(task: ScheduledTask): Promise<void> {
    // Remove existing job if any
    await this.removeTask(task.id);

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
  async removeTask(taskId: string): Promise<void> {
    const entry = this.activeJobs.get(taskId);
    if (entry) {
      entry.job.stop();
      this.activeJobs.delete(taskId);
      logger.info({ taskId }, 'Removed scheduled task');
    }
  }

  /**
   * Execute a scheduled task.
   * Called by cron job when the schedule triggers.
   *
   * @param task - Task to execute
   */
  private async executeTask(task: ScheduledTask): Promise<void> {
    logger.info({ taskId: task.id, name: task.name }, 'Executing scheduled task');

    try {
      // Send start notification
      await this.callbacks.sendMessage(
        task.chatId,
        `⏰ 定时任务「${task.name}」开始执行...`
      );

      // Execute task using Pilot's executeOnce method
      await this.pilot.executeOnce(
        task.chatId,
        task.prompt,
        `${task.id}-${Date.now()}`,
        task.createdBy
      );

      // Update last execution time
      await this.scheduleManager.markExecuted(task.id);

      logger.info({ taskId: task.id }, 'Scheduled task completed');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, taskId: task.id }, 'Scheduled task failed');

      // Send error notification
      await this.callbacks.sendMessage(
        task.chatId,
        `❌ 定时任务「${task.name}」执行失败: ${errorMessage}`
      );
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
}
