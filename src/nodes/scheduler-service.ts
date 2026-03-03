/**
 * SchedulerService - Manages scheduler and schedule file watcher.
 *
 * Extracts scheduler management concerns from PrimaryNode:
 * - Scheduler initialization and lifecycle
 * - Schedule file watching for hot reload
 * - Callbacks for schedule execution
 *
 * Architecture:
 * ```
 * PrimaryNode → SchedulerService → { Scheduler, ScheduleFileWatcher }
 *                      ↓
 *              ScheduleManager → schedule execution
 * ```
 */

import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import {
  ScheduleManager,
  Scheduler,
  ScheduleFileWatcher,
  ScheduleFileScanner,
} from '../schedule/index.js';
import type { FeedbackMessage } from '../types/websocket-messages.js';
import type { ChatAgent } from '../agents/types.js';
import type { ScheduledTask } from '../schedule/schedule-manager.js';

const logger = createLogger('SchedulerService');

/**
 * Callbacks for schedule execution.
 */
export interface SchedulerCallbacks {
  /** Send a text message */
  sendMessage: (chatId: string, text: string, threadMessageId?: string) => Promise<void>;
  /** Send a card message */
  sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string) => Promise<void>;
  /** Send a file */
  sendFile: (chatId: string, filePath: string) => Promise<void>;
  /** Handle feedback from schedule execution */
  handleFeedback: (feedback: FeedbackMessage) => void;
}

/**
 * Configuration for SchedulerService.
 */
export interface SchedulerServiceConfig {
  /** Callbacks for schedule execution */
  callbacks: SchedulerCallbacks;
  /** Pilot agent for schedule execution */
  pilot: ChatAgent;
}

/**
 * SchedulerService - Manages scheduler lifecycle.
 *
 * Handles:
 * - Scheduler initialization
 * - Schedule file watching
 * - Feedback routing to PrimaryNode
 * - Schedule CRUD operations (Issue #469)
 */
export class SchedulerService {
  private readonly callbacks: SchedulerCallbacks;
  private readonly pilot: SchedulerServiceConfig['pilot'];
  private scheduler?: Scheduler;
  private scheduleFileWatcher?: ScheduleFileWatcher;
  private fileScanner: ScheduleFileScanner;
  private schedulesDir: string;

  constructor(config: SchedulerServiceConfig) {
    this.callbacks = config.callbacks;
    this.pilot = config.pilot;

    const workspaceDir = Config.getWorkspaceDir();
    this.schedulesDir = path.join(workspaceDir, 'schedules');
    this.fileScanner = new ScheduleFileScanner({ schedulesDir: this.schedulesDir });
  }

  /**
   * Start the scheduler service.
   */
  async start(): Promise<void> {
    const scheduleManager = new ScheduleManager({ schedulesDir: this.schedulesDir });

    this.scheduler = new Scheduler({
      scheduleManager,
      pilot: this.pilot,
      callbacks: {
        // Directly route messages through PrimaryNode's handleFeedback
        // This ensures scheduled task messages are delivered even though
        // they don't go through PrimaryNode's activeFeedbackChannels map
        sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
          this.callbacks.handleFeedback({ type: 'text', chatId, text, threadId: threadMessageId });
          return Promise.resolve();
        },
        sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
          this.callbacks.handleFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId });
          return Promise.resolve();
        },
        sendFile: async (chatId: string, filePath: string) => {
          try {
            await this.callbacks.sendFile(chatId, filePath);
          } catch (error) {
            logger.error({ err: error, chatId, filePath }, 'Failed to send file for scheduled task');
          }
        },
      },
    });

    // Initialize file watcher for hot reload
    this.scheduleFileWatcher = new ScheduleFileWatcher({
      schedulesDir: this.schedulesDir,
      onFileAdded: (task) => {
        logger.info({ taskId: task.id, name: task.name }, 'Schedule file added, adding to scheduler');
        this.scheduler?.addTask(task);
      },
      onFileChanged: (task) => {
        logger.info({ taskId: task.id, name: task.name }, 'Schedule file changed, updating scheduler');
        this.scheduler?.addTask(task);
      },
      onFileRemoved: (taskId) => {
        logger.info({ taskId }, 'Schedule file removed, removing from scheduler');
        this.scheduler?.removeTask(taskId);
      },
    });

    // Start scheduler and file watcher
    await this.scheduler.start();
    await this.scheduleFileWatcher.start();

    logger.info('Scheduler service started');
  }

  /**
   * Stop the scheduler service.
   */
  stop(): void {
    this.scheduler?.stop();
    this.scheduleFileWatcher?.stop();
    logger.info('Scheduler service stopped');
  }

  /**
   * Get the scheduler instance.
   */
  getScheduler(): Scheduler | undefined {
    return this.scheduler;
  }

  // ============================================================================
  // Schedule CRUD Operations (Issue #469)
  // ============================================================================

  /**
   * List all scheduled tasks.
   *
   * @returns Array of all scheduled tasks
   */
  async listSchedules(): Promise<ScheduledTask[]> {
    const tasks = await this.fileScanner.scanAll();
    return tasks.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get a schedule by ID.
   *
   * @param taskId - Task ID
   * @returns The task or undefined if not found
   */
  async getSchedule(taskId: string): Promise<ScheduledTask | undefined> {
    const tasks = await this.fileScanner.scanAll();
    return tasks.find(t => t.id === taskId);
  }

  /**
   * Enable a scheduled task.
   *
   * @param taskId - Task ID to enable
   * @returns The updated task or undefined if not found
   */
  async enableSchedule(taskId: string): Promise<ScheduledTask | undefined> {
    const task = await this.getSchedule(taskId);
    if (!task) {
      return undefined;
    }

    if (task.enabled) {
      return task; // Already enabled
    }

    // Update the task file
    const updatedTask: ScheduledTask = { ...task, enabled: true };
    await this.fileScanner.writeTask(updatedTask);

    logger.info({ taskId, name: task.name }, 'Schedule enabled');
    return updatedTask;
  }

  /**
   * Disable a scheduled task.
   *
   * @param taskId - Task ID to disable
   * @returns The updated task or undefined if not found
   */
  async disableSchedule(taskId: string): Promise<ScheduledTask | undefined> {
    const task = await this.getSchedule(taskId);
    if (!task) {
      return undefined;
    }

    if (!task.enabled) {
      return task; // Already disabled
    }

    // Update the task file
    const updatedTask: ScheduledTask = { ...task, enabled: false };
    await this.fileScanner.writeTask(updatedTask);

    // Remove from scheduler immediately
    this.scheduler?.removeTask(taskId);

    logger.info({ taskId, name: task.name }, 'Schedule disabled');
    return updatedTask;
  }

  /**
   * Manually trigger a scheduled task.
   *
   * @param taskId - Task ID to run
   * @param chatId - Chat ID to send results to (optional, defaults to task's chatId)
   * @returns true if task was triggered, false if not found
   */
  async runSchedule(taskId: string, chatId?: string): Promise<boolean> {
    const task = await this.getSchedule(taskId);
    if (!task) {
      return false;
    }

    // Use provided chatId or task's chatId
    const targetChatId = chatId || task.chatId;

    // Execute the task
    logger.info({ taskId, name: task.name, chatId: targetChatId }, 'Manually triggering schedule');

    // Run the task asynchronously
    this.pilot.executeOnce(
      targetChatId,
      task.prompt,
      undefined,
      undefined
    ).then(() => {
      logger.info({ taskId }, 'Manually triggered schedule completed');
    }).catch(error => {
      logger.error({ err: error, taskId }, 'Manually triggered schedule failed');
    });

    return true;
  }

  /**
   * Get schedule status.
   *
   * @param taskId - Task ID (optional, if not provided returns scheduler status)
   * @returns Schedule status info
   */
  async getScheduleStatus(taskId?: string): Promise<{
    running: boolean;
    task?: ScheduledTask;
    isCurrentlyRunning?: boolean;
    activeJobsCount?: number;
  }> {
    if (taskId) {
      const task = await this.getSchedule(taskId);
      return {
        running: this.scheduler?.isRunning() ?? false,
        task,
        isCurrentlyRunning: this.scheduler?.isTaskRunning(taskId) ?? false,
      };
    }

    return {
      running: this.scheduler?.isRunning() ?? false,
      activeJobsCount: this.scheduler?.getActiveJobs().length ?? 0,
    };
  }
}
