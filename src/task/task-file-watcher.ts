/**
 * Task File Watcher - Triggers dialogue execution when Task.md is created.
 *
 * Watches the tasks/ directory for new task files using a simple serial loop.
 *
 * Mode: Single coroutine serial execution
 * - Loop: find task → execute → wait (if no task)
 * - No queue, no concurrent execution
 * - Uses fs.watch when idle (no polling when no work)
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskFileWatcher');

/** Track whether fs.watch recursive warning has been logged (global, across all instances) */
let watchWarningLogged = false;

/**
 * Callback when a task file is created and ready for processing.
 * Returns a Promise for serial execution.
 */
export type OnTaskCreated = (
  taskPath: string,
  messageId: string,
  chatId: string
) => Promise<void>;

/**
 * TaskFileWatcher options.
 */
export interface TaskFileWatcherOptions {
  /** Directory to watch (default: workspace/tasks) */
  tasksDir: string;
  /** Callback when a task is created (async for serial execution) */
  onTaskCreated: OnTaskCreated;
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
 * Simple serial execution mode:
 * ```
 * while (running) {
 *   task = findNextTask()
 *   if (task) {
 *     await execute(task)
 *   } else {
 *     await waitForNewTask()  // fs.watch, no polling
 *   }
 * }
 * ```
 */
export class TaskFileWatcher {
  private tasksDir: string;
  private onTaskCreated: OnTaskCreated;
  private running = false;
  /** Track processed tasks to avoid duplicates */
  private processedTasks: Set<string> = new Set();
  /** fs.watch instance for idle waiting */
  private watcher: fs.FSWatcher | null = null;
  /** Resolver for wait promise */
  private waitResolver: (() => void) | null = null;
  /** Whether fs.watch recursive is available for this instance */
  private watchAvailable = true;
  /** Polling interval when fs.watch is unavailable (ms) */
  private readonly pollingInterval = 5000;

  constructor(options: TaskFileWatcherOptions) {
    this.tasksDir = options.tasksDir;
    this.onTaskCreated = options.onTaskCreated;
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

    // Start the main loop (fire and forget, runs in background)
    void this.mainLoop();

    logger.info(
      { tasksDir: this.tasksDir },
      'Task file watcher started (serial loop mode)'
    );
  }

  /**
   * Main loop - simple serial execution.
   * Find task → execute → wait if no task.
   */
  private async mainLoop(): Promise<void> {
    logger.info({ tasksDir: this.tasksDir }, 'Task file watcher main loop started');

    while (this.running) {
      const task = await this.findNextTask();

      if (task) {
        // Execute task (serial, await completion)
        logger.info(
          { messageId: task.metadata.messageId, chatId: task.metadata.chatId, taskPath: task.path },
          'Task found, starting execution'
        );

        try {
          await this.onTaskCreated(
            task.path,
            task.metadata.messageId,
            task.metadata.chatId
          );
          logger.info({ messageId: task.metadata.messageId, taskPath: task.path }, 'Task execution completed');
        } catch (error) {
          logger.error(
            { err: error, messageId: task.metadata.messageId, taskPath: task.path },
            'Task execution failed'
          );
        }
        // Continue to next task immediately (no wait)
      } else {
        // No task found, wait for new file
        await this.waitForNewTask();
      }
    }

    logger.info('Task file watcher main loop exited');
  }

  /**
   * Find the next unprocessed task.
   * Returns null if no task found.
   */
  private async findNextTask(): Promise<{ path: string; metadata: TaskMetadata } | null> {
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
            logger.info({ taskFile, dirName: entry.name }, 'Found unprocessed task.md file');
            const metadata = await this.parseTaskFile(taskFile);

            if (metadata) {
              // Mark as processed immediately to prevent duplicate detection
              this.processedTasks.add(taskFile);
              logger.info(
                { taskFile, messageId: metadata.messageId, chatId: metadata.chatId },
                'Task file parsed, preparing for execution'
              );
              return { path: taskFile, metadata };
            } else {
              logger.warn({ taskFile }, 'Failed to parse task.md file, skipping');
            }
          }
        }
      }
    } catch (error) {
      logger.error({ err: error, tasksDir: this.tasksDir }, 'Error scanning task directory');
    }

    return null;
  }

  /**
   * Wait for a new task file to be created.
   * Uses fs.watch for efficiency, falls back to polling if unavailable.
   */
  private waitForNewTask(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waitResolver = resolve;

      // If we already know fs.watch is unavailable, use polling
      if (!this.watchAvailable) {
        setTimeout(resolve, this.pollingInterval);
        return;
      }

      try {
        this.watcher = fs.watch(
          this.tasksDir,
          { recursive: true, persistent: false },
          (eventType, filename) => {
            // Check if it's a task.md file
            if (filename && filename.endsWith('task.md')) {
              logger.info({ filename, eventType, tasksDir: this.tasksDir }, 'fs.watch detected new task.md file');
              this.stopWaiting();
            }
          }
        );

        this.watcher.on('error', (error) => {
          logger.warn({ err: error, tasksDir: this.tasksDir }, 'fs.watch error occurred, will retry');
          this.stopWaiting();
        });

        logger.debug('Waiting for new task (fs.watch active)');
      } catch (error) {
        // fs.watch recursive may not be available on all platforms (e.g., Docker)
        // Log once globally and switch to polling mode
        if (!watchWarningLogged) {
          logger.info({ err: error, tasksDir: this.tasksDir }, 'fs.watch recursive unavailable, using polling mode (5s interval)');
          watchWarningLogged = true;
        }
        this.watchAvailable = false;
        setTimeout(resolve, this.pollingInterval);
      }
    });
  }

  /**
   * Stop waiting and clean up watcher.
   */
  private stopWaiting(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.waitResolver) {
      this.waitResolver();
      this.waitResolver = null;
    }
  }

  /**
   * Scan existing tasks to avoid reprocessing them.
   */
  private async scanExistingTasks(): Promise<void> {
    logger.info({ tasksDir: this.tasksDir }, 'Scanning for existing tasks');

    try {
      const entries = await fs.promises.readdir(this.tasksDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const taskFile = path.join(this.tasksDir, entry.name, 'task.md');
          if (await this.fileExists(taskFile)) {
            this.processedTasks.add(taskFile);
            logger.debug({ taskFile, dirName: entry.name }, 'Existing task registered');
          }
        }
      }

      logger.info(
        { count: this.processedTasks.size, tasksDir: this.tasksDir },
        'Completed scan for existing tasks'
      );
    } catch (error) {
      logger.error({ err: error, tasksDir: this.tasksDir }, 'Failed to scan existing tasks directory');
    }
  }

  /**
   * Stop watching.
   */
  stop(): void {
    this.running = false;
    this.stopWaiting();

    logger.info('Task file watcher stopped');
  }

  /**
   * Check if watcher is running.
   */
  isRunning(): boolean {
    return this.running;
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
