/**
 * SchedulerService - Manages scheduler and schedule file watcher.
 *
 * Extracts scheduler management concerns from PrimaryNode:
 * - Scheduler initialization and lifecycle
 * - Schedule file watching for hot reload
 * - Callbacks for schedule execution
 * - Schedule CRUD operations for control commands
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
 * Feedback context for execution.
 */
interface FeedbackContext {
  sendFeedback: (feedback: FeedbackMessage) => void;
  threadId?: string;
}

/**
 * SchedulerService - Manages scheduler lifecycle.
 *
 * Handles:
 * - Scheduler initialization
 * - Schedule file watching
 * - Feedback channel management
 */
export class SchedulerService {
  private readonly callbacks: SchedulerCallbacks;
  private readonly pilot: SchedulerServiceConfig['pilot'];
  private readonly activeFeedbackChannels = new Map<string, FeedbackContext>();
  private scheduler?: Scheduler;
  private scheduleFileWatcher?: ScheduleFileWatcher;
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
    const scheduleManager = new ScheduleManager({ schedulesDir: this.schedulesDir });

    this.scheduler = new Scheduler({
      scheduleManager,
      pilot: this.pilot,
      callbacks: {
        sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            ctx.sendFeedback({ type: 'text', chatId, text, threadId: threadMessageId || ctx.threadId });
          } else {
            logger.warn({ chatId }, 'No feedback channel for scheduled task, message not sent');
          }
          return Promise.resolve();
        },
        sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
          }
          return Promise.resolve();
        },
        sendFile: async (chatId: string, filePath: string) => {
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            try {
              await this.callbacks.sendFile(chatId, filePath);
            } catch (error) {
              logger.error({ err: error, chatId, filePath }, 'Failed to send file for scheduled task');
            }
          }
        },
      },
      setFeedbackChannel: (chatId: string, context: { threadId?: string }) => {
        const actualContext = {
          sendFeedback: (feedback: FeedbackMessage) => {
            this.callbacks.handleFeedback(feedback);
          },
          threadId: context.threadId,
        };
        this.activeFeedbackChannels.set(chatId, actualContext);
        logger.debug({ chatId }, 'Feedback channel set for scheduled task');
      },
      clearFeedbackChannel: (chatId: string) => {
        this.activeFeedbackChannels.delete(chatId);
        logger.debug({ chatId }, 'Feedback channel cleared for scheduled task');
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
    this.activeFeedbackChannels.clear();
    logger.info('Scheduler service stopped');
  }

  /**
   * Set feedback channel for a chat.
   */
  setFeedbackChannel(chatId: string, sendFeedback: (feedback: FeedbackMessage) => void, threadId?: string): void {
    this.activeFeedbackChannels.set(chatId, { sendFeedback, threadId });
  }

  /**
   * Clear feedback channel for a chat.
   */
  clearFeedbackChannel(chatId: string): void {
    this.activeFeedbackChannels.delete(chatId);
  }

  /**
   * Get the scheduler instance.
   */
  getScheduler(): Scheduler | undefined {
    return this.scheduler;
  }

  // ============================================================================
  // Schedule Control Methods (Issue #469)
  // ============================================================================

  /**
   * List all scheduled tasks.
   *
   * @returns Array of all scheduled tasks
   */
  async listSchedules(): Promise<ScheduledTask[]> {
    if (!this.scheduler) {
      return [];
    }

    const scheduleManager = new ScheduleManager({ schedulesDir: this.schedulesDir });
    return scheduleManager.listAll();
  }

  /**
   * Get a specific schedule by ID.
   *
   * @param taskId - Task ID
   * @returns The task or undefined
   */
  async getSchedule(taskId: string): Promise<ScheduledTask | undefined> {
    const scheduleManager = new ScheduleManager({ schedulesDir: this.schedulesDir });
    return scheduleManager.get(taskId);
  }

  /**
   * Enable a scheduled task.
   *
   * @param taskId - Task ID to enable
   * @returns true if enabled, false if not found
   */
  async enableSchedule(taskId: string): Promise<boolean> {
    const scheduleManager = new ScheduleManager({ schedulesDir: this.schedulesDir });
    const task = await scheduleManager.get(taskId);

    if (!task) {
      return false;
    }

    if (task.enabled) {
      return true; // Already enabled
    }

    // Update the task file
    const fileScanner = scheduleManager.getFileScanner();
    const updatedTask = { ...task, enabled: true };
    await fileScanner.writeTask(updatedTask);

    // The file watcher will pick up the change and update the scheduler
    logger.info({ taskId }, 'Schedule enabled');
    return true;
  }

  /**
   * Disable a scheduled task.
   *
   * @param taskId - Task ID to disable
   * @returns true if disabled, false if not found
   */
  async disableSchedule(taskId: string): Promise<boolean> {
    const scheduleManager = new ScheduleManager({ schedulesDir: this.schedulesDir });
    const task = await scheduleManager.get(taskId);

    if (!task) {
      return false;
    }

    if (!task.enabled) {
      return true; // Already disabled
    }

    // Update the task file
    const fileScanner = scheduleManager.getFileScanner();
    const updatedTask = { ...task, enabled: false };
    await fileScanner.writeTask(updatedTask);

    // The file watcher will pick up the change and update the scheduler
    logger.info({ taskId }, 'Schedule disabled');
    return true;
  }

  /**
   * Manually trigger a scheduled task.
   *
   * @param taskId - Task ID to run
   * @returns true if triggered, false if not found or already running
   */
  async runSchedule(taskId: string): Promise<{ success: boolean; message: string }> {
    if (!this.scheduler) {
      return { success: false, message: '调度器未启动' };
    }

    const scheduleManager = new ScheduleManager({ schedulesDir: this.schedulesDir });
    const task = await scheduleManager.get(taskId);

    if (!task) {
      return { success: false, message: `定时任务 \`${taskId}\` 不存在` };
    }

    // Check if task is already running (blocking mode)
    if (this.scheduler.isTaskRunning(taskId)) {
      return { success: false, message: `定时任务「${task.name}」正在执行中` };
    }

    // Trigger the task immediately
    // We need to access the private executeTask method, so we use a workaround
    // by directly scheduling a one-time execution
    logger.info({ taskId, name: task.name }, 'Manually triggering scheduled task');

    // Execute the task directly
    try {
      // Set up feedback channel for the task
      if (task.chatId) {
        this.setFeedbackChannel(task.chatId, (feedback: FeedbackMessage) => {
          this.callbacks.handleFeedback(feedback);
        });
      }

      // Execute the task using the pilot
      await this.pilot.executeOnce(
        task.chatId,
        `⚠️ **手动触发定时任务**

定时任务名称: "${task.name}"
任务 ID: \`${task.id}\`

---

**任务内容:**
${task.prompt}`,
        undefined,
        task.createdBy
      );

      logger.info({ taskId }, 'Manually triggered task completed');
      return { success: true, message: `✅ 定时任务「${task.name}」执行完成` };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, taskId }, 'Manually triggered task failed');
      return { success: false, message: `❌ 定时任务「${task.name}」执行失败: ${errorMessage}` };

    } finally {
      // Clear feedback channel
      if (task.chatId) {
        this.clearFeedbackChannel(task.chatId);
      }
    }
  }

  /**
   * Get schedule status including scheduler state.
   *
   * @param taskId - Optional task ID to get specific status
   * @returns Status information
   */
  async getScheduleStatus(taskId?: string): Promise<{
    schedulerRunning: boolean;
    activeJobsCount: number;
    runningTasks: string[];
    task?: ScheduledTask;
  }> {
    const runningTasks = this.scheduler?.getRunningTaskIds() || [];

    if (taskId) {
      const scheduleManager = new ScheduleManager({ schedulesDir: this.schedulesDir });
      const task = await scheduleManager.get(taskId);

      return {
        schedulerRunning: this.scheduler?.isRunning() || false,
        activeJobsCount: this.scheduler?.getActiveJobs().length || 0,
        runningTasks,
        task,
      };
    }

    return {
      schedulerRunning: this.scheduler?.isRunning() || false,
      activeJobsCount: this.scheduler?.getActiveJobs().length || 0,
      runningTasks,
    };
  }
}
