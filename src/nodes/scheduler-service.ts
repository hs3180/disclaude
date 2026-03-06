/**
 * SchedulerService - Manages scheduler and schedule file watcher.
 *
 * Extracts scheduler management concerns from PrimaryNode:
 * - Scheduler initialization and lifecycle
 * - Schedule file watching for hot reload
 * - Callbacks for schedule execution
 *
 * Issue #711: Uses short-lived ScheduleAgents via AgentFactory.
 * No longer requires AgentPool reference.
 *
 * Architecture:
 * ```
 * PrimaryNode → SchedulerService → { Scheduler, ScheduleFileWatcher }
 *                      ↓
 *              ScheduleManager → AgentFactory.createScheduleAgent
 * ```
 */

import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import {
  ScheduleManager,
  Scheduler,
  ScheduleFileWatcher,
  CooldownManager,
} from '../schedule/index.js';
import type { FeedbackMessage } from '../types/websocket-messages.js';

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
 *
 * Issue #711: No longer requires AgentPool.
 */
export interface SchedulerServiceConfig {
  /** Callbacks for schedule execution */
  callbacks: SchedulerCallbacks;
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
  private scheduler?: Scheduler;
  private scheduleFileWatcher?: ScheduleFileWatcher;
  private cooldownManager?: CooldownManager;
  private schedulesDir: string;
  private cooldownDir: string;

  constructor(config: SchedulerServiceConfig) {
    this.callbacks = config.callbacks;

    const workspaceDir = Config.getWorkspaceDir();
    this.schedulesDir = path.join(workspaceDir, 'schedules');
    this.cooldownDir = path.join(this.schedulesDir, '.cooldown');
  }

  /**
   * Start the scheduler service.
   */
  async start(): Promise<void> {
    const scheduleManager = new ScheduleManager({ schedulesDir: this.schedulesDir });

    // Issue #869: Create CooldownManager for cooldown period support
    this.cooldownManager = new CooldownManager({ cooldownDir: this.cooldownDir });

    // Issue #711: Scheduler now uses AgentFactory.createScheduleAgent
    // instead of AgentPool for short-lived agents
    this.scheduler = new Scheduler({
      scheduleManager,
      cooldownManager: this.cooldownManager,
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
}
