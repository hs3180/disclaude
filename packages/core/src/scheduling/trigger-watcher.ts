/**
 * Trigger Watcher - Watches for signal files to trigger invocable schedules.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Implements Method C (Signal File) from the issue:
 * - Skills/agents write a signal file to a trigger directory
 * - TriggerWatcher detects the file, removes it, and fires the callback
 * - The callback (Scheduler.triggerNow) executes the matching schedule
 *
 * Signal file naming convention:
 * - File name (without extension) = task ID
 * - Example: `workspace/triggers/schedule-chats-activation` triggers `schedule-chats-activation`
 *
 * Debouncing prevents rapid re-triggers from the same signal.
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TriggerWatcher');

/**
 * Callback when a trigger signal is detected.
 *
 * @param taskId - The task ID extracted from the signal file name
 */
export type OnTriggerSignal = (taskId: string) => void;

/**
 * TriggerWatcher options.
 */
export interface TriggerWatcherOptions {
  /** Directory to watch for trigger signal files */
  triggersDir: string;
  /** Callback when a trigger signal is detected */
  onTrigger: OnTriggerSignal;
  /** Debounce interval in ms (default: 100) */
  debounceMs?: number;
}

/**
 * TriggerWatcher - Watches a directory for signal files that trigger invocable schedules.
 *
 * Usage:
 * ```typescript
 * const watcher = new TriggerWatcher({
 *   triggersDir: './workspace/triggers',
 *   onTrigger: (taskId) => scheduler.triggerNow(taskId),
 * });
 * await watcher.start();
 * ```
 */
export class TriggerWatcher {
  private triggersDir: string;
  private onTrigger: OnTriggerSignal;
  private debounceMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  constructor(options: TriggerWatcherOptions) {
    this.triggersDir = options.triggersDir;
    this.onTrigger = options.onTrigger;
    this.debounceMs = options.debounceMs ?? 100;
    logger.info({ triggersDir: this.triggersDir }, 'TriggerWatcher initialized');
  }

  /**
   * Start watching the triggers directory.
   * Also processes any signal files that already exist (drain on start).
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('TriggerWatcher already running');
      return;
    }

    await fsPromises.mkdir(this.triggersDir, { recursive: true });

    // Drain any existing signal files on start
    await this.drainExistingSignals();

    try {
      this.watcher = fs.watch(
        this.triggersDir,
        { persistent: true, recursive: false },
        (eventType, filename) => {
          this.handleFileEvent(eventType, filename);
        }
      );

      this.watcher.on('error', (error) => {
        logger.error({ err: error }, 'TriggerWatcher error');
      });

      this.running = true;
      logger.info({ triggersDir: this.triggersDir }, 'TriggerWatcher started');

    } catch (error) {
      logger.error({ err: error }, 'Failed to start TriggerWatcher');
      throw error;
    }
  }

  /**
   * Stop watching.
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
    logger.info('TriggerWatcher stopped');
  }

  /**
   * Check if watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Write a trigger signal file.
   * Static utility for skills/agents to create signal files.
   *
   * @param triggersDir - The triggers directory path
   * @param taskId - The task ID to trigger
   */
  static async writeSignal(triggersDir: string, taskId: string): Promise<void> {
    await fsPromises.mkdir(triggersDir, { recursive: true });
    const signalPath = path.join(triggersDir, taskId);
    await fsPromises.writeFile(signalPath, new Date().toISOString(), 'utf-8');
    logger.debug({ taskId, signalPath }, 'Trigger signal written');
  }

  /**
   * Drain (consume) any signal files that already exist in the triggers directory.
   * This handles the case where signals were written before the watcher started.
   */
  private async drainExistingSignals(): Promise<void> {
    try {
      const files = await fsPromises.readdir(this.triggersDir);
      for (const file of files) {
        // Skip hidden files and directories
        if (file.startsWith('.')) { continue; }

        const taskId = file;
        const filePath = path.join(this.triggersDir, file);

        try {
          const stat = await fsPromises.stat(filePath);
          if (stat.isFile()) {
            await this.consumeAndTrigger(filePath, taskId);
          }
        } catch {
          // File may have been consumed already, skip
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error }, 'Error draining existing signals');
      }
    }
  }

  /**
   * Handle file system event with debouncing.
   */
  private handleFileEvent(eventType: string, filename: string | null): void {
    if (!filename || filename.startsWith('.')) {
      return;
    }

    const filePath = path.join(this.triggersDir, filename);
    logger.debug({ eventType, filename }, 'Trigger file event received');

    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.processFileEvent(eventType, filePath, filename);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Process the file event after debouncing.
   */
  private async processFileEvent(eventType: string, filePath: string, filename: string): Promise<void> {
    const taskId = filename;

    try {
      if (eventType === 'rename') {
        // File was created or deleted
        const exists = await this.fileExists(filePath);
        if (exists) {
          await this.consumeAndTrigger(filePath, taskId);
        }
      } else if (eventType === 'change') {
        // File was modified (treat as signal)
        await this.consumeAndTrigger(filePath, taskId);
      }
    } catch (error) {
      logger.error({ err: error, filePath, eventType }, 'Error processing trigger event');
    }
  }

  /**
   * Consume (delete) a signal file and fire the trigger callback.
   */
  private async consumeAndTrigger(filePath: string, taskId: string): Promise<void> {
    try {
      // Remove the signal file (consume it)
      await fsPromises.unlink(filePath);
      logger.info({ taskId }, 'Trigger signal consumed');
      this.onTrigger(taskId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File was already consumed by another process (race condition), skip
        logger.debug({ taskId }, 'Signal already consumed by another process');
      } else {
        logger.error({ err: error, taskId }, 'Error consuming trigger signal');
      }
    }
  }

  /**
   * Check if a file exists.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
