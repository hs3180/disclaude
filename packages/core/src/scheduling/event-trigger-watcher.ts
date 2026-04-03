/**
 * Event Trigger Watcher - File-watching based event-driven schedule trigger.
 *
 * Issue #1953: Design event-driven schedule trigger mechanism.
 *
 * This module monitors specified file paths and immediately triggers
 * schedule execution when file changes are detected, complementing
 * the existing cron-based polling.
 *
 * Architecture:
 * ```
 * EventTriggerWatcher
 *   ├── watches directories for file changes
 *   ├── debounces rapid successive changes (default 2s)
 *   ├── routes change events to matching task IDs
 *   └── invokes Scheduler.triggerTask(taskId) for immediate execution
 * ```
 *
 * Key Design Decisions:
 * - Uses native fs.watch (same as ScheduleFileWatcher, no extra deps)
 * - CooldownManager provides natural de-duplication across event/cron triggers
 * - Watch patterns support glob-style directory monitoring (not recursive file matching)
 * - Graceful degradation: watch errors are logged but don't crash the scheduler
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduledTask } from './scheduled-task.js';

const logger = createLogger('EventTriggerWatcher');

/**
 * Callback type for triggering a task by ID.
 * Implemented by Scheduler.triggerTask().
 * Can return boolean (true if task was found and triggered) or void.
 */
export type TriggerTaskFn = (taskId: string) => Promise<boolean | void>;

/**
 * Watch configuration for a single task.
 */
interface WatchRegistration {
  /** Task ID to trigger */
  taskId: string;
  /** Resolved directory paths being watched */
  watchedDirs: Set<string>;
  /** Original glob patterns from frontmatter */
  patterns: string[];
}

/**
 * Options for EventTriggerWatcher.
 */
export interface EventTriggerWatcherOptions {
  /**
   * Function to trigger a task by ID.
   * Typically Scheduler.triggerTask().
   */
  triggerTask: TriggerTaskFn;
  /**
   * Base directory for resolving relative watch paths.
   * Defaults to process.cwd().
   */
  baseDir?: string;
  /**
   * Debounce interval in milliseconds.
   * Multiple file changes within this window are coalesced into a single trigger.
   * Default: 2000ms (2 seconds).
   */
  debounceMs?: number;
}

/**
 * EventTriggerWatcher - Monitors file paths and triggers schedule execution on change.
 *
 * Usage:
 * ```typescript
 * const watcher = new EventTriggerWatcher({
 *   triggerTask: (taskId) => scheduler.triggerTask(taskId),
 *   baseDir: '/path/to/workspace',
 * });
 *
 * // Register tasks with watch configurations
 * await watcher.registerTask(task);
 *
 * // Start watching
 * await watcher.start();
 *
 * // Later: add a new task
 * await watcher.registerTask(newTask);
 *
 * // Stop watching
 * watcher.stop();
 * ```
 */
export class EventTriggerWatcher {
  private triggerTask: TriggerTaskFn;
  private baseDir: string;
  private debounceMs: number;
  private registrations: Map<string, WatchRegistration> = new Map();
  /** Map from watched directory → fs.FSWatcher instance */
  private watchers: Map<string, fs.FSWatcher> = new Map();
  /** Map from watched directory → Set of task IDs interested in changes */
  private dirToTaskIds: Map<string, Set<string>> = new Map();
  /** Debounce timers per task ID */
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  constructor(options: EventTriggerWatcherOptions) {
    this.triggerTask = options.triggerTask;
    this.baseDir = options.baseDir ?? process.cwd();
    this.debounceMs = options.debounceMs ?? 2000;
    logger.info({ baseDir: this.baseDir, debounceMs: this.debounceMs }, 'EventTriggerWatcher initialized');
  }

  /**
   * Register a task for event-driven triggering.
   * If the task has `watch` patterns, starts monitoring those paths.
   * Can be called before or after start().
   *
   * @param task - Task to register (must have watch field)
   * @returns true if task was registered with watch patterns, false if no watch
   */
  async registerTask(task: ScheduledTask): Promise<boolean> {
    // Unregister existing registration for this task
    await this.unregisterTask(task.id);

    if (!task.watch || task.watch.length === 0) {
      return false;
    }

    const patterns = task.watch;
    const watchedDirs = new Set<string>();

    // Resolve patterns to directories
    for (const pattern of patterns) {
      const resolvedDir = await this.resolvePatternToDir(pattern);
      if (resolvedDir) {
        watchedDirs.add(resolvedDir);
      }
    }

    if (watchedDirs.size === 0) {
      logger.warn({ taskId: task.id, patterns }, 'No valid watch directories found for task');
      return false;
    }

    // Store registration
    this.registrations.set(task.id, { taskId: task.id, watchedDirs, patterns });

    // Map directories to task IDs
    for (const dir of watchedDirs) {
      if (!this.dirToTaskIds.has(dir)) {
        this.dirToTaskIds.set(dir, new Set());
      }
      this.dirToTaskIds.get(dir)!.add(task.id);
    }

    // If already running, start watching new directories
    if (this.running) {
      for (const dir of watchedDirs) {
        await this.ensureWatching(dir);
      }
    }

    logger.info(
      { taskId: task.id, name: task.name, patterns, dirCount: watchedDirs.size },
      'Registered task for event-driven triggering'
    );

    return true;
  }

  /**
   * Unregister a task, stopping watches for directories no longer needed.
   *
   * @param taskId - Task ID to unregister
   */
  async unregisterTask(taskId: string): Promise<void> {
    const registration = this.registrations.get(taskId);
    if (!registration) {
      return;
    }

    // Remove task from directory mappings
    for (const dir of registration.watchedDirs) {
      const taskIds = this.dirToTaskIds.get(dir);
      if (taskIds) {
        taskIds.delete(taskId);
        // If no tasks left watching this dir, stop the watcher
        if (taskIds.size === 0) {
          this.stopWatchingDir(dir);
          this.dirToTaskIds.delete(dir);
        }
      }
    }

    // Clear debounce timer
    const timer = this.debounceTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(taskId);
    }

    this.registrations.delete(taskId);
    logger.info({ taskId }, 'Unregistered task from event-driven triggering');
  }

  /**
   * Start the event trigger watcher.
   * Begins monitoring all registered watch directories.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('EventTriggerWatcher already running');
      return;
    }

    this.running = true;

    // Start watching all registered directories
    for (const [, registration] of this.registrations) {
      for (const dir of registration.watchedDirs) {
        await this.ensureWatching(dir);
      }
    }

    logger.info(
      { dirCount: this.watchers.size, taskCount: this.registrations.size },
      'EventTriggerWatcher started'
    );
  }

  /**
   * Stop the event trigger watcher.
   * Stops all file watchers and clears debounce timers.
   */
  stop(): void {
    this.running = false;

    // Stop all watchers
    for (const [dir, watcher] of this.watchers) {
      watcher.close();
      logger.debug({ dir }, 'Stopped watching directory');
    }
    this.watchers.clear();

    // Clear all debounce timers
    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    logger.info('EventTriggerWatcher stopped');
  }

  /**
   * Check if the watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of registered tasks and watched directories.
   */
  getStats(): { taskCount: number; dirCount: number } {
    return {
      taskCount: this.registrations.size,
      dirCount: this.watchers.size,
    };
  }

  /**
   * Resolve a glob pattern to the directory it targets.
   * For patterns like "workspace/chats/*.json", returns "workspace/chats/".
   * For absolute paths, uses them directly.
   *
   * @param pattern - Glob pattern from watch configuration
   * @returns Resolved directory path or null if invalid
   */
  private async resolvePatternToDir(pattern: string): Promise<string | null> {
    try {
      // Resolve relative to baseDir
      const resolved = path.resolve(this.baseDir, pattern);

      // Extract directory portion (everything before the glob part)
      // e.g., "workspace/chats/*.json" → "workspace/chats"
      // e.g., "workspace/chats/" → "workspace/chats"
      const dir = path.dirname(resolved);

      // Ensure directory exists
      await fsPromises.mkdir(dir, { recursive: true });

      return dir;
    } catch (error) {
      logger.warn({ pattern, err: error }, 'Failed to resolve watch pattern');
      return null;
    }
  }

  /**
   * Ensure a directory is being watched.
   * If already watching, does nothing.
   *
   * @param dir - Directory path to watch
   */
  private async ensureWatching(dir: string): Promise<void> {
    if (this.watchers.has(dir)) {
      return; // Already watching
    }

    try {
      const watcher = fs.watch(
        dir,
        { persistent: false },
        (eventType, filename) => {
          this.handleFileChange(dir, eventType, filename);
        }
      );

      watcher.on('error', (error) => {
        logger.error({ err: error, dir }, 'File watcher error on watched directory');
        // Remove broken watcher
        this.watchers.delete(dir);
      });

      this.watchers.set(dir, watcher);
      logger.debug({ dir }, 'Started watching directory for event triggers');
    } catch (error) {
      logger.error({ err: error, dir }, 'Failed to start watching directory');
    }
  }

  /**
   * Stop watching a directory.
   *
   * @param dir - Directory path to stop watching
   */
  private stopWatchingDir(dir: string): void {
    const watcher = this.watchers.get(dir);
    if (watcher) {
      watcher.close();
      this.watchers.delete(dir);
      logger.debug({ dir }, 'Stopped watching directory (no more tasks)');
    }
  }

  /**
   * Handle a file change event from fs.watch.
   * Debounces and routes the event to matching tasks.
   *
   * @param dir - Directory where change occurred
   * @param eventType - Type of file event ('rename' or 'change')
   * @param filename - Name of the changed file
   */
  private handleFileChange(dir: string, eventType: string, filename: string | null): void {
    if (!filename) {
      return;
    }

    logger.debug({ dir, eventType, filename }, 'File change detected in watched directory');

    // Find all tasks that watch this directory
    const taskIds = this.dirToTaskIds.get(dir);
    if (!taskIds || taskIds.size === 0) {
      return;
    }

    for (const taskId of taskIds) {
      this.scheduleTrigger(taskId);
    }
  }

  /**
   * Schedule a task trigger with debouncing.
   * If a trigger is already scheduled for this task, resets the timer.
   *
   * @param taskId - Task ID to trigger
   */
  private scheduleTrigger(taskId: string): void {
    // Clear existing timer
    const existingTimer = this.debounceTimers.get(taskId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new trigger
    const timer = setTimeout(() => {
      this.debounceTimers.delete(taskId);
      void this.executeTrigger(taskId);
    }, this.debounceMs);

    this.debounceTimers.set(taskId, timer);
  }

  /**
   * Execute a task trigger via the injected triggerTask function.
   *
   * @param taskId - Task ID to trigger
   */
  private async executeTrigger(taskId: string): Promise<void> {
    const registration = this.registrations.get(taskId);
    if (!registration) {
      return;
    }

    logger.info(
      { taskId, name: 'unknown', patterns: registration.patterns },
      'Event trigger firing for task'
    );

    try {
      await this.triggerTask(taskId);
      logger.info({ taskId }, 'Event trigger completed for task');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Event trigger failed for task');
    }
  }
}
