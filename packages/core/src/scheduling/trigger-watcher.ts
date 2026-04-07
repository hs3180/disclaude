/**
 * Schedule Trigger Watcher - Event-driven schedule execution via signal files.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Provides an alternative to cron-only triggering. When a schedule declares
 * `triggerable: true` in its frontmatter, external processes can trigger
 * immediate execution by writing a signal file to `{schedulesDir}/.triggers/{taskId}`.
 *
 * Architecture:
 * ```
 * External process (e.g., chat/create.ts)
 *   → writes signal file to .triggers/{taskId}
 *   → ScheduleTriggerWatcher detects via fs.watch
 *   → calls onTrigger(taskId) callback
 *   → Scheduler.executeTask(task) runs immediately
 *   → signal file cleaned up
 * ```
 *
 * Key design decisions:
 * - Signal files stored in `{schedulesDir}/.triggers/` (alongside schedule files)
 * - Uses Node.js built-in `fs.watch` — no external dependencies
 * - Debounced to avoid duplicate triggers from rapid file events
 * - Signal file cleanup happens after trigger callback completes
 * - Cron schedule remains as fallback — this is additive, not replacement
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ScheduleTriggerWatcher');

/**
 * Callback when a schedule should be triggered.
 * Receives the task ID that was triggered.
 */
export type OnTrigger = (taskId: string) => Promise<void>;

/**
 * Options for ScheduleTriggerWatcher.
 */
export interface ScheduleTriggerWatcherOptions {
  /** Directory containing schedule files (trigger files go in `{schedulesDir}/.triggers/`) */
  schedulesDir: string;
  /** Callback when a trigger signal is detected */
  onTrigger: OnTrigger;
  /** Debounce interval in ms (default: 500) */
  debounceMs?: number;
}

/**
 * ScheduleTriggerWatcher - Monitors signal files for event-driven schedule execution.
 *
 * Watches the `{schedulesDir}/.triggers/` directory for new signal files.
 * Each signal file is named `{taskId}` and triggers the corresponding schedule.
 *
 * Usage:
 * ```typescript
 * const watcher = new ScheduleTriggerWatcher({
 *   schedulesDir: './workspace/schedules',
 *   onTrigger: async (taskId) => {
 *     const task = await scheduleManager.get(taskId);
 *     if (task) scheduler.triggerTask(task);
 *   },
 * });
 *
 * await watcher.start();
 * // ...
 * watcher.stop();
 * ```
 *
 * To trigger a schedule externally:
 * ```typescript
 * await triggerSchedule('./workspace/schedules', 'schedule-chats-activation');
 * ```
 */
export class ScheduleTriggerWatcher {
  private triggersDir: string;
  private onTrigger: OnTrigger;
  private debounceMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  constructor(options: ScheduleTriggerWatcherOptions) {
    this.triggersDir = path.join(options.schedulesDir, '.triggers');
    this.onTrigger = options.onTrigger;
    this.debounceMs = options.debounceMs ?? 500;
    logger.info({ triggersDir: this.triggersDir }, 'ScheduleTriggerWatcher initialized');
  }

  /**
   * Start watching for trigger signals.
   * Creates the `.triggers/` directory if it doesn't exist.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Trigger watcher already running');
      return;
    }

    await fsPromises.mkdir(this.triggersDir, { recursive: true });

    try {
      this.watcher = fs.watch(
        this.triggersDir,
        { persistent: true, recursive: false },
        (eventType, filename) => {
          this.handleFileEvent(eventType, filename);
        }
      );

      this.watcher.on('error', (error) => {
        logger.error({ err: error }, 'Trigger watcher error');
      });

      this.running = true;
      logger.info({ triggersDir: this.triggersDir }, 'Trigger watcher started');

    } catch (error) {
      logger.error({ err: error }, 'Failed to start trigger watcher');
      throw error;
    }
  }

  /**
   * Stop watching for trigger signals.
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
    logger.info('Trigger watcher stopped');
  }

  /**
   * Check if the watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Handle a file system event with debouncing.
   */
  private handleFileEvent(eventType: string, filename: string | null): void {
    if (!filename) {
      return;
    }

    // Skip dotfiles (other than the directory itself)
    if (filename.startsWith('.') && filename !== '.') {
      return;
    }

    logger.debug({ eventType, filename }, 'Trigger file event received');

    const existingTimer = this.debounceTimers.get(filename);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filename);
      void this.processTrigger(filename);
    }, this.debounceMs);

    this.debounceTimers.set(filename, timer);
  }

  /**
   * Process a trigger signal.
   * Reads the trigger file, invokes the callback, then cleans up.
   */
  private async processTrigger(filename: string): Promise<void> {
    const triggerFilePath = path.join(this.triggersDir, filename);

    // Verify the trigger file exists
    const exists = await this.fileExists(triggerFilePath);
    if (!exists) {
      logger.debug({ filename }, 'Trigger file does not exist, skipping');
      return;
    }

    const taskId = filename;
    logger.info({ taskId, filename }, 'Trigger signal detected, executing schedule');

    try {
      // Invoke the trigger callback
      await this.onTrigger(taskId);
    } catch (error) {
      logger.error({ err: error, taskId }, 'Trigger callback failed');
      // Don't clean up the trigger file on failure — allow retry on next cron cycle
      return;
    }

    // Clean up the trigger file after successful execution
    try {
      await fsPromises.unlink(triggerFilePath);
      logger.debug({ taskId, filename }, 'Trigger file cleaned up');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err: error, taskId }, 'Failed to clean up trigger file');
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

/**
 * Write a trigger signal file to request immediate schedule execution.
 *
 * This is a standalone utility function that can be called from any script
 * (including `scripts/chat/create.ts`) without importing the full scheduling module.
 *
 * @param schedulesDir - The schedules directory path (e.g., 'workspace/schedules')
 * @param taskId - The task ID to trigger (e.g., 'schedule-chats-activation')
 *
 * @example
 * ```typescript
 * import { triggerSchedule } from './trigger-watcher.js';
 *
 * // After creating a chat file, trigger chats-activation immediately
 * await triggerSchedule('workspace/schedules', 'schedule-chats-activation');
 * ```
 */
export async function triggerSchedule(schedulesDir: string, taskId: string): Promise<void> {
  const triggersDir = path.join(schedulesDir, '.triggers');
  await fsPromises.mkdir(triggersDir, { recursive: true });

  const triggerFile = path.join(triggersDir, taskId);
  const timestamp = new Date().toISOString();

  await fsPromises.writeFile(triggerFile, timestamp, 'utf-8');
  logger.info({ taskId, triggerFile }, 'Trigger signal written');
}
