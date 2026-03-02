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
} from '../schedule/index.js';
import type { FeedbackMessage } from '../types/websocket-messages.js';
import type { ChatAgent } from '../agents/types.js';

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

  /**
   * Get the schedule manager instance.
   * Returns undefined if scheduler is not started.
   */
  async getScheduleManager(): Promise<import('../schedule/schedule-manager.js').ScheduleManager | undefined> {
    if (!this.scheduler) {
      return undefined;
    }
    // Access scheduleManager through scheduler's private field
    // We need to create a new ScheduleManager for queries since Scheduler doesn't expose it
    const { ScheduleManager } = await import('../schedule/schedule-manager.js');
    return new ScheduleManager({ schedulesDir: this.schedulesDir });
  }

  /**
   * List all schedules.
   */
  async listSchedules(): Promise<import('../schedule/schedule-manager.js').ScheduledTask[]> {
    const { ScheduleManager } = await import('../schedule/schedule-manager.js');
    const manager = new ScheduleManager({ schedulesDir: this.schedulesDir });
    return manager.listAll();
  }

  /**
   * List schedules for a specific chat.
   */
  async listSchedulesByChatId(chatId: string): Promise<import('../schedule/schedule-manager.js').ScheduledTask[]> {
    const { ScheduleManager } = await import('../schedule/schedule-manager.js');
    const manager = new ScheduleManager({ schedulesDir: this.schedulesDir });
    return manager.listByChatId(chatId);
  }

  /**
   * Get a schedule by ID.
   */
  async getSchedule(id: string): Promise<import('../schedule/schedule-manager.js').ScheduledTask | undefined> {
    const { ScheduleManager } = await import('../schedule/schedule-manager.js');
    const manager = new ScheduleManager({ schedulesDir: this.schedulesDir });
    return manager.get(id);
  }

  /**
   * Enable a schedule.
   */
  async enableSchedule(taskId: string): Promise<{ success: boolean; message: string }> {
    const { ScheduleFileScanner } = await import('../schedule/schedule-watcher.js');
    const scanner = new ScheduleFileScanner({ schedulesDir: this.schedulesDir });

    const task = await this.getSchedule(taskId);
    if (!task) {
      return { success: false, message: `定时任务 \`${taskId}\` 不存在` };
    }

    if (task.enabled) {
      return { success: true, message: `定时任务「${task.name}」已经是启用状态` };
    }

    // Update the task with enabled = true
    const updatedTask = { ...task, enabled: true };
    await scanner.writeTask(updatedTask);

    // The file watcher will automatically reload the task
    return { success: true, message: `✅ 定时任务「${task.name}」已启用` };
  }

  /**
   * Disable a schedule.
   */
  async disableSchedule(taskId: string): Promise<{ success: boolean; message: string }> {
    const { ScheduleFileScanner } = await import('../schedule/schedule-watcher.js');
    const scanner = new ScheduleFileScanner({ schedulesDir: this.schedulesDir });

    const task = await this.getSchedule(taskId);
    if (!task) {
      return { success: false, message: `定时任务 \`${taskId}\` 不存在` };
    }

    if (!task.enabled) {
      return { success: true, message: `定时任务「${task.name}」已经是禁用状态` };
    }

    // Update the task with enabled = false
    const updatedTask = { ...task, enabled: false };
    await scanner.writeTask(updatedTask);

    // Remove from active scheduler immediately
    this.scheduler?.removeTask(taskId);

    return { success: true, message: `⏸️ 定时任务「${task.name}」已禁用` };
  }

  /**
   * Manually trigger a schedule.
   */
  async runSchedule(taskId: string): Promise<{ success: boolean; message: string }> {
    const task = await this.getSchedule(taskId);
    if (!task) {
      return { success: false, message: `定时任务 \`${taskId}\` 不存在` };
    }

    // Check if task is currently running
    if (this.scheduler?.isTaskRunning(taskId)) {
      return { success: false, message: `定时任务「${task.name}」正在执行中，请稍后再试` };
    }

    // Import Scheduler to access executeTask (we'll need to add a public method for this)
    // For now, we'll trigger it by sending a message to the chat
    try {
      // Send notification that task is starting
      await this.callbacks.sendMessage(
        task.chatId,
        `🔄 手动触发定时任务「${task.name}」...`
      );

      // Execute the task using pilot
      await this.pilot.executeOnce(
        task.chatId,
        task.prompt,
        undefined,
        task.createdBy
      );

      return { success: true, message: `✅ 定时任务「${task.name}」执行完成` };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, message: `❌ 定时任务「${task.name}」执行失败: ${errorMessage}` };
    }
  }

  /**
   * Get schedule status.
   */
  async getScheduleStatus(taskId: string): Promise<{ success: boolean; message: string }> {
    const task = await this.getSchedule(taskId);
    if (!task) {
      return { success: false, message: `定时任务 \`${taskId}\` 不存在` };
    }

    const isRunning = this.scheduler?.isTaskRunning(taskId) ?? false;
    const statusEmoji = task.enabled ? (isRunning ? '🔄' : '✅') : '⏸️';
    const statusText = task.enabled ? (isRunning ? '执行中' : '已启用') : '已禁用';

    const lines = [
      '📋 **定时任务状态**',
      '',
      `**名称**: ${task.name}`,
      `**ID**: \`${task.id}\``,
      `**状态**: ${statusEmoji} ${statusText}`,
      `**Cron**: \`${task.cron}\``,
      `**阻塞模式**: ${task.blocking ? '是' : '否'}`,
      `**创建时间**: ${new Date(task.createdAt).toLocaleString('zh-CN')}`,
    ];

    if (task.lastExecutedAt) {
      lines.push(`**上次执行**: ${new Date(task.lastExecutedAt).toLocaleString('zh-CN')}`);
    }

    return { success: true, message: lines.join('\n') };
  }
}
