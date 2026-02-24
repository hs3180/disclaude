/**
 * Scheduler module for Disclaude.
 *
 * Provides periodic task execution using cron schedules.
 * Tasks can invoke skills or execute prompts and send results to Feishu chats.
 *
 * Architecture:
 * ```
 * Config (schedules array)
 *   ↓
 * Scheduler (manages cron jobs)
 *   ↓
 * ScheduledTask (wraps cron job with execution logic)
 *   ↓
 * Pilot (executes the task)
 *   ↓
 * Feishu (sends results)
 * ```
 */

import { createLogger } from '../utils/logger.js';
import type { ScheduleConfig, SchedulerConfig } from '../config/types.js';
import { ScheduledTask } from './scheduled-task.js';

const logger = createLogger('Scheduler');

/**
 * Execution statistics for a scheduled task.
 */
export interface TaskStats {
  /** Task name */
  name: string;
  /** Number of times the task has been executed */
  runCount: number;
  /** Last execution timestamp */
  lastRun?: Date;
  /** Next execution timestamp */
  nextRun?: Date;
  /** Whether the task is currently running */
  isRunning: boolean;
  /** Last error message (if any) */
  lastError?: string;
}

/**
 * Scheduler state.
 */
interface SchedulerState {
  /** Whether the scheduler is running */
  isRunning: boolean;
  /** Managed scheduled tasks */
  tasks: Map<string, ScheduledTask>;
}

/**
 * Scheduler for managing periodic tasks.
 *
 * Supports:
 * - Cron-based scheduling
 * - Dynamic task addition/removal
 * - Task execution statistics
 * - Graceful shutdown
 */
export class Scheduler {
  private state: SchedulerState;

  constructor() {
    this.state = {
      isRunning: false,
      tasks: new Map(),
    };
  }

  /**
   * Load schedules from configuration.
   *
   * @param config - Scheduler configuration
   */
  loadSchedules(config: SchedulerConfig): void {
    const { schedules = [], enabled = true } = config;

    if (!enabled) {
      logger.info('Scheduler is disabled in configuration');
      return;
    }

    logger.info({ scheduleCount: schedules.length }, 'Loading schedules from configuration');

    for (const schedule of schedules) {
      this.addSchedule(schedule);
    }
  }

  /**
   * Add a schedule to the scheduler.
   *
   * @param schedule - Schedule configuration
   */
  addSchedule(schedule: ScheduleConfig): void {
    const { name, cron, enabled = true } = schedule;

    if (!enabled) {
      logger.debug({ name }, 'Schedule is disabled, skipping');
      return;
    }

    if (this.state.tasks.has(name)) {
      logger.warn({ name }, 'Schedule already exists, removing old one');
      this.removeSchedule(name);
    }

    logger.info({ name, cron }, 'Adding scheduled task');

    const task = new ScheduledTask(schedule);
    this.state.tasks.set(name, task);

    // Start the task if scheduler is already running
    if (this.state.isRunning) {
      task.start();
    }
  }

  /**
   * Remove a schedule from the scheduler.
   *
   * @param name - Schedule name
   */
  removeSchedule(name: string): void {
    const task = this.state.tasks.get(name);
    if (!task) {
      logger.warn({ name }, 'Schedule not found');
      return;
    }

    logger.info({ name }, 'Removing scheduled task');
    task.stop();
    this.state.tasks.delete(name);
  }

  /**
   * Start the scheduler.
   *
   * Begins execution of all registered scheduled tasks.
   */
  start(): void {
    if (this.state.isRunning) {
      logger.warn('Scheduler is already running');
      return;
    }

    logger.info('Starting scheduler');

    this.state.isRunning = true;

    for (const [name, task] of this.state.tasks) {
      logger.debug({ name }, 'Starting scheduled task');
      task.start();
    }

    logger.info({ taskCount: this.state.tasks.size }, 'Scheduler started');
  }

  /**
   * Stop the scheduler.
   *
   * Stops execution of all scheduled tasks.
   */
  stop(): void {
    if (!this.state.isRunning) {
      logger.warn('Scheduler is not running');
      return;
    }

    logger.info('Stopping scheduler');

    for (const [name, task] of this.state.tasks) {
      logger.debug({ name }, 'Stopping scheduled task');
      task.stop();
    }

    this.state.isRunning = false;

    logger.info('Scheduler stopped');
  }

  /**
   * Manually run a scheduled task.
   *
   * @param name - Schedule name
   * @throws Error if schedule not found
   */
  async runTask(name: string): Promise<void> {
    const task = this.state.tasks.get(name);
    if (!task) {
      throw new Error(`Scheduled task "${name}" not found`);
    }

    logger.info({ name }, 'Manually running scheduled task');
    await task.execute();
  }

  /**
   * Get statistics for all scheduled tasks.
   *
   * @returns Array of task statistics
   */
  getTaskStats(): TaskStats[] {
    const stats: TaskStats[] = [];

    for (const [name, task] of this.state.tasks) {
      const taskStats = task.getStats();
      stats.push({
        name,
        ...taskStats,
      });
    }

    return stats;
  }

  /**
   * Get a list of all schedule names.
   *
   * @returns Array of schedule names
   */
  getScheduleNames(): string[] {
    return Array.from(this.state.tasks.keys());
  }

  /**
   * Check if the scheduler is running.
   *
   * @returns true if scheduler is running
   */
  isActive(): boolean {
    return this.state.isRunning;
  }

  /**
   * Get the number of registered schedules.
   *
   * @returns Number of schedules
   */
  getScheduleCount(): number {
    return this.state.tasks.size;
  }

  /**
   * Clear all schedules.
   */
  clear(): void {
    logger.info('Clearing all schedules');

    for (const [_name, task] of this.state.tasks) {
      task.stop();
    }

    this.state.tasks.clear();
  }
}

/**
 * Global scheduler instance.
 */
let globalScheduler: Scheduler | null = null;

/**
 * Get the global scheduler instance.
 *
 * @returns Global scheduler
 */
export function getGlobalScheduler(): Scheduler {
  if (!globalScheduler) {
    globalScheduler = new Scheduler();
  }
  return globalScheduler;
}

/**
 * Reset the global scheduler instance.
 *
 * Useful for testing or configuration reload.
 */
export function resetGlobalScheduler(): void {
  if (globalScheduler) {
    globalScheduler.stop();
    globalScheduler.clear();
  }
  globalScheduler = null;
}
