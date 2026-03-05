/**
 * ScheduleCommandService - Schedule management for commands.
 *
 * Extracts schedule command concerns from PrimaryNode:
 * - List schedules with status
 * - Get schedule by name or ID
 * - Enable/disable schedules
 * - Manual schedule execution
 *
 * Issue #695: Refactored from primary-node.ts
 *
 * @module nodes/schedule-command-service
 */

import { createLogger } from '../utils/logger.js';
import type { ScheduleTaskInfo } from './commands/types.js';
import type { Scheduler } from '../schedule/scheduler.js';
import type { ScheduleManager } from '../schedule/schedule-manager.js';
import type { ScheduleFileScanner } from '../schedule/schedule-watcher.js';
import type { AgentPool } from '../agents/agent-pool.js';

const logger = createLogger('ScheduleCommandService');

/**
 * Callbacks for schedule command service.
 */
export interface ScheduleCommandCallbacks {
  /** Send a text message */
  sendMessage: (chatId: string, text: string, threadMessageId?: string) => Promise<void>;
}

/**
 * Configuration for ScheduleCommandService.
 */
export interface ScheduleCommandServiceConfig {
  /** Schedule manager instance */
  scheduleManager: ScheduleManager;
  /** Schedule file scanner instance */
  scheduleFileScanner: ScheduleFileScanner;
  /** Scheduler instance getter */
  getScheduler: () => Scheduler | undefined;
  /** Agent pool for manual execution */
  agentPool?: AgentPool;
  /** Callbacks for messaging */
  callbacks: ScheduleCommandCallbacks;
}

/**
 * ScheduleCommandService - Handles schedule-related commands.
 *
 * Used by PrimaryNode to implement /schedule command functionality.
 */
export class ScheduleCommandService {
  private readonly scheduleManager: ScheduleManager;
  private readonly scheduleFileScanner: ScheduleFileScanner;
  private readonly getScheduler: () => Scheduler | undefined;
  private readonly agentPool?: AgentPool;
  private readonly callbacks: ScheduleCommandCallbacks;

  constructor(config: ScheduleCommandServiceConfig) {
    this.scheduleManager = config.scheduleManager;
    this.scheduleFileScanner = config.scheduleFileScanner;
    this.getScheduler = config.getScheduler;
    this.agentPool = config.agentPool;
    this.callbacks = config.callbacks;
  }

  /**
   * List all scheduled tasks.
   */
  async listSchedules(): Promise<ScheduleTaskInfo[]> {
    const tasks = await this.scheduleManager.listAll();
    const scheduler = this.getScheduler();
    const activeJobs = scheduler?.getActiveJobs() ?? [];

    return tasks.map(task => {
      const activeJob = activeJobs.find(j => j.taskId === task.id);
      return {
        id: task.id,
        name: task.name,
        cron: task.cron,
        enabled: task.enabled,
        isScheduled: !!activeJob,
        isRunning: scheduler?.isTaskRunning(task.id) ?? false,
        chatId: task.chatId,
        createdAt: task.createdAt,
      };
    });
  }

  /**
   * Get a schedule by name or ID.
   */
  async getSchedule(nameOrId: string): Promise<ScheduleTaskInfo | undefined> {
    const tasks = await this.listSchedules();

    // Try to find by ID first, then by name
    return tasks.find(t => t.id === nameOrId || t.id === `schedule-${nameOrId}` || t.name === nameOrId);
  }

  /**
   * Enable a schedule.
   */
  async enableSchedule(nameOrId: string): Promise<boolean> {
    const task = await this.getSchedule(nameOrId);
    if (!task) {
      return false;
    }

    // If already enabled, return false
    if (task.enabled) {
      return false;
    }

    // Update the task file
    const fullTask = await this.scheduleManager.get(task.id);
    if (!fullTask) {
      return false;
    }

    const updatedTask = { ...fullTask, enabled: true };
    await this.scheduleFileScanner.writeTask(updatedTask);

    return true;
  }

  /**
   * Disable a schedule.
   */
  async disableSchedule(nameOrId: string): Promise<boolean> {
    const task = await this.getSchedule(nameOrId);
    if (!task) {
      return false;
    }

    // If already disabled, return false
    if (!task.enabled) {
      return false;
    }

    // Update the task file
    const fullTask = await this.scheduleManager.get(task.id);
    if (!fullTask) {
      return false;
    }

    const updatedTask = { ...fullTask, enabled: false };
    await this.scheduleFileScanner.writeTask(updatedTask);

    return true;
  }

  /**
   * Manually trigger a schedule.
   */
  async runSchedule(nameOrId: string): Promise<boolean> {
    const task = await this.getSchedule(nameOrId);
    if (!task) {
      return false;
    }

    // Get the full task
    const fullTask = await this.scheduleManager.get(task.id);
    if (!fullTask) {
      return false;
    }

    // Execute the task directly
    try {
      // Send start notification
      await this.callbacks.sendMessage(fullTask.chatId, `🚀 手动触发定时任务「${fullTask.name}」开始执行...`);

      // Execute task using Pilot
      if (this.agentPool) {
        const pilot = this.agentPool.getOrCreate(fullTask.chatId);
        await pilot.executeOnce(
          fullTask.chatId,
          fullTask.prompt,
          undefined,
          fullTask.createdBy
        );
      }

      return true;
    } catch (error) {
      logger.error({ err: error, taskId: task.id }, 'Failed to run schedule manually');
      return false;
    }
  }
}
