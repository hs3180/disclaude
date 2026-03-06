/**
 * Schedule Management Module for PrimaryNode.
 *
 * Extracted from primary-node.ts (Issue #695) to improve maintainability.
 * Handles schedule listing, enabling, disabling, and manual execution.
 *
 * Issue #469: 定时任务控制指令
 */

import { createLogger } from '../utils/logger.js';
import type { ScheduleManager } from '../schedule/schedule-manager.js';
import type { ScheduleFileScanner } from '../schedule/schedule-watcher.js';
import type { SchedulerService } from './scheduler-service.js';
import type { ScheduleTaskInfo } from './commands/types.js';

const logger = createLogger('ScheduleManagement');

/**
 * Dependencies needed for schedule management.
 */
export interface ScheduleManagementDeps {
  /** Schedule manager for task operations */
  scheduleManager?: ScheduleManager;
  /** File scanner for updating task files */
  scheduleFileScanner?: ScheduleFileScanner;
  /** Scheduler service for getting scheduler instance */
  schedulerService?: SchedulerService;
  /** Agent pool for executing tasks */
  agentPool?: {
    getOrCreateChatAgent: (chatId: string) => {
      executeOnce: (chatId: string, prompt: string, messageId?: string, userId?: string) => Promise<void>;
    };
  };
  /** Send message callback */
  sendMessage: (chatId: string, text: string, threadId?: string) => Promise<void>;
}

/**
 * Schedule management operations extracted from PrimaryNode.
 */
export class ScheduleManagement {
  constructor(private deps: ScheduleManagementDeps) {}

  /**
   * List all scheduled tasks.
   */
  async listSchedules(): Promise<ScheduleTaskInfo[]> {
    if (!this.deps.scheduleManager) {
      return [];
    }

    const tasks = await this.deps.scheduleManager.listAll();
    const scheduler = this.deps.schedulerService?.getScheduler();
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
    const fullTask = await this.deps.scheduleManager?.get(task.id);
    if (!fullTask) {
      return false;
    }

    const updatedTask = { ...fullTask, enabled: true };
    await this.deps.scheduleFileScanner?.writeTask(updatedTask);

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
    const fullTask = await this.deps.scheduleManager?.get(task.id);
    if (!fullTask) {
      return false;
    }

    const updatedTask = { ...fullTask, enabled: false };
    await this.deps.scheduleFileScanner?.writeTask(updatedTask);

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
    const fullTask = await this.deps.scheduleManager?.get(task.id);
    if (!fullTask) {
      return false;
    }

    // Execute the task directly
    try {
      // Send start notification
      await this.deps.sendMessage(fullTask.chatId, `🚀 手动触发定时任务「${fullTask.name}」开始执行...`);

      // Execute task using ChatAgent
      if (this.deps.agentPool) {
        const agent = this.deps.agentPool.getOrCreateChatAgent(fullTask.chatId);
        await agent.executeOnce(
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

  /**
   * Check if a schedule is currently running.
   */
  isScheduleRunning(taskId: string): boolean {
    return this.deps.schedulerService?.getScheduler()?.isTaskRunning(taskId) ?? false;
  }
}
