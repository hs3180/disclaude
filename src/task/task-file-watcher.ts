/**
 * Task File Watcher - Triggers dialogue execution when Task.md is created.
 *
 * Watches the tasks/ directory for new task files using a simple serial loop.
 *
 * Mode: Single coroutine serial execution
 * - Loop: find task → execute → wait (if no task)
 * - No queue, no concurrent execution
 * - Uses fs.watch when idle (no polling when no work)
 *
 * Reliability features:
 * - Heartbeat logging for monitoring
 * - Task status tracking (pending → processing → completed/failed)
 * - Error recording to error.md
 * - Automatic recovery of stuck tasks
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { TaskFileManager } from './file-manager.js';

const logger = createLogger('TaskFileWatcher');

/** Heartbeat interval in milliseconds (5 minutes) */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Task timeout in milliseconds (30 minutes) */
const TASK_TIMEOUT_MS = 30 * 60 * 1000;

/** Maximum retry count for failed tasks */
const MAX_RETRY_COUNT = 3;

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
  /** Enable heartbeat logging (default: true) */
  enableHeartbeat?: boolean;
  /** Heartbeat interval in milliseconds (default: 5 minutes) */
  heartbeatIntervalMs?: number;
  /** Task timeout in milliseconds (default: 30 minutes) */
  taskTimeoutMs?: number;
  /** Maximum retry count (default: 3) */
  maxRetryCount?: number;
  /** Optional TaskFileManager instance (for testing) */
  fileManager?: TaskFileManager;
}

/**
 * Parsed task metadata from Task.md file.
 */
interface TaskMetadata {
  messageId: string;
  chatId: string;
}

/**
 * Watcher health status for monitoring.
 */
export interface WatcherHealth {
  isRunning: boolean;
  lastHeartbeat: string | null;
  processedCount: number;
  failedCount: number;
  currentTask: string | null;
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
 *
 * Reliability features:
 * - Heartbeat logging every 5 minutes
 * - Task status tracking via status.md
 * - Error recording to error.md
 * - Automatic retry with backoff
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

  // Reliability features
  private fileManager: TaskFileManager;
  private enableHeartbeat: boolean;
  private heartbeatIntervalMs: number;
  private taskTimeoutMs: number;
  private maxRetryCount: number;
  private lastHeartbeat: Date | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private processedCount = 0;
  private failedCount = 0;
  private currentTask: string | null = null;

  constructor(options: TaskFileWatcherOptions) {
    this.tasksDir = options.tasksDir;
    this.onTaskCreated = options.onTaskCreated;
    this.enableHeartbeat = options.enableHeartbeat ?? true;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.taskTimeoutMs = options.taskTimeoutMs ?? TASK_TIMEOUT_MS;
    this.maxRetryCount = options.maxRetryCount ?? MAX_RETRY_COUNT;
    // Use provided fileManager or create one with tasksDir as tasksBaseDir
    this.fileManager = options.fileManager ?? new TaskFileManager(undefined, undefined, options.tasksDir);
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

    // Initialize status for uninitialized tasks
    await this.initializeUninitializedTasks();

    this.running = true;

    // Start heartbeat if enabled
    if (this.enableHeartbeat) {
      this.startHeartbeat();
    }

    // Start the main loop (fire and forget, runs in background)
    void this.mainLoop();

    logger.info(
      {
        tasksDir: this.tasksDir,
        enableHeartbeat: this.enableHeartbeat,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        taskTimeoutMs: this.taskTimeoutMs,
        maxRetryCount: this.maxRetryCount,
      },
      'Task file watcher started (serial loop mode with reliability features)'
    );
  }

  /**
   * Main loop - simple serial execution with reliability features.
   * Find task → execute → wait if no task.
   */
  private async mainLoop(): Promise<void> {
    while (this.running) {
      try {
        // Check for stuck tasks and handle them
        await this.checkStuckTasks();

        const task = await this.findNextTask();

        if (task) {
          // Update heartbeat on activity
          this.lastHeartbeat = new Date();

          // Execute task (serial, await completion)
          const taskId = this.extractTaskId(task.path);
          this.currentTask = taskId;

          logger.info(
            { messageId: task.metadata.messageId, chatId: task.metadata.chatId, taskId },
            'Executing task'
          );

          // Update status to 'processing'
          await this.fileManager.updateStatus(taskId, 'processing');

          try {
            await this.onTaskCreated(
              task.path,
              task.metadata.messageId,
              task.metadata.chatId
            );

            // Update status to 'completed'
            await this.fileManager.updateStatus(taskId, 'completed');
            this.processedCount++;
            logger.info({ messageId: task.metadata.messageId, taskId }, 'Task completed');
          } catch (error) {
            // Handle task failure
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;

            logger.error(
              { err: error, messageId: task.metadata.messageId, taskId },
              'Task failed'
            );

            // Check retry count
            const status = await this.fileManager.readStatus(taskId);
            const retryCount = status?.retryCount ?? 0;

            if (retryCount < this.maxRetryCount) {
              // Increment retry count and keep status as 'processing' for retry
              await this.fileManager.incrementRetryCount(taskId);
              logger.info(
                { taskId, retryCount: retryCount + 1, maxRetryCount: this.maxRetryCount },
                'Task will be retried'
              );
              // Remove from processed tasks so it can be picked up again
              this.processedTasks.delete(task.path);
            } else {
              // Max retries reached, mark as failed
              await this.fileManager.updateStatus(taskId, 'failed', errorMessage);
              await this.fileManager.writeError(taskId, errorMessage, errorStack);
              this.failedCount++;
              logger.error(
                { taskId, retryCount },
                'Task failed after max retries'
              );
            }
          }

          this.currentTask = null;
          // Continue to next task immediately (no wait)
        } else {
          // No task found, wait for new file
          await this.waitForNewTask();
        }
      } catch (error) {
        // Catch any unexpected errors in the main loop itself
        logger.error({ err: error }, 'Unexpected error in main loop, continuing...');
        // Wait a bit before continuing to avoid tight error loops
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
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
            const metadata = await this.parseTaskFile(taskFile);

            if (metadata) {
              // Mark as processed immediately to prevent duplicate detection
              this.processedTasks.add(taskFile);
              return { path: taskFile, metadata };
            }
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Error finding next task');
    }

    return null;
  }

  /**
   * Wait for a new task file to be created.
   * Uses fs.watch for efficiency.
   */
  private async waitForNewTask(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waitResolver = resolve;

      try {
        this.watcher = fs.watch(
          this.tasksDir,
          { recursive: true, persistent: false },
          (_eventType, filename) => {
            // Check if it's a task.md file
            if (filename && filename.endsWith('task.md')) {
              this.stopWaiting();
            }
          }
        );

        this.watcher.on('error', (error) => {
          logger.debug({ err: error }, 'fs.watch error, will retry on next cycle');
          this.stopWaiting();
        });

        logger.debug('Waiting for new task (fs.watch)');
      } catch {
        // fs.watch recursive may not be available on all platforms
        // Just resolve immediately and retry on next loop iteration
        logger.debug('fs.watch unavailable, will retry');
        resolve();
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
    this.stopWaiting();
    this.stopHeartbeat();

    logger.info(
      {
        processedCount: this.processedCount,
        failedCount: this.failedCount,
      },
      'Task file watcher stopped'
    );
  }

  /**
   * Check if watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get watcher health status.
   */
  getHealth(): WatcherHealth {
    return {
      isRunning: this.running,
      lastHeartbeat: this.lastHeartbeat?.toISOString() ?? null,
      processedCount: this.processedCount,
      failedCount: this.failedCount,
      currentTask: this.currentTask,
    };
  }

  /**
   * Start heartbeat timer.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.running) {
        this.lastHeartbeat = new Date();
        logger.info(
          {
            lastHeartbeat: this.lastHeartbeat.toISOString(),
            processedCount: this.processedCount,
            failedCount: this.failedCount,
            currentTask: this.currentTask,
            processedTasks: this.processedTasks.size,
          },
          'Task file watcher heartbeat'
        );
      }
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat timer.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Check for stuck tasks and handle them.
   */
  private async checkStuckTasks(): Promise<void> {
    try {
      const stuckTasks = await this.fileManager.findStuckTasks(this.taskTimeoutMs);

      for (const taskId of stuckTasks) {
        logger.warn({ taskId }, 'Found stuck task, marking as timeout');

        // Update status to timeout
        await this.fileManager.updateStatus(taskId, 'timeout', 'Task exceeded timeout');
        await this.fileManager.writeError(taskId, 'Task exceeded timeout and was marked as timed out');

        this.failedCount++;
      }
    } catch (error) {
      logger.error({ err: error }, 'Error checking stuck tasks');
    }
  }

  /**
   * Initialize status for tasks that have task.md but no status.md.
   */
  private async initializeUninitializedTasks(): Promise<void> {
    try {
      const uninitialized = await this.fileManager.findUninitializedTasks();

      for (const taskId of uninitialized) {
        await this.fileManager.initializeStatus(taskId);
        logger.info({ taskId }, 'Initialized status for existing task');
      }

      if (uninitialized.length > 0) {
        logger.info({ count: uninitialized.length }, 'Initialized status for uninitialized tasks');
      }
    } catch (error) {
      logger.error({ err: error }, 'Error initializing uninitialized tasks');
    }
  }

  /**
   * Extract task ID from task path.
   * E.g., /path/to/tasks/cli-123/task.md -> cli-123
   */
  private extractTaskId(taskPath: string): string {
    const taskDir = path.dirname(taskPath);
    return path.basename(taskDir);
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
