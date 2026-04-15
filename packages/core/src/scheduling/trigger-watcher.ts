/**
 * TriggerWatcher - Watches directories for file changes and triggers scheduled tasks.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * This module enables non-cron triggering of scheduled tasks.
 * When a file changes in a watched directory, the task is immediately
 * executed (subject to blocking and cooldown constraints).
 *
 * Architecture:
 * ```
 * Schedule frontmatter:
 *   watch: "workspace/chats"
 *   watchDebounce: 5000
 *
 * TriggerWatcher:
 *   fs.watch(directory) → debounce → onTrigger(taskId)
 *
 * Scheduler:
 *   onTrigger → executeTask (same path as cron trigger)
 * ```
 *
 * Features:
 * - Directory-based file watching using fs.watch
 * - Per-task configurable debounce interval
 * - Multiple tasks can watch the same directory
 * - Automatic cleanup when tasks are removed
 * - Graceful error handling (logs warnings, doesn't crash)
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TriggerWatcher');

// ============================================================================
// Types
// ============================================================================

/**
 * Callback when a trigger fires.
 *
 * @param taskId - The ID of the task to trigger
 */
export type OnTriggerCallback = (taskId: string) => void;

/**
 * TriggerWatcher options.
 */
export interface TriggerWatcherOptions {
  /** Base directory for resolving relative watch paths */
  basePath: string;
  /** Callback when a trigger fires */
  onTrigger: OnTriggerCallback;
}

/**
 * Internal watch entry mapping a task to a watched directory.
 */
interface WatchEntry {
  /** Task ID to trigger */
  taskId: string;
  /** Debounce interval in milliseconds */
  debounceMs: number;
}

// ============================================================================
// TriggerWatcher
// ============================================================================

/**
 * TriggerWatcher - Watches directories and triggers scheduled tasks on file changes.
 *
 * Usage:
 * ```typescript
 * const watcher = new TriggerWatcher({
 *   basePath: '/workspace',
 *   onTrigger: (taskId) => scheduler.executeTaskById(taskId),
 * });
 *
 * // Register watches
 * watcher.addWatch('task-1', 'workspace/chats', 5000);
 * watcher.addWatch('task-2', 'workspace/data', 3000);
 *
 * // Start watching
 * await watcher.start();
 *
 * // Later, remove a watch
 * watcher.removeWatch('task-1');
 *
 * // Stop all
 * watcher.stop();
 * ```
 */
export class TriggerWatcher {
  private basePath: string;
  private onTrigger: OnTriggerCallback;
  /** Map of resolved directory path to watch entries */
  private watches: Map<string, WatchEntry[]> = new Map();
  /** Active fs.watch instances, keyed by directory path */
  private watchers: Map<string, fs.FSWatcher> = new Map();
  /** Debounce timers, keyed by `${dirPath}:${taskId}` */
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  constructor(options: TriggerWatcherOptions) {
    this.basePath = options.basePath;
    this.onTrigger = options.onTrigger;
    logger.info({ basePath: this.basePath }, 'TriggerWatcher initialized');
  }

  /**
   * Add a watch for a task.
   *
   * If the watcher is already running, the directory will be watched immediately.
   * If not running, it will be started when start() is called.
   *
   * @param taskId - Task ID to trigger
   * @param watchPath - Directory path to watch (relative to basePath or absolute)
   * @param debounceMs - Debounce interval in milliseconds (default: 1000)
   */
  addWatch(taskId: string, watchPath: string, debounceMs: number = 1000): void {
    const resolvedPath = path.resolve(this.basePath, watchPath);
    const entry: WatchEntry = { taskId, debounceMs };

    let entries = this.watches.get(resolvedPath);
    if (!entries) {
      entries = [];
      this.watches.set(resolvedPath, entries);

      // Start watching the directory if already running
      if (this.running) {
        this.startWatchingDir(resolvedPath);
      }
    }
    entries.push(entry);

    logger.info({ taskId, watchPath, resolvedPath, debounceMs }, 'Added file watch trigger');
  }

  /**
   * Remove all watches for a task.
   *
   * If no more tasks are watching a directory, the fs.watch instance is closed.
   *
   * @param taskId - Task ID to remove watches for
   */
  removeWatch(taskId: string): void {
    const dirsToRemove: string[] = [];

    for (const [dirPath, entries] of this.watches) {
      const filtered = entries.filter(e => e.taskId !== taskId);

      if (filtered.length === 0) {
        // No more tasks watching this directory
        dirsToRemove.push(dirPath);
      } else if (filtered.length !== entries.length) {
        // Some tasks still watching, update the list
        this.watches.set(dirPath, filtered);
      }
    }

    // Clean up directories with no more watchers
    for (const dirPath of dirsToRemove) {
      this.watches.delete(dirPath);

      const watcher = this.watchers.get(dirPath);
      if (watcher) {
        watcher.close();
        this.watchers.delete(dirPath);
      }
    }

    // Clear any pending debounce timers for this task
    for (const [key, timer] of this.debounceTimers) {
      if (key.endsWith(`:${taskId}`)) {
        clearTimeout(timer);
        this.debounceTimers.delete(key);
      }
    }

    logger.info({ taskId }, 'Removed file watch trigger');
  }

  /**
   * Start watching all registered directories.
   */
  start(): void {
    if (this.running) {
      logger.warn('TriggerWatcher already running');
      return;
    }

    this.running = true;

    for (const dirPath of this.watches.keys()) {
      this.startWatchingDir(dirPath);
    }

    logger.info({ directoryCount: this.watchers.size }, 'TriggerWatcher started');
  }

  /**
   * Stop all watchers and clear debounce timers.
   */
  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.running = false;
    logger.info('TriggerWatcher stopped');
  }

  /**
   * Check if the watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of active directory watchers.
   */
  getWatchCount(): number {
    return this.watchers.size;
  }

  /**
   * Get the total number of task watches registered.
   */
  getTaskWatchCount(): number {
    let count = 0;
    for (const entries of this.watches.values()) {
      count += entries.length;
    }
    return count;
  }

  /**
   * Start watching a specific directory.
   */
  private startWatchingDir(dirPath: string): void {
    // Skip if already watching
    if (this.watchers.has(dirPath)) {
      return;
    }

    try {
      // Ensure directory exists
      fs.mkdirSync(dirPath, { recursive: true });

      const watcher = fs.watch(
        dirPath,
        { persistent: true, recursive: false },
        (eventType) => {
          this.handleFileEvent(dirPath, eventType);
        }
      );

      watcher.on('error', (error) => {
        logger.error({ err: error, dirPath }, 'Trigger watcher error');
      });

      this.watchers.set(dirPath, watcher);
      logger.debug({ dirPath }, 'Started watching directory');
    } catch (error) {
      logger.error({ err: error, dirPath }, 'Failed to start watching directory');
    }
  }

  /**
   * Handle a file event in a watched directory.
   *
   * Debounces events per task to prevent rapid-fire triggers.
   */
  private handleFileEvent(dirPath: string, _eventType: string): void {
    const entries = this.watches.get(dirPath);
    if (!entries) { return; }

    for (const entry of entries) {
      const timerKey = `${dirPath}:${entry.taskId}`;

      // Clear existing debounce timer
      const existingTimer = this.debounceTimers.get(timerKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set new debounce timer
      const timer = setTimeout(() => {
        this.debounceTimers.delete(timerKey);
        logger.info(
          { taskId: entry.taskId, dirPath, debounceMs: entry.debounceMs },
          'File watch trigger fired'
        );
        this.onTrigger(entry.taskId);
      }, entry.debounceMs);

      this.debounceTimers.set(timerKey, timer);
    }
  }
}
