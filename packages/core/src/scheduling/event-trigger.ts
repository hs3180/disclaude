/**
 * EventTrigger - Filesystem event-driven schedule triggering.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Watches specified filesystem paths and triggers associated schedule tasks
 * when files are created or modified. This allows schedules to respond
 * immediately to filesystem changes instead of waiting for cron intervals.
 *
 * ## Architecture
 *
 * ```
 * ScheduledTask (with watch config)
 *         │
 *         ▼
 *   EventTrigger
 *     ├── fs.watch() on each unique directory in watch.paths
 *     ├── Debounce timer per task (configurable)
 *     ├── Event filtering (create / change / delete)
 *     └── → Scheduler.triggerTask(taskId)
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * const eventTrigger = new EventTrigger({
 *   onTrigger: async (taskId) => {
 *     await scheduler.triggerTask(taskId);
 *   },
 * });
 *
 * // Register tasks with watch configuration
 * eventTrigger.registerTask(task);
 *
 * // Start watching
 * await eventTrigger.start();
 * ```
 *
 * ## Frontmatter Configuration
 *
 * ```yaml
 * ---
 * name: "Chats Activation"
 * cron: "0 * * * * *"
 * watch:
 *   paths:
 *     - "workspace/chats"
 *   events: ["create", "change"]
 *   debounce: 5000
 * ---
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduledTask, WatchConfig } from './scheduled-task.js';

const logger = createLogger('EventTrigger');

/**
 * Callback invoked when a filesystem event should trigger a task.
 */
export type OnTriggerCallback = (taskId: string) => Promise<void>;

/**
 * EventTrigger configuration options.
 */
export interface EventTriggerOptions {
  /** Callback to invoke when a task should be triggered */
  onTrigger: OnTriggerCallback;
}

/**
 * Internal registration for a watched task.
 */
interface WatchedTask {
  taskId: string;
  config: WatchConfig;
}

/**
 * EventTrigger - Watches filesystem paths and triggers schedule tasks on events.
 *
 * Issue #1953: Enables event-driven schedule triggering alongside cron.
 *
 * Features:
 * - Watches directories specified in task `watch.paths`
 * - Filters events by type (create, change, delete)
 * - Debounces rapid filesystem events per task
 * - Multiple tasks can share the same watched directory
 * - Graceful error handling (watcher errors don't crash the process)
 */
export class EventTrigger {
  private onTrigger: OnTriggerCallback;
  /** Map of task ID to watched task registration */
  private watchedTasks: Map<string, WatchedTask> = new Map();
  /** Map of directory path to fs.FSWatcher */
  private watchers: Map<string, fs.FSWatcher> = new Map();
  /** Debounce timers per task */
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Whether the trigger is actively watching */
  private running = false;

  constructor(options: EventTriggerOptions) {
    this.onTrigger = options.onTrigger;
    logger.info('EventTrigger created');
  }

  /**
   * Register a task for event-driven triggering.
   *
   * If the task doesn't have a `watch` configuration, this is a no-op.
   * If the trigger is already running, immediately starts watching for this task.
   *
   * @param task - The scheduled task to register
   */
  registerTask(task: ScheduledTask): void {
    if (!task.watch || task.watch.paths.length === 0) {
      return;
    }

    const watched: WatchedTask = {
      taskId: task.id,
      config: task.watch,
    };

    this.watchedTasks.set(task.id, watched);
    logger.info(
      { taskId: task.id, paths: task.watch.paths, events: task.watch.events },
      'Registered task for event-driven triggering'
    );

    // If already running, start watching new paths immediately
    if (this.running) {
      void this.startWatchingPaths(watched.config.paths);
    }
  }

  /**
   * Unregister a task from event-driven triggering.
   *
   * @param taskId - The task ID to unregister
   */
  unregisterTask(taskId: string): void {
    const removed = this.watchedTasks.delete(taskId);
    if (!removed) {
      return;
    }

    // Clear any pending debounce timer
    const timer = this.debounceTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(taskId);
    }

    // Check if any remaining tasks still need each watched directory
    // Stop watchers for directories no longer needed
    this.cleanupUnusedWatchers();

    logger.info({ taskId }, 'Unregistered task from event-driven triggering');
  }

  /**
   * Start watching all registered paths.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('EventTrigger already running');
      return;
    }

    // Collect all unique paths across all tasks
    const allPaths = new Set<string>();
    for (const watched of this.watchedTasks.values()) {
      for (const p of watched.config.paths) {
        allPaths.add(p);
      }
    }

    await this.startWatchingPaths(allPaths);

    this.running = true;
    logger.info(
      { watchedDirs: this.watchers.size, registeredTasks: this.watchedTasks.size },
      'EventTrigger started'
    );
  }

  /**
   * Stop watching all paths.
   */
  stop(): void {
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.running = false;
    logger.info('EventTrigger stopped');
  }

  /**
   * Check if the trigger is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of registered tasks.
   */
  getRegisteredTaskCount(): number {
    return this.watchedTasks.size;
  }

  /**
   * Get the number of active directory watchers.
   */
  getActiveWatcherCount(): number {
    return this.watchers.size;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Start fs.watch on the given paths.
   */
  private async startWatchingPaths(paths: Iterable<string>): Promise<void> {
    for (const rawPath of paths) {
      // Resolve relative paths against cwd
      const resolvedPath = path.resolve(rawPath);

      // Only watch directories
      try {
        const stat = await fsPromises.stat(resolvedPath);
        if (!stat.isDirectory()) {
          logger.debug({ path: resolvedPath }, 'Skipping non-directory path');
          continue;
        }
      } catch {
        // Directory doesn't exist yet — create it
        try {
          await fsPromises.mkdir(resolvedPath, { recursive: true });
          logger.info({ path: resolvedPath }, 'Created watch directory');
        } catch (error) {
          logger.warn({ err: error, path: resolvedPath }, 'Failed to create watch directory, skipping');
          continue;
        }
      }

      // Already watching this directory?
      if (this.watchers.has(resolvedPath)) {
        continue;
      }

      try {
        const watcher = fs.watch(
          resolvedPath,
          { persistent: true, recursive: false },
          (eventType, filename) => {
            this.handleFileEvent(resolvedPath, eventType, filename);
          }
        );

        watcher.on('error', (error) => {
          logger.error({ err: error, path: resolvedPath }, 'Directory watcher error');
        });

        this.watchers.set(resolvedPath, watcher);
        logger.info({ path: resolvedPath }, 'Started watching directory');
      } catch (error) {
        logger.error({ err: error, path: resolvedPath }, 'Failed to start directory watcher');
      }
    }
  }

  /**
   * Handle a filesystem event from a watched directory.
   */
  private handleFileEvent(dirPath: string, eventType: string, filename: string | null): void {
    if (!filename) {
      return;
    }

    const _filePath = path.join(dirPath, filename);

    // Map fs.watch event types to our event types
    const mappedEvent = this.mapEventType(eventType);

    // Find all tasks that watch this directory and match the event
    for (const watched of this.watchedTasks.values()) {
      if (!this.isPathWatched(watched.config, dirPath)) {
        continue;
      }

      // Check if the event type matches the task's filter
      const events = watched.config.events ?? ['create', 'change'];
      if (!events.includes(mappedEvent)) {
        continue;
      }

      // Debounce: only trigger once per debounce period
      this.debouncedTrigger(watched);
    }
  }

  /**
   * Map fs.watch event type to our event type.
   *
   * fs.watch uses 'rename' for both create and delete, and 'change' for modifications.
   * We map 'rename' to 'create' optimistically (most common case for new files).
   */
  private mapEventType(eventType: string): 'create' | 'change' | 'delete' {
    if (eventType === 'change') {
      return 'change';
    }
    // 'rename' can mean create or delete — we treat it as 'create'
    // which is the most useful case for event-driven scheduling
    return 'create';
  }

  /**
   * Check if a directory is watched by the given config.
   */
  private isPathWatched(config: WatchConfig, dirPath: string): boolean {
    const resolvedDir = path.resolve(dirPath);
    return config.paths.some(p => path.resolve(p) === resolvedDir);
  }

  /**
   * Debounced trigger for a watched task.
   *
   * Resets the debounce timer on each call, so rapid events only
   * result in a single trigger after the debounce period elapses.
   */
  private debouncedTrigger(watched: WatchedTask): void {
    const existingTimer = this.debounceTimers.get(watched.taskId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const debounceMs = watched.config.debounce ?? 1000;

    const timer = setTimeout(() => {
      this.debounceTimers.delete(watched.taskId);
      logger.info({ taskId: watched.taskId }, 'Triggering task via filesystem event');
      void this.onTrigger(watched.taskId).catch((error) => {
        logger.error({ err: error, taskId: watched.taskId }, 'Failed to trigger task');
      });
    }, debounceMs);

    this.debounceTimers.set(watched.taskId, timer);
  }

  /**
   * Stop watchers for directories that are no longer watched by any task.
   */
  private cleanupUnusedWatchers(): void {
    // Collect all paths still in use
    const activePaths = new Set<string>();
    for (const watched of this.watchedTasks.values()) {
      for (const p of watched.config.paths) {
        activePaths.add(path.resolve(p));
      }
    }

    // Stop watchers not in the active set
    for (const [dirPath, watcher] of this.watchers) {
      if (!activePaths.has(dirPath)) {
        watcher.close();
        this.watchers.delete(dirPath);
        logger.info({ path: dirPath }, 'Stopped watching unused directory');
      }
    }
  }
}
