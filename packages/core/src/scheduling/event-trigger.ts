/**
 * EventTriggerManager - File system event-driven schedule triggering.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Watches specified directories for file system events and triggers
 * the corresponding schedule execution via `Scheduler.triggerNow()`.
 *
 * ## Architecture
 *
 * ```
 * Schedule frontmatter:
 *   triggerWatch: "workspace/chats/"
 *   triggerDebounce: 5000
 *       ↓
 * EventTriggerManager reads all tasks with trigger config
 *       ↓
 * Sets up fs.watch on each unique watch directory
 *       ↓
 * File event (create/modify) → debounce → scheduler.triggerNow(taskId)
 * ```
 *
 * ## Design Decisions
 *
 * 1. **Coalesced watchers**: Multiple tasks watching the same directory
 *    share a single `fs.watch` instance for efficiency.
 * 2. **Per-task debounce**: Each task has its own debounce timer,
 *    preventing rapid re-triggers while allowing different tasks to
 *    trigger independently.
 * 3. **Graceful degradation**: If `fs.watch` fails on a directory,
 *    the error is logged and the task falls back to cron-only triggering.
 * 4. **Workspace-relative paths**: Watch paths in frontmatter are relative
 *    to the workspace root, resolved at initialization time.
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduledTask } from './scheduled-task.js';

const logger = createLogger('EventTriggerManager');

/** Default debounce interval in milliseconds. */
const DEFAULT_DEBOUNCE_MS = 5000;

/**
 * Callback type for triggering a task.
 * Decouples EventTriggerManager from the Scheduler class.
 */
export type TriggerCallback = (taskId: string) => Promise<boolean>;

/**
 * Watcher entry tracking an active fs.watch instance and associated tasks.
 */
interface WatcherEntry {
  /** The fs.watch instance */
  watcher: fs.FSWatcher;
  /** Set of task IDs that watch this directory */
  taskIds: Set<string>;
}

/**
 * EventTriggerManager options.
 */
export interface EventTriggerManagerOptions {
  /** Root directory for resolving relative watch paths */
  workspaceDir: string;
  /** Callback to trigger a task execution */
  onTrigger: TriggerCallback;
}

/**
 * EventTriggerManager - Manages file system watchers for event-driven schedule triggering.
 *
 * Usage:
 * ```typescript
 * const manager = new EventTriggerManager({
 *   workspaceDir: '/path/to/workspace',
 *   onTrigger: (taskId) => scheduler.triggerNow(taskId),
 * });
 *
 * // Register tasks with trigger config
 * manager.registerTask(task1);
 * manager.registerTask(task2);
 *
 * // Start watching
 * await manager.start();
 *
 * // Stop watching
 * manager.stop();
 * ```
 */
export class EventTriggerManager {
  private workspaceDir: string;
  private onTrigger: TriggerCallback;
  private watchers: Map<string, WatcherEntry> = new Map();
  /** Map of taskId → debounce timer */
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Map of taskId → resolved watch directory */
  private taskWatchDirs: Map<string, string> = new Map();
  /** Map of taskId → debounce interval */
  private taskDebounceMs: Map<string, number> = new Map();
  private running = false;

  constructor(options: EventTriggerManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.onTrigger = options.onTrigger;
    logger.info({ workspaceDir: this.workspaceDir }, 'EventTriggerManager initialized');
  }

  /**
   * Register a task for event-driven triggering.
   *
   * If the task has a `trigger` config, the watch directory is resolved
   * and the task is associated with the corresponding watcher.
   *
   * Must be called before `start()`, or call `start()` again to pick up changes.
   *
   * @param task - The scheduled task to register
   */
  registerTask(task: ScheduledTask): void {
    if (!task.trigger?.watch) {
      return;
    }

    const resolvedDir = this.resolveWatchPath(task.trigger.watch);
    this.taskWatchDirs.set(task.id, resolvedDir);
    this.taskDebounceMs.set(task.id, task.trigger.debounce ?? DEFAULT_DEBOUNCE_MS);

    logger.info(
      { taskId: task.id, name: task.name, watchDir: resolvedDir, debounceMs: task.trigger.debounce ?? DEFAULT_DEBOUNCE_MS },
      'Registered event trigger for task'
    );
  }

  /**
   * Unregister a task from event-driven triggering.
   *
   * @param taskId - The task ID to unregister
   */
  unregisterTask(taskId: string): void {
    this.taskWatchDirs.delete(taskId);
    this.taskDebounceMs.delete(taskId);

    // Clear any pending debounce timer
    const timer = this.debounceTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(taskId);
    }

    logger.debug({ taskId }, 'Unregistered event trigger for task');
  }

  /**
   * Start watching all registered directories.
   *
   * Creates one `fs.watch` instance per unique directory.
   * Tasks sharing the same directory share the same watcher.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('EventTriggerManager already running');
      return;
    }

    // Collect unique directories
    const uniqueDirs = new Set<string>(this.taskWatchDirs.values());

    if (uniqueDirs.size === 0) {
      logger.info('No event trigger directories to watch');
      this.running = true;
      return;
    }

    for (const dir of uniqueDirs) {
      await this.startWatcher(dir);
    }

    this.running = true;
    logger.info({ watcherCount: this.watchers.size }, 'EventTriggerManager started');
  }

  /**
   * Stop all watchers and clear debounce timers.
   */
  stop(): void {
    for (const [, entry] of this.watchers) {
      entry.watcher.close();
    }
    this.watchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.running = false;
    logger.info('EventTriggerManager stopped');
  }

  /**
   * Check if the manager is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of active watchers.
   */
  getWatcherCount(): number {
    return this.watchers.size;
  }

  /**
   * Get the number of registered tasks.
   */
  getRegisteredTaskCount(): number {
    return this.taskWatchDirs.size;
  }

  /**
   * Resolve a watch path relative to the workspace directory.
   *
   * @param watchPath - Relative or absolute watch path
   * @returns Absolute resolved path
   */
  private resolveWatchPath(watchPath: string): string {
    if (path.isAbsolute(watchPath)) {
      return path.normalize(watchPath);
    }
    return path.resolve(this.workspaceDir, watchPath);
  }

  /**
   * Start a watcher for a specific directory.
   *
   * @param dir - Absolute directory path to watch
   */
  private async startWatcher(dir: string): Promise<void> {
    // Already watching this directory
    if (this.watchers.has(dir)) {
      return;
    }

    // Ensure directory exists
    try {
      await fsPromises.mkdir(dir, { recursive: true });
    } catch (error) {
      logger.error({ err: error, dir }, 'Failed to create watch directory');
      return;
    }

    try {
      // Collect task IDs that watch this directory
      const taskIds = new Set<string>();
      for (const [taskId, watchDir] of this.taskWatchDirs) {
        if (watchDir === dir) {
          taskIds.add(taskId);
        }
      }

      const watcher = fs.watch(
        dir,
        { persistent: true, recursive: false },
        (eventType, filename) => {
          this.handleFileEvent(dir, eventType, filename);
        }
      );

      watcher.on('error', (error) => {
        logger.error({ err: error, dir }, 'File watcher error');
      });

      this.watchers.set(dir, { watcher, taskIds });

      logger.info({ dir, taskCount: taskIds.size }, 'Started watching directory');
    } catch (error) {
      logger.error({ err: error, dir }, 'Failed to start watcher for directory');
    }
  }

  /**
   * Handle a file system event from a watcher.
   *
   * Debounces triggers per task to avoid rapid re-execution.
   *
   * @param dir - The directory where the event occurred
   * @param eventType - 'rename' or 'change'
   * @param filename - Name of the affected file
   */
  private handleFileEvent(dir: string, eventType: string, filename: string | null): void {
    if (!filename) {
      return;
    }

    logger.debug({ dir, eventType, filename }, 'File event received');

    // Find all tasks watching this directory
    const entry = this.watchers.get(dir);
    if (!entry) {
      return;
    }

    for (const taskId of entry.taskIds) {
      this.scheduleTrigger(taskId);
    }
  }

  /**
   * Schedule a debounced trigger for a task.
   *
   * If a trigger is already pending for this task, it is reset.
   *
   * @param taskId - The task ID to trigger
   */
  private scheduleTrigger(taskId: string): void {
    // Clear existing timer
    const existingTimer = this.debounceTimers.get(taskId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const debounceMs = this.taskDebounceMs.get(taskId) ?? DEFAULT_DEBOUNCE_MS;

    const timer = setTimeout(() => {
      this.debounceTimers.delete(taskId);
      void this.executeTrigger(taskId);
    }, debounceMs);

    this.debounceTimers.set(taskId, timer);
  }

  /**
   * Execute the trigger callback for a task.
   *
   * @param taskId - The task ID to trigger
   */
  private async executeTrigger(taskId: string): Promise<void> {
    try {
      const triggered = await this.onTrigger(taskId);
      if (triggered) {
        logger.info({ taskId }, 'Event-triggered task executed');
      } else {
        logger.debug({ taskId }, 'Event trigger skipped (task not active)');
      }
    } catch (error) {
      logger.error({ err: error, taskId }, 'Event trigger execution failed');
    }
  }
}
