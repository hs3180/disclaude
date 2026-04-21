/**
 * Schedule Trigger - File watcher based event-driven schedule execution.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Monitors specified file system paths and triggers schedule execution
 * when changes are detected. Integrates with the Scheduler to provide
 * immediate (non-cron-based) task triggering.
 *
 * Architecture:
 * ```
 * WatchTrigger (path config)
 *     ↓
 * ScheduleTrigger (monitors paths via fs.watch)
 *     ↓ onChange (debounced)
 * Scheduler.triggerTask(taskId)
 *     ↓
 * executeTask(task)  [reuses existing cron execution logic]
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduledTask } from './scheduled-task.js';

const logger = createLogger('ScheduleTrigger');

/**
 * Callback invoked when a watched task should be triggered.
 */
export type OnTriggered = (task: ScheduledTask) => void;

/**
 * Entry for an active file watcher.
 */
interface WatcherEntry {
  /** The directory being watched */
  dir: string;
  /** The fs.FSWatcher instance */
  watcher: fs.FSWatcher;
  /** Task IDs that are watching this directory */
  taskIds: Set<string>;
}

/**
 * ScheduleTrigger - Monitors file system paths for changes and triggers schedule execution.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Features:
 * - Directory-level file watching via fs.watch
 * - Per-task debounce to prevent rapid re-triggering
 * - Shared watchers when multiple tasks watch the same directory
 * - Graceful cleanup on stop
 *
 * Usage:
 * ```typescript
 * const trigger = new ScheduleTrigger({
 *   onTriggered: (task) => scheduler.triggerTask(task.id),
 * });
 *
 * trigger.registerTask(task);
 * await trigger.start();
 * // ... file changes trigger task execution ...
 * trigger.stop();
 * ```
 */
export class ScheduleTrigger {
  private onTriggered: OnTriggered;
  private watchers: Map<string, WatcherEntry> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;
  private taskConfigs: Map<string, { task: ScheduledTask; debounce: number }> = new Map();

  constructor(options: { onTriggered: OnTriggered }) {
    this.onTriggered = options.onTriggered;
    logger.info('ScheduleTrigger created');
  }

  /**
   * Register a task for watch-based triggering.
   *
   * @param task - The scheduled task with watch configuration
   */
  registerTask(task: ScheduledTask): void {
    if (!task.watch || !task.watch.paths || task.watch.paths.length === 0) {
      return;
    }

    const debounce = task.watch.debounce ?? 1000;
    this.taskConfigs.set(task.id, { task, debounce });
    logger.info(
      { taskId: task.id, name: task.name, paths: task.watch.paths, debounce },
      'Registered task for watch triggering'
    );
  }

  /**
   * Unregister a task from watch-based triggering.
   *
   * @param taskId - Task ID to unregister
   */
  unregisterTask(taskId: string): void {
    const config = this.taskConfigs.get(taskId);
    if (!config) { return; }

    this.taskConfigs.delete(taskId);
    this.clearDebounceTimer(taskId);

    // Remove task ID from watcher entries and clean up empty watchers
    for (const [dir, entry] of this.watchers) {
      entry.taskIds.delete(taskId);
      if (entry.taskIds.size === 0) {
        entry.watcher.close();
        this.watchers.delete(dir);
        logger.debug({ dir }, 'Stopped file watcher (no remaining tasks)');
      }
    }

    logger.info({ taskId }, 'Unregistered task from watch triggering');
  }

  /**
   * Start watching all registered tasks.
   * Sets up fs.watch for each unique directory path.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('ScheduleTrigger already running');
      return;
    }

    this.running = true;

    for (const [taskId, config] of this.taskConfigs) {
      for (const watchPath of (config.task.watch ?? { paths: [] }).paths) {
        await this.setupWatcher(taskId, watchPath);
      }
    }

    logger.info(
      { taskCount: this.taskConfigs.size, watcherCount: this.watchers.size },
      'ScheduleTrigger started'
    );
  }

  /**
   * Stop all watchers and clear debounce timers.
   */
  stop(): void {
    this.running = false;

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const [dir, entry] of this.watchers) {
      entry.watcher.close();
      logger.debug({ dir }, 'Stopped file watcher');
    }
    this.watchers.clear();

    logger.info('ScheduleTrigger stopped');
  }

  /**
   * Check if trigger is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of registered tasks.
   */
  getTaskCount(): number {
    return this.taskConfigs.size;
  }

  /**
   * Get the number of active watchers.
   */
  getWatcherCount(): number {
    return this.watchers.size;
  }

  /**
   * Set up a file watcher for a specific path and task.
   */
  private async setupWatcher(taskId: string, watchPath: string): Promise<void> {
    try {
      // Ensure the directory exists
      await fsPromises.mkdir(watchPath, { recursive: true });
    } catch (error) {
      logger.warn(
        { taskId, watchPath, err: error },
        'Cannot create watched directory, skipping'
      );
      return;
    }

    // Resolve to absolute path for consistent comparison
    const resolvedPath = path.resolve(watchPath);

    // Reuse existing watcher if available
    const existing = this.watchers.get(resolvedPath);
    if (existing) {
      existing.taskIds.add(taskId);
      logger.debug({ taskId, dir: resolvedPath }, 'Reusing existing file watcher');
      return;
    }

    try {
      const watcher = fs.watch(
        resolvedPath,
        { persistent: true, recursive: false },
        (_eventType, filename) => {
          if (filename) {
            this.handleFileChange(resolvedPath, filename);
          }
        }
      );

      watcher.on('error', (error) => {
        logger.error({ dir: resolvedPath, err: error }, 'File watcher error');
      });

      const taskIds = new Set<string>([taskId]);
      this.watchers.set(resolvedPath, { dir: resolvedPath, watcher, taskIds });
      logger.debug({ taskId, dir: resolvedPath }, 'Created file watcher');
    } catch (error) {
      logger.error({ taskId, dir: resolvedPath, err: error }, 'Failed to create file watcher');
    }
  }

  /**
   * Handle a file change event from a watcher.
   * Debounces per-task to prevent rapid re-triggering.
   */
  private handleFileChange(dir: string, _filename: string): void {
    const entry = this.watchers.get(dir);
    if (!entry) { return; }

    for (const taskId of entry.taskIds) {
      this.scheduleTrigger(taskId);
    }
  }

  /**
   * Schedule a debounced trigger for a task.
   */
  private scheduleTrigger(taskId: string): void {
    // Clear existing timer for this task
    this.clearDebounceTimer(taskId);

    const config = this.taskConfigs.get(taskId);
    if (!config) { return; }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(taskId);
      this.doTrigger(taskId);
    }, config.debounce);

    this.debounceTimers.set(taskId, timer);
    logger.debug(
      { taskId, debounce: config.debounce },
      'Scheduled watch trigger (debounced)'
    );
  }

  /**
   * Execute the trigger callback for a task.
   */
  private doTrigger(taskId: string): void {
    const config = this.taskConfigs.get(taskId);
    if (!config) { return; }

    logger.info(
      { taskId, name: config.task.name },
      'Watch trigger fired — executing task'
    );
    this.onTriggered(config.task);
  }

  /**
   * Clear a debounce timer for a task.
   */
  private clearDebounceTimer(taskId: string): void {
    const timer = this.debounceTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(taskId);
    }
  }
}
