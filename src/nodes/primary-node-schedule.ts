/**
 * Primary Node Schedule Management
 *
 * Extracted from primary-node.ts (Issue #695)
 * Handles schedule listing, enabling, disabling, and manual triggering.
 */

import * as path from 'path';
import { ScheduleManager } from '../schedule/schedule-manager.js';
import { ScheduleFileScanner } from '../schedule/schedule-watcher.js';
import { Config } from '../config/index.js';
import type { ScheduleTaskInfo } from './commands/types.js';
import type { SchedulerService } from './scheduler-service.js';
import type { AgentPool } from '../agents/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PrimaryNodeSchedule');

/**
 * Dependencies needed for schedule management.
 */
export interface ScheduleDeps {
  scheduleManager: ScheduleManager;
  scheduleFileScanner: ScheduleFileScanner;
  schedulerService?: SchedulerService;
  agentPool?: AgentPool;
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

/**
 * Primary Node Schedule Manager
 *
 * Encapsulates schedule management logic extracted from PrimaryNode.
 */
export class PrimaryNodeSchedule {
  private scheduleManager: ScheduleManager;
  private scheduleFileScanner: ScheduleFileScanner;
  private schedulerService?: SchedulerService;
  private agentPool?: AgentPool;
  private sendMessage: (chatId: string, text: string) => Promise<void>;

  constructor(deps: ScheduleDeps) {
    this.scheduleManager = deps.scheduleManager;
    this.scheduleFileScanner = deps.scheduleFileScanner;
    this.schedulerService = deps.schedulerService;
    this.agentPool = deps.agentPool;
    this.sendMessage = deps.sendMessage;
  }

  /**
   * Create schedule manager with default configuration.
   */
  static createDefault(): PrimaryNodeSchedule {
    const workspaceDir = Config.getWorkspaceDir();
    const schedulesDir = path.join(workspaceDir, 'schedules');
    const scheduleManager = new ScheduleManager({ schedulesDir });
    const scheduleFileScanner = new ScheduleFileScanner({ schedulesDir });

    return new PrimaryNodeSchedule({
      scheduleManager,
      scheduleFileScanner,
      sendMessage: async () => {}, // Placeholder, should be set via updateDeps
    });
  }

  /**
   * Update dependencies (for late binding).
   */
  updateDeps(deps: Partial<ScheduleDeps>): void {
    if (deps.schedulerService !== undefined) {
      this.schedulerService = deps.schedulerService;
    }
    if (deps.agentPool !== undefined) {
      this.agentPool = deps.agentPool;
    }
    if (deps.sendMessage !== undefined) {
      this.sendMessage = deps.sendMessage;
    }
  }

  /**
   * List all scheduled tasks.
   */
  async listSchedules(): Promise<ScheduleTaskInfo[]> {
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

  /**
   * Check if a task is currently running.
   */
  isTaskRunning(taskId: string): boolean {
    return this.schedulerService?.getScheduler()?.isTaskRunning(taskId) ?? false;
  }
}
