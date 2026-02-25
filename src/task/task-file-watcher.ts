/**
 * Task File Watcher - Triggers dialogue execution when Task.md is created.
 *
 * Watches the tasks/ directory for new task files and triggers the
 * Dialogue phase (Evaluator → Executor → Reporter) automatically.
 *
 * Uses polling-based scanning for cross-platform compatibility.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskFileWatcher');

/**
 * Callback when a task file is created and ready for processing.
 */
export type OnTaskCreated = (
  taskPath: string,
  messageId: string,
  chatId: string
) => void;

/**
 * TaskFileWatcher options.
 */
export interface TaskFileWatcherOptions {
  /** Directory to watch (default: workspace/tasks) */
  tasksDir: string;
  /** Callback when a task is created */
  onTaskCreated: OnTaskCreated;
  /** Polling interval in ms (default: 1000) */
  pollIntervalMs?: number;
}

/**
 * Parsed task metadata from Task.md file.
 */
interface TaskMetadata {
  messageId: string;
  chatId: string;
}

/**
 * TaskFileWatcher - Watches tasks directory for new Task.md files.
 *
 * When a new task.md file is detected, it parses the file to extract
 * message ID and chat ID, then triggers the dialogue phase.
 *
 * Uses polling for cross-platform compatibility (fs.watch recursive
 * is not available on all platforms).
 */
export class TaskFileWatcher {
  private tasksDir: string;
  private onTaskCreated: OnTaskCreated;
  private pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;
  /** Track processed tasks to avoid duplicates */
  private processedTasks: Set<string> = new Set();

  constructor(options: TaskFileWatcherOptions) {
    this.tasksDir = options.tasksDir;
    this.onTaskCreated = options.onTaskCreated;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  /**
   * Start watching the tasks directory.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Task file watcher already running');
      return;
    }

    // Ensure directory exists
    await fs.promises.mkdir(this.tasksDir, { recursive: true });

    // Scan existing tasks to avoid reprocessing
    await this.scanExistingTasks();

    this.running = true;

    // Start polling
    this.scheduleNextPoll();

    logger.info(
      { tasksDir: this.tasksDir, pollIntervalMs: this.pollIntervalMs },
      'Task file watcher started (polling mode)'
    );
  }

  /**
   * Schedule the next poll.
   */
  private scheduleNextPoll(): void {
    if (!this.running) return;

    this.pollTimer = setTimeout(() => {
      this.poll().catch((error) => {
        logger.error({ err: error }, 'Error during poll');
      }).finally(() => {
        this.scheduleNextPoll();
      });
    }, this.pollIntervalMs);
  }

  /**
   * Scan existing tasks to avoid reprocessing them.
   */
  private async scanExistingTasks(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(this.tasksDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const taskFile = path.join(this.tasksDir, entry.name, 'task.md');
          if (await this.fileExists(taskFile)) {
            this.processedTasks.add(taskFile);
            logger.debug({ taskFile }, 'Existing task registered');
          }
        }
      }

      logger.info({ count: this.processedTasks.size }, 'Scanned existing tasks');
    } catch (error) {
      logger.error({ err: error }, 'Failed to scan existing tasks');
    }
  }

  /**
   * Stop watching.
   */
  stop(): void {
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    logger.info('Task file watcher stopped');
  }

  /**
   * Check if watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Poll for new tasks.
   */
  private async poll(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(this.tasksDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const taskFile = path.join(this.tasksDir, entry.name, 'task.md');

          // Skip if already processed
          if (this.processedTasks.has(taskFile)) {
            continue;
          }

          // Check if task.md exists
          if (await this.fileExists(taskFile)) {
            const metadata = await this.parseTaskFile(taskFile);

            if (metadata) {
              // Mark as processed
              this.processedTasks.add(taskFile);

              logger.info(
                { messageId: metadata.messageId, chatId: metadata.chatId, taskFile },
                'New task detected, triggering dialogue'
              );

              // Trigger dialogue
              this.onTaskCreated(taskFile, metadata.messageId, metadata.chatId);
            }
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Error polling for tasks');
    }
  }

  /**
   * Check if a file exists.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse task.md file to extract metadata.
   */
  private async parseTaskFile(filePath: string): Promise<TaskMetadata | null> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');

      // Extract Task ID (messageId)
      const taskIdMatch = content.match(/\*\*Task ID\*\*:\s*(\S+)/);
      const messageId = taskIdMatch?.[1];

      // Extract Chat ID
      const chatIdMatch = content.match(/\*\*Chat ID\*\*:\s*(\S+)/);
      const chatId = chatIdMatch?.[1];

      if (!messageId || !chatId) {
        logger.warn({ filePath, hasTaskId: !!messageId, hasChatId: !!chatId }, 'Task file missing required metadata');
        return null;
      }

      return { messageId, chatId };
    } catch (error) {
      logger.error({ err: error, filePath }, 'Failed to parse task file');
      return null;
    }
  }
}
