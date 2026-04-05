/**
 * EventTriggerWatcher - Watches file system paths and triggers schedules on change.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Monitors declared directories for file changes and triggers the associated
 * schedule via the TriggerManager when changes are detected.
 *
 * Features:
 * - Recursive directory watching via fs.watch
 * - Configurable debounce per watch path
 * - Automatic setup/teardown when schedules are added/removed
 * - Graceful handling of missing directories
 *
 * Usage:
 * ```typescript
 * const watcher = new EventTriggerWatcher({
 *   baseDir: '/app/workspace',
 *   onTrigger: (taskId) => {
 *     scheduler.triggerTask(taskId);
 *   },
 * });
 *
 * // Start watching for a task
 * watcher.watchTask('schedule-chats-activation', 'workspace/chats', 5000);
 *
 * // Stop watching for a task
 * watcher.unwatchTask('schedule-chats-activation');
 *
 * // Stop all watchers
 * watcher.stopAll();
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('EventTriggerWatcher');

/**
 * Per-task watch state.
 */
interface WatchEntry {
  /** Task ID being watched */
  taskId: string;
  /** Absolute path being watched */
  watchPath: string;
  /** fs.watch instance */
  watcher: fs.FSWatcher;
  /** Debounce timer */
  debounceTimer: NodeJS.Timeout | null;
  /** Debounce interval in ms */
  debounceMs: number;
}

/**
 * EventTriggerWatcher options.
 */
export interface EventTriggerWatcherOptions {
  /** Base directory for resolving relative watch paths */
  baseDir: string;
  /** Callback when a watched path triggers a task */
  onTrigger: (taskId: string) => void;
}

/**
 * EventTriggerWatcher - Watches file system paths for event-driven schedule triggering.
 *
 * This watcher monitors directories declared in schedule frontmatter `watch` field.
 * When files in a watched directory change, it notifies via the onTrigger callback,
 * which typically calls TriggerManager.trigger() to write a signal file.
 *
 * The watcher uses Node.js native fs.watch with recursive option for subdirectory support.
 * Events are debounced per task to prevent rapid re-triggering from batch file operations.
 */
export class EventTriggerWatcher {
  private baseDir: string;
  private onTrigger: (taskId: string) => void;
  /** Map from taskId to watch entry */
  private entries: Map<string, WatchEntry> = new Map();

  constructor(options: EventTriggerWatcherOptions) {
    this.baseDir = options.baseDir;
    this.onTrigger = options.onTrigger;
    logger.info({ baseDir: this.baseDir }, 'EventTriggerWatcher initialized');
  }

  /**
   * Start watching a directory for a specific task.
   *
   * If a watch already exists for the task, it is stopped and replaced.
   *
   * @param taskId - Task ID to associate with this watch
   * @param watchPath - Relative or absolute directory path to watch
   * @param debounceMs - Debounce interval in ms (default: 5000)
   */
  async watchTask(taskId: string, watchPath: string, debounceMs = 5000): Promise<void> {
    // Stop existing watch for this task if any
    this.unwatchTask(taskId);

    // Resolve the watch path
    const absolutePath = path.isAbsolute(watchPath)
      ? watchPath
      : path.resolve(this.baseDir, watchPath);

    // Ensure directory exists
    try {
      await fsPromises.mkdir(absolutePath, { recursive: true });
    } catch (error) {
      logger.error({ err: error, taskId, watchPath: absolutePath }, 'Failed to create watch directory');
      return;
    }

    try {
      const watcher = fs.watch(
        absolutePath,
        { persistent: true, recursive: true },
        (eventType, filename) => {
          this.handleFileEvent(taskId, eventType, filename);
        }
      );

      watcher.on('error', (error) => {
        logger.error({ err: error, taskId, watchPath: absolutePath }, 'Watch error');
      });

      const entry: WatchEntry = {
        taskId,
        watchPath: absolutePath,
        watcher,
        debounceTimer: null,
        debounceMs,
      };

      this.entries.set(taskId, entry);
      logger.info(
        { taskId, watchPath: absolutePath, debounceMs },
        'Started watching directory for task'
      );

    } catch (error) {
      logger.error({ err: error, taskId, watchPath: absolutePath }, 'Failed to start watching');
    }
  }

  /**
   * Stop watching for a specific task.
   *
   * @param taskId - Task ID to stop watching
   */
  unwatchTask(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (entry) {
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
      }
      entry.watcher.close();
      this.entries.delete(taskId);
      logger.info({ taskId }, 'Stopped watching for task');
    }
  }

  /**
   * Stop all watchers.
   */
  stopAll(): void {
    for (const [taskId, entry] of this.entries) {
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
      }
      entry.watcher.close();
      logger.debug({ taskId }, 'Stopped watching');
    }
    this.entries.clear();
    logger.info('All event watchers stopped');
  }

  /**
   * Get the number of active watchers.
   */
  getWatchCount(): number {
    return this.entries.size;
  }

  /**
   * Check if a specific task is being watched.
   */
  isWatching(taskId: string): boolean {
    return this.entries.has(taskId);
  }

  /**
   * Get all watched task IDs.
   */
  getWatchedTaskIds(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Handle a file system event from fs.watch.
   * Debounces events per task to prevent rapid re-triggering.
   */
  private handleFileEvent(taskId: string, _eventType: string, filename: string | null): void {
    if (!filename) {
      return;
    }

    // Skip hidden files and trigger files (prevent feedback loops)
    if (filename.startsWith('.')) {
      return;
    }

    const entry = this.entries.get(taskId);
    if (!entry) {
      return;
    }

    // Debounce: reset timer on each event
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }

    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      logger.info({ taskId, filename }, 'Watch event triggered (debounced)');
      try {
        this.onTrigger(taskId);
      } catch (error) {
        logger.error({ err: error, taskId }, 'Error in trigger callback');
      }
    }, entry.debounceMs);
  }
}
