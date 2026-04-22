/**
 * Event Trigger - Watches file system paths and triggers schedule execution.
 *
 * When a schedule defines a `trigger` configuration with watch rules,
 * this module sets up file watchers on the specified paths. File changes
 * trigger immediate schedule execution (debounced), complementing cron.
 *
 * Architecture:
 * ```
 * Schedule (with trigger.watch)
 *   ↓
 * EventTriggerManager
 *   ├── Creates fs.watch for each watch rule path
 *   ├── Debounces events per path
 *   └── Calls Scheduler.triggerTask(taskId) on change
 * ```
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduledTask, TriggerConfig } from './scheduled-task.js';

const logger = createLogger('EventTrigger');

/**
 * Callback to trigger a schedule task.
 */
export type TriggerCallback = (taskId: string) => void;

/**
 * Active watcher for a specific path.
 */
interface PathWatcher {
  /** The fs.FSWatcher instance */
  watcher: fs.FSWatcher;
  /** Debounce timer */
  debounceTimer: NodeJS.Timeout | null;
  /** Debounce interval in ms */
  debounceMs: number;
  /** Set of task IDs triggered by this watcher */
  taskIds: Set<string>;
}

/**
 * EventTriggerManager options.
 */
export interface EventTriggerManagerOptions {
  /** Root directory for resolving relative watch paths */
  workspaceDir: string;
  /** Callback to invoke when a trigger fires */
  onTrigger: TriggerCallback;
}

/**
 * EventTriggerManager - Manages file watchers for event-driven schedule triggers.
 *
 * This class:
 * 1. Accepts tasks with trigger configurations
 * 2. Sets up fs.watch on each unique watch path
 * 3. Debounces rapid file changes
 * 4. Invokes the trigger callback when changes are detected
 *
 * Usage:
 * ```typescript
 * const manager = new EventTriggerManager({
 *   workspaceDir: '/path/to/workspace',
 *   onTrigger: (taskId) => scheduler.triggerTask(taskId),
 * });
 *
 * // Register tasks with trigger configs
 * manager.registerTask(task);
 *
 * // Start watching
 * await manager.start();
 *
 * // Stop watching
 * manager.stop();
 * ```
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 */
export class EventTriggerManager {
  private workspaceDir: string;
  private onTrigger: TriggerCallback;
  /** Map of absolute watch path → PathWatcher */
  private watchers: Map<string, PathWatcher> = new Map();
  /** Map of taskId → TriggerConfig for quick lookup */
  private taskTriggers: Map<string, TriggerConfig> = new Map();
  private running = false;

  constructor(options: EventTriggerManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.onTrigger = options.onTrigger;
    logger.info({ workspaceDir: this.workspaceDir }, 'EventTriggerManager initialized');
  }

  /**
   * Start the manager.
   * Sets up watchers for all registered tasks.
   */
  start(): void {
    if (this.running) {
      logger.warn('EventTriggerManager already running');
      return;
    }

    this.running = true;

    // Set up watchers for all registered tasks
    for (const [taskId, trigger] of this.taskTriggers) {
      this.setupWatchersForTask(taskId, trigger);
    }

    logger.info({ watcherCount: this.watchers.size }, 'EventTriggerManager started');
  }

  /**
   * Stop the manager.
   * Closes all file watchers and clears timers.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;

    for (const [watchPath, pw] of this.watchers) {
      if (pw.debounceTimer) {
        clearTimeout(pw.debounceTimer);
      }
      pw.watcher.close();
      logger.debug({ watchPath }, 'Closed file watcher');
    }

    this.watchers.clear();
    logger.info('EventTriggerManager stopped');
  }

  /**
   * Check if the manager is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Register a task with its trigger configuration.
   * If the task has no trigger config, this is a no-op.
   * If already registered, re-registers (updates watchers).
   */
  registerTask(task: ScheduledTask): void {
    if (!task.trigger || !task.trigger.watch || task.trigger.watch.length === 0) {
      // No trigger config - remove if previously registered
      this.unregisterTask(task.id);
      return;
    }

    const hadPrevious = this.taskTriggers.has(task.id);

    // Remove old watchers for this task
    if (hadPrevious) {
      this.removeTaskFromWatchers(task.id);
    }

    // Store trigger config
    this.taskTriggers.set(task.id, task.trigger);

    // If already running, set up watchers immediately
    if (this.running) {
      this.setupWatchersForTask(task.id, task.trigger);
    }

    logger.info(
      { taskId: task.id, watchRules: task.trigger.watch.length },
      hadPrevious ? 'Updated event trigger for task' : 'Registered event trigger for task'
    );
  }

  /**
   * Unregister a task. Removes it from all watchers.
   * If a watcher has no more tasks, it is closed.
   */
  unregisterTask(taskId: string): void {
    if (!this.taskTriggers.has(taskId)) {
      return;
    }

    this.taskTriggers.delete(taskId);
    this.removeTaskFromWatchers(taskId);

    logger.info({ taskId }, 'Unregistered event trigger for task');
  }

  /**
   * Get the number of active watchers.
   */
  getWatcherCount(): number {
    return this.watchers.size;
  }

  /**
   * Get the number of registered tasks with triggers.
   */
  getRegisteredTaskCount(): number {
    return this.taskTriggers.size;
  }

  /**
   * Get all registered task IDs.
   */
  getRegisteredTaskIds(): string[] {
    return Array.from(this.taskTriggers.keys());
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Set up file watchers for a task's trigger configuration.
   */
  private setupWatchersForTask(taskId: string, trigger: TriggerConfig): void {
    for (const rule of trigger.watch) {
      const absolutePath = this.resolveWatchPath(rule.path);
      this.addTaskToWatcher(taskId, absolutePath, rule.debounceMs);
    }
  }

  /**
   * Resolve a watch path to an absolute path.
   * Supports glob patterns by extracting directory portion.
   */
  private resolveWatchPath(watchPath: string): string {
    // If already absolute, use as-is
    if (path.isAbsolute(watchPath)) {
      return watchPath;
    }

    // Resolve relative to workspace dir
    return path.resolve(this.workspaceDir, watchPath);
  }

  /**
   * Add a task to a watcher at the given path.
   * Creates the watcher if it doesn't exist.
   */
  private addTaskToWatcher(taskId: string, absolutePath: string, debounceMs?: number): void {
    const effectiveDebounce = debounceMs ?? 5000;

    const pw = this.watchers.get(absolutePath);
    if (pw) {
      // Add task to existing watcher
      pw.taskIds.add(taskId);
      logger.debug({ taskId, watchPath: absolutePath }, 'Added task to existing watcher');
      return;
    }

    // Create new watcher
    try {
      // Ensure directory exists for watching
      const watchDir = this.getWatchDirectory(absolutePath);
      void fsPromises.mkdir(watchDir, { recursive: true });

      const newPw: PathWatcher = {
        watcher: null as unknown as fs.FSWatcher,
        debounceTimer: null,
        debounceMs: effectiveDebounce,
        taskIds: new Set([taskId]),
      };

      const watcher = fs.watch(
        watchDir,
        { persistent: false, recursive: false },
        (eventType, filename) => {
          this.handleFileEvent(absolutePath, eventType, filename, newPw);
        }
      );

      watcher.on('error', (error) => {
        logger.error({ err: error, watchPath: absolutePath }, 'File watcher error');
      });

      newPw.watcher = watcher;

      this.watchers.set(absolutePath, newPw);
      logger.info({ watchPath: absolutePath, taskId }, 'Created file watcher');
    } catch (error) {
      logger.error({ err: error, watchPath: absolutePath }, 'Failed to create file watcher');
    }
  }

  /**
   * Determine the directory to watch from a path.
   * If the path contains glob characters, extract the directory portion.
   * If it's a file path, watch the parent directory.
   */
  private getWatchDirectory(absolutePath: string): string {
    // Check for glob characters
    if (absolutePath.includes('*') || absolutePath.includes('?')) {
      // Find the first segment with a glob character and take everything before it
      const parts = absolutePath.split(path.sep);
      const dirParts: string[] = [];
      for (const part of parts) {
        if (part.includes('*') || part.includes('?')) {
          break;
        }
        dirParts.push(part);
      }
      return dirParts.length > 0 ? dirParts.join(path.sep) : this.workspaceDir;
    }

    // For file paths, check if it's a directory or file
    // We watch the path itself if it's a directory, or its parent if it's a file pattern
    // Since we can't check at setup time (file may not exist), use heuristics:
    // - If path ends with / or has no extension, treat as directory
    // - Otherwise, watch parent directory
    const ext = path.extname(absolutePath);
    if (ext === '' || absolutePath.endsWith('/')) {
      return absolutePath;
    }
    return path.dirname(absolutePath);
  }

  /**
   * Handle a file system event from a watcher.
   */
  private handleFileEvent(
    watchPath: string,
    eventType: string,
    filename: string | null,
    pw: PathWatcher
  ): void {
    if (!filename) {
      return;
    }

    // Check if the changed file matches the watch path pattern
    const filePath = path.join(this.getWatchDirectory(watchPath), filename);
    if (!this.matchesWatchPattern(watchPath, filePath)) {
      return;
    }

    logger.debug({ watchPath, eventType, filename }, 'File change detected');

    // Clear existing debounce timer
    if (pw.debounceTimer) {
      clearTimeout(pw.debounceTimer);
    }

    // Set new debounce timer
    pw.debounceTimer = setTimeout(() => {
      pw.debounceTimer = null;
      this.fireTriggers(watchPath, pw);
    }, pw.debounceMs);
  }

  /**
   * Check if a file path matches a watch pattern.
   * Supports basic glob matching (* and ?).
   */
  private matchesWatchPattern(pattern: string, filePath: string): boolean {
    // If no glob characters, match prefix (directory watching)
    if (!pattern.includes('*') && !pattern.includes('?')) {
      return filePath.startsWith(pattern);
    }

    // Simple glob matching
    const regex = globToRegex(pattern);
    return regex.test(filePath);
  }

  /**
   * Fire triggers for all tasks registered on this watcher.
   */
  private fireTriggers(watchPath: string, pw: PathWatcher): void {
    for (const taskId of pw.taskIds) {
      logger.info({ taskId, watchPath }, 'Event trigger fired for task');
      try {
        this.onTrigger(taskId);
      } catch (error) {
        logger.error({ err: error, taskId }, 'Error firing trigger callback');
      }
    }
  }

  /**
   * Remove a task from all watchers.
   * Closes watchers that have no remaining tasks.
   */
  private removeTaskFromWatchers(taskId: string): void {
    for (const [watchPath, pw] of this.watchers) {
      pw.taskIds.delete(taskId);

      // If no more tasks on this watcher, close it
      if (pw.taskIds.size === 0) {
        if (pw.debounceTimer) {
          clearTimeout(pw.debounceTimer);
        }
        pw.watcher.close();
        this.watchers.delete(watchPath);
        logger.debug({ watchPath }, 'Closed unused watcher');
      }
    }
  }
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports * (any characters except /) and ? (single character).
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}
