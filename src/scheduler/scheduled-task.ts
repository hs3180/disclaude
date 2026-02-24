/**
 * Scheduled task implementation.
 *
 * Wraps a single cron job with task execution logic.
 * Each task can invoke a skill or execute a prompt.
 */

import cron from 'node-cron';
import { createLogger } from '../utils/logger.js';
import { Pilot } from '../agents/pilot.js';
import type { ScheduleConfig } from '../config/types.js';

const logger = createLogger('ScheduledTask');

/**
 * Execution statistics for a scheduled task.
 */
export interface TaskExecutionStats {
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
 * Scheduled task wrapper.
 *
 * Manages a single cron job and its execution.
 */
export class ScheduledTask {
  private readonly config: ScheduleConfig;
  private readonly cronTask: cron.ScheduledTask;
  private stats: TaskExecutionStats;
  private taskRunning: boolean = false;

  constructor(config: ScheduleConfig) {
    this.config = config;
    this.stats = {
      runCount: 0,
      isRunning: false,
    };

    // Validate cron expression
    if (!cron.validate(config.cron)) {
      throw new Error(`Invalid cron expression: ${config.cron}`);
    }

    // Create the cron task (but don't start it yet)
    // Using the schedule function with scheduled: false
    this.cronTask = cron.schedule(
      config.cron,
      () => {
        void this.execute();
      },
      {
        scheduled: false,
        timezone: config.timezone,
      }
    );
  }

  /**
   * Start the scheduled task.
   */
  start(): void {
    if (this.taskRunning) {
      logger.debug({ name: this.config.name }, 'Task is already scheduled');
      return;
    }

    logger.info({ name: this.config.name, cron: this.config.cron }, 'Starting scheduled task');
    this.cronTask.start();
    this.taskRunning = true;
    this.updateNextRun();
  }

  /**
   * Stop the scheduled task.
   */
  stop(): void {
    if (!this.taskRunning) {
      logger.debug({ name: this.config.name }, 'Task is not scheduled');
      return;
    }

    logger.info({ name: this.config.name }, 'Stopping scheduled task');
    this.cronTask.stop();
    this.taskRunning = false;
  }

  /**
   * Execute the task.
   *
   * This method is called automatically by the cron scheduler,
   * but can also be called manually for testing.
   */
  async execute(): Promise<void> {
    // Prevent concurrent execution
    if (this.stats.isRunning) {
      logger.warn({ name: this.config.name }, 'Task is already running, skipping');
      return;
    }

    this.stats.isRunning = true;
    const startTime = Date.now();

    logger.info({
      name: this.config.name,
      args: this.config.args,
      skill: this.config.skill,
    }, 'Executing scheduled task');

    try {
      // Build the task prompt
      const prompt = this.buildPrompt();

      // Determine the target chat ID
      const chatId = this.config.chatId || this.getDefaultChatId();
      if (!chatId) {
        throw new Error('No chat ID configured for scheduled task');
      }

      // Create a simple callback for sending results
      const callbacks = {
        sendMessage: async (targetChatId: string, text: string): Promise<void> => {
          logger.debug({ targetChatId, textLength: text.length }, 'Sending scheduled task result');
          // Note: In a real implementation, this would use Feishu API
          // For now, we just log the result
          console.log(`[${this.config.name}] Result for ${targetChatId}:`);
          console.log(text);
        },
        sendCard: async (_targetChatId: string, _card: Record<string, unknown>): Promise<void> => {
          logger.debug('Sending card (not implemented for scheduled tasks)');
        },
        sendFile: async (targetChatId: string, filePath: string): Promise<void> => {
          logger.debug({ targetChatId, filePath }, 'Sending file from scheduled task');
          console.log(`[${this.config.name}] File for ${targetChatId}: ${filePath}`);
        },
      };

      // Create a Pilot instance for execution
      const pilot = new Pilot({
        callbacks,
        isCliMode: true, // Use CLI mode for scheduled tasks
      });

      // Generate a unique message ID for this execution
      const messageId = `schedule-${this.config.name}-${Date.now()}`;

      // Execute the task
      await pilot.executeOnce(chatId, prompt, messageId);

      // Update stats
      this.stats.runCount++;
      this.stats.lastRun = new Date();
      this.stats.lastError = undefined;
      this.stats.isRunning = false;

      const duration = Date.now() - startTime;
      logger.info({
        name: this.config.name,
        duration,
        runCount: this.stats.runCount,
      }, 'Scheduled task completed successfully');

      this.updateNextRun();
    } catch (error) {
      this.stats.isRunning = false;
      const err = error as Error;
      this.stats.lastError = err.message;

      logger.error({
        name: this.config.name,
        err,
        duration: Date.now() - startTime,
      }, 'Scheduled task failed');
    }
  }

  /**
   * Get task execution statistics.
   *
   * @returns Task statistics
   */
  getStats(): TaskExecutionStats {
    this.updateNextRun();
    return { ...this.stats };
  }

  /**
   * Build the prompt for task execution.
   *
   * @returns Task prompt
   */
  private buildPrompt(): string {
    const { skill, args, description } = this.config;

    if (skill) {
      // If a skill is specified, invoke it
      if (args) {
        return `/${skill} ${args}`;
      }
      return `/${skill}`;
    }

    // Otherwise, use the args as the prompt
    if (args) {
      if (description) {
        return `${description}\n\n${args}`;
      }
      return args;
    }

    if (description) {
      return description;
    }

    return 'Execute scheduled task';
  }

  /**
   * Get the default chat ID for this task.
   *
   * @returns Chat ID or undefined
   */
  private getDefaultChatId(): string | undefined {
    // Check environment variable
    const envChatId = process.env.FEISHU_CLI_CHAT_ID;
    if (envChatId) {
      return envChatId;
    }

    // Return the configured chat ID
    return this.config.chatId;
  }

  /**
   * Update the next run time based on cron schedule.
   */
  private updateNextRun(): void {
    // node-cron doesn't provide a direct way to get next run time
    // We'll estimate it based on the current time and cron expression
    // This is a simplified implementation
    try {
      // For now, just set it to undefined
      // A proper implementation would parse the cron expression
      // and calculate the next run time
      this.stats.nextRun = undefined;
    } catch {
      this.stats.nextRun = undefined;
    }
  }
}
