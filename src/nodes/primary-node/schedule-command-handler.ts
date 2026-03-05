/**
 * ScheduleCommandHandler - Handles schedule-related commands.
 *
 * Extracted from PrimaryNode (Issue #695):
 * - listSchedules, getSchedule, enableSchedule, disableSchedule, runSchedule
 *
 * This module provides command handlers for schedule management,
 * separating command logic from the main PrimaryNode class.
 */

import { createLogger } from '../../utils/logger.js';
import type { ScheduleManager } from '../../schedule/schedule-manager.js';
import type { ScheduleFileScanner } from '../../schedule/schedule-watcher.js';
import type { AgentPool } from '../../agents/agent-pool.js';
import type { ScheduleTaskInfo } from '../commands/types.js';

const logger = createLogger('ScheduleCommandHandler');

/**
 * Dependencies required by ScheduleCommandHandler.
 */
export interface ScheduleCommandHandlerDeps {
  scheduleManager?: ScheduleManager;
  scheduleFileScanner?: ScheduleFileScanner;
  schedulerService?: {
    getScheduler: () => { getActiveJobs: () => { taskId: string }[]; isTaskRunning: (taskId: string) => boolean } | undefined;
  };
  agentPool?: AgentPool;
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

/**
 * ScheduleCommandHandler - Handles schedule management commands.
 */
export class ScheduleCommandHandler {
  private scheduleManager?: ScheduleManager;
  private scheduleFileScanner?: ScheduleFileScanner;
  private schedulerService?: ScheduleCommandHandlerDeps['schedulerService'];
  private agentPool?: AgentPool;
  private sendMessage: (chatId: string, text: string) => Promise<void>;

  constructor(deps: ScheduleCommandHandlerDeps) {
    this.scheduleManager = deps.scheduleManager;
    this.scheduleFileScanner = deps.scheduleFileScanner;
    this.schedulerService = deps.schedulerService;
    this.agentPool = deps.agentPool;
    this.sendMessage = deps.sendMessage;
  }

  /**
   * List all scheduled tasks.
   */
  async listSchedules(): Promise<ScheduleTaskInfo[]> {
    if (!this.scheduleManager) {
      return [];
    }

    const tasks = await this.scheduleManager.listAll();
    const scheduler = this.schedulerService?.getScheduler();
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
    const fullTask = await this.scheduleManager?.get(task.id);
    if (!fullTask) {
      return false;
    }

    const updatedTask = { ...fullTask, enabled: true };
    await this.scheduleFileScanner?.writeTask(updatedTask);

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
    const fullTask = await this.scheduleManager?.get(task.id);
    if (!fullTask) {
      return false;
    }

    const updatedTask = { ...fullTask, enabled: false };
    await this.scheduleFileScanner?.writeTask(updatedTask);

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
    const fullTask = await this.scheduleManager?.get(task.id);
    if (!fullTask) {
      return false;
    }

    // Execute the task directly
    try {
      // Send start notification
      await this.sendMessage(fullTask.chatId, `🚀 手动触发定时任务「${fullTask.name}」开始执行...`);

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
