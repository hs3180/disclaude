/**
 * TriggerManager - Manages signal-file-based triggers for scheduled tasks.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Provides a file-based signaling mechanism that allows:
 * - Skills/agents to trigger schedule execution by writing a lightweight signal file
 * - Cross-process triggering (works across PM2 processes)
 * - Immediate detection via fs.watch on the trigger directory
 *
 * Signal files are stored in: schedules/.triggers/{taskId}.trigger
 * Each file contains a timestamp (ISO string) of when the trigger was written.
 *
 * Usage:
 * ```typescript
 * const manager = new TriggerManager({ triggerDir: './workspace/schedules/.triggers' });
 *
 * // Start watching for trigger files
 * manager.onTrigger((taskId) => {
 *   console.log(`Task ${taskId} was triggered`);
 * });
 * await manager.start();
 *
 * // Trigger a task (e.g., from a skill)
 * await manager.trigger('schedule-chats-activation');
 *
 * // Stop watching
 * manager.stop();
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TriggerManager');

/**
 * TriggerManager options.
 */
export interface TriggerManagerOptions {
  /** Directory for trigger signal files */
  triggerDir: string;
}

/**
 * Trigger callback type.
 * Called when a trigger signal is detected for a task.
 */
export type OnTrigger = (taskId: string) => void;

/**
 * TriggerManager - Manages signal-file-based triggers for scheduled tasks.
 *
 * Signal files use a simple convention:
 * - Location: {triggerDir}/{taskId}.trigger
 * - Content: ISO timestamp string
 * - Lifecycle: Written by trigger source, consumed (deleted) by TriggerManager
 *
 * The manager uses fs.watch for immediate detection of new trigger files,
 * avoiding the latency of polling-based approaches.
 */
export class TriggerManager {
  private triggerDir: string;
  private watcher: fs.FSWatcher | null = null;
  private callbacks: Set<OnTrigger> = new Set();
  private running = false;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Debounce interval for processing trigger files (ms) */
  private processDebounceMs = 300;

  constructor(options: TriggerManagerOptions) {
    this.triggerDir = options.triggerDir;
    logger.info({ triggerDir: this.triggerDir }, 'TriggerManager initialized');
  }

  /**
   * Start watching the trigger directory for new signal files.
   * Existing trigger files on disk are NOT consumed on start
   * (they represent pre-start triggers that should be ignored).
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('TriggerManager already running');
      return;
    }

    await fsPromises.mkdir(this.triggerDir, { recursive: true });

    try {
      this.watcher = fs.watch(
        this.triggerDir,
        { persistent: true },
        (eventType, filename) => {
          this.handleTriggerEvent(eventType, filename);
        }
      );

      this.watcher.on('error', (error) => {
        logger.error({ err: error }, 'Trigger directory watcher error');
      });

      this.running = true;
      logger.info({ triggerDir: this.triggerDir }, 'TriggerManager started watching');

    } catch (error) {
      logger.error({ err: error }, 'Failed to start TriggerManager');
      throw error;
    }
  }

  /**
   * Stop watching the trigger directory.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.running = false;
    logger.info('TriggerManager stopped');
  }

  /**
   * Check if the manager is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Register a callback for trigger events.
   *
   * @param callback - Function called when a trigger is detected
   * @returns Unsubscribe function
   */
  onTrigger(callback: OnTrigger): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /**
   * Write a trigger signal file for a specific task.
   * This is the primary API for skills/agents to trigger schedule execution.
   *
   * The trigger file contains a timestamp and is immediately detectable
   * by the TriggerManager's fs.watch listener.
   *
   * @param taskId - ID of the task to trigger (e.g., "schedule-chats-activation")
   */
  async trigger(taskId: string): Promise<void> {
    // Sanitize task ID for filename safety
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const triggerPath = path.join(this.triggerDir, `${safeId}.trigger`);

    try {
      await fsPromises.mkdir(this.triggerDir, { recursive: true });
      await fsPromises.writeFile(triggerPath, new Date().toISOString(), 'utf-8');
      logger.info({ taskId, triggerPath }, 'Trigger signal written');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to write trigger signal');
      throw error;
    }
  }

  /**
   * Consume (check and delete) all pending trigger files.
   * Returns the list of task IDs that were triggered.
   *
   * This is useful for manual polling if fs.watch is not available.
   *
   * @returns Array of triggered task IDs
   */
  async consumeAll(): Promise<string[]> {
    const triggeredTasks: string[] = [];

    try {
      const files = await fsPromises.readdir(this.triggerDir);
      const triggerFiles = files.filter(f => f.endsWith('.trigger'));

      for (const file of triggerFiles) {
        const taskId = file.replace(/\.trigger$/, '');
        const filePath = path.join(this.triggerDir, file);

        try {
          await fsPromises.unlink(filePath);
          triggeredTasks.push(taskId);
          logger.debug({ taskId }, 'Consumed trigger signal');
        } catch (error) {
          logger.error({ err: error, taskId }, 'Failed to consume trigger signal');
        }
      }

      if (triggeredTasks.length > 0) {
        logger.info({ taskIds: triggeredTasks }, 'Consumed trigger signals');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error }, 'Failed to read trigger directory');
      }
    }

    return triggeredTasks;
  }

  /**
   * Get the trigger directory path.
   */
  getTriggerDir(): string {
    return this.triggerDir;
  }

  /**
   * Handle a file system event in the trigger directory.
   * Uses debouncing to coalesce rapid triggers.
   */
  private handleTriggerEvent(_eventType: string, filename: string | null): void {
    if (!filename || !filename.endsWith('.trigger')) {
      return;
    }

    const taskId = filename.replace(/\.trigger$/, '');

    // Debounce per task ID
    const existingTimer = this.debounceTimers.get(taskId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(taskId);
      this.processTrigger(taskId);
    }, this.processDebounceMs);

    this.debounceTimers.set(taskId, timer);
  }

  /**
   * Process a trigger signal by consuming the file and notifying callbacks.
   */
  private async processTrigger(taskId: string): Promise<void> {
    // Sanitize task ID for filename safety
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const triggerPath = path.join(this.triggerDir, `${safeId}.trigger`);

    try {
      // Try to consume the trigger file (atomic check-and-delete)
      await fsPromises.unlink(triggerPath);
      logger.info({ taskId }, 'Trigger signal processed');
    } catch (error) {
      // File might have already been consumed or doesn't exist
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug({ taskId }, 'Trigger file already consumed');
        return;
      }
      logger.error({ err: error, taskId }, 'Failed to consume trigger file');
      return;
    }

    // Notify all registered callbacks
    for (const callback of this.callbacks) {
      try {
        callback(taskId);
      } catch (error) {
        logger.error({ err: error, taskId }, 'Trigger callback error');
      }
    }
  }
}
