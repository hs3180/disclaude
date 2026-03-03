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
 */
export class SchedulerService {
  private readonly callbacks: SchedulerCallbacks;
  private readonly pilot: SchedulerServiceConfig['pilot'];
  private scheduler?: Scheduler;
  private scheduleFileWatcher?: ScheduleFileWatcher;
  private scheduleManager?: ScheduleManager;
  private fileScanner?: ScheduleFileScanner;
  private schedulesDir: string;

  constructor(config: SchedulerServiceConfig) {
    this.callbacks = config.callbacks;
    this.pilot = config.pilot;

    const workspaceDir = Config.getWorkspaceDir();
    this.schedulesDir = path.join(workspaceDir, 'schedules');
  }

  /**
   * Start the scheduler service.
   */
  async start(): Promise<void> {
    this.scheduleManager = new ScheduleManager({ schedulesDir: this.schedulesDir });
    this.fileScanner = new ScheduleFileScanner({ schedulesDir: this.schedulesDir });

    this.scheduler = new Scheduler({
      scheduleManager: this.scheduleManager,
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

  /**
   * Get the schedule manager instance.
   */
  getScheduleManager(): ScheduleManager | undefined {
    return this.scheduleManager;
  }

  /**
   * List all schedules for a specific chat.
   */
  async listSchedules(chatId: string): Promise<{
    id: string;
    name: string;
    cron: string;
    enabled: boolean;
    isRunning?: boolean;
  }[]> {
    if (!this.scheduleManager || !this.scheduler) {
      return [];
    }

    const tasks = await this.scheduleManager.listByChatId(chatId);
    return tasks.map(task => ({
      id: task.id,
      name: task.name,
      cron: task.cron,
      enabled: task.enabled,
      isRunning: this.scheduler!.isTaskRunning(task.id),
    }));
  }

  /**
   * Get a specific schedule by ID.
   */
  async getSchedule(taskId: string): Promise<{
    id: string;
    name: string;
    cron: string;
    enabled: boolean;
    chatId: string;
    prompt: string;
    blocking?: boolean;
    isRunning?: boolean;
  } | undefined> {
    if (!this.scheduleManager || !this.scheduler) {
      return undefined;
    }

    const task = await this.scheduleManager.get(taskId);
    if (!task) {
      return undefined;
    }

    return {
      id: task.id,
      name: task.name,
      cron: task.cron,
      enabled: task.enabled,
      chatId: task.chatId,
      prompt: task.prompt,
      blocking: task.blocking,
      isRunning: this.scheduler.isTaskRunning(task.id),
    };
  }

  /**
   * Toggle schedule enabled state.
   * Updates the schedule file and reloads the scheduler.
   */
  async toggleSchedule(taskId: string, enabled: boolean): Promise<boolean> {
    if (!this.scheduleManager || !this.fileScanner || !this.scheduler) {
      return false;
    }

    const task = await this.scheduleManager.get(taskId);
    if (!task) {
      return false;
    }

    // Update the task file
    const updatedTask: ScheduledTask = {
      ...task,
      enabled,
    };

    await this.fileScanner.writeTask(updatedTask);

    // The file watcher will pick up the change and update the scheduler
    // But we can also update directly for immediate effect
    this.scheduler.addTask(updatedTask);

    logger.info({ taskId, enabled }, 'Schedule toggled');
    return true;
  }

  /**
   * Trigger a schedule manually.
   */
  async triggerSchedule(taskId: string): Promise<boolean> {
    if (!this.scheduleManager || !this.scheduler) {
      return false;
    }

    const task = await this.scheduleManager.get(taskId);
    if (!task) {
      return false;
    }

    // Check if task is already running
    if (this.scheduler.isTaskRunning(taskId)) {
      logger.warn({ taskId }, 'Task is already running, skipping trigger');
      return false;
    }

    // Trigger the task execution directly
    await this.scheduler.triggerTask(task);
    return true;
  }
}
