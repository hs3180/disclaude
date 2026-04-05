/**
 * EventTriggerWatcher - Watches file paths and triggers schedule execution.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * This module provides file-system-based event triggering for scheduled tasks.
 * When a schedule declares `watch` configuration in its frontmatter, this watcher
 * monitors the specified directories and triggers the schedule immediately upon
 * file changes, complementing the existing cron-based polling.
 *
 * Architecture:
 * ```
 * Schedule frontmatter declares watch config:
 *   watch:
 *     - path: "workspace/chats"
 *       pattern: "*.json"
 *       debounce: 5000
 *
 * EventTriggerWatcher monitors declared paths:
 *   File change detected -> debounce -> Scheduler.triggerTask(taskId)
 * ```
 *
 * Design decisions:
 * - Uses Node.js `fs.watch` for native file system events (no extra dependencies)
 * - Debouncing prevents rapid re-triggering from burst file operations
 * - Glob pattern matching filters irrelevant files
 * - Watches are per-task; each watch entry maps to exactly one task
 * - Missing directories are handled gracefully (logged, skipped)
 * - Respects Scheduler's existing blocking/cooldown mechanisms
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { Scheduler } from './scheduler.js';
import type { ScheduledTask, WatchConfig } from './scheduled-task.js';

/**
 * Simple glob pattern matcher.
 * Supports: * (any chars), ? (single char), and literal characters.
 * Sufficient for common patterns like "*.json", "*.log", etc.
 *
 * @param filename - The filename to test
 * @param pattern - The glob pattern to match against
 * @returns true if the filename matches the pattern
 */
function simpleGlobMatch(filename: string, pattern: string): boolean {
  // Fast path: exact match or simple extension match
  if (pattern === '*') return true;
  if (pattern === filename) return true;

  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape regex special chars (except * and ?)
    .replace(/\*/g, '.*')                     // * matches any chars
    .replace(/\?/g, '.');                     // ? matches single char

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filename);
}

const logger = createLogger('EventTriggerWatcher');

/**
 * Default debounce interval for file change events (5 seconds).
 */
const DEFAULT_DEBOUNCE_MS = 5000;

/**
 * Default glob pattern for file matching (all files).
 */
const DEFAULT_PATTERN = '*';

/**
 * An active file watcher entry.
 */
interface WatcherEntry {
  /** The fs.FSWatcher instance */
  watcher: fs.FSWatcher;
  /** The task being watched for */
  task: ScheduledTask;
  /** The watch configuration that created this entry */
  config: WatchConfig;
  /** Resolved absolute path being watched */
  resolvedPath: string;
}

/**
 * EventTriggerWatcher options.
 */
export interface EventTriggerWatcherOptions {
  /** Scheduler instance to trigger tasks on */
  scheduler: Scheduler;
  /** Workspace root directory (for resolving relative paths) */
  workspaceDir: string;
}

/**
 * EventTriggerWatcher - Monitors file system paths and triggers schedule execution.
 *
 * Issue #1953: Complements cron-based scheduling with event-driven triggers.
 *
 * Usage:
 * ```typescript
 * const eventWatcher = new EventTriggerWatcher({
 *   scheduler: myScheduler,
 *   workspaceDir: '/path/to/workspace',
 * });
 *
 * // Register watches for a task (typically from schedule frontmatter)
 * eventWatcher.registerTask(task);
 *
 * // Start all registered watchers
 * await eventWatcher.start();
 *
 * // Later: unregister a task's watches
 * eventWatcher.unregisterTask('task-id');
 *
 * // Stop all watchers
 * eventWatcher.stop();
 * ```
 */
export class EventTriggerWatcher {
  private scheduler: Scheduler;
  private workspaceDir: string;
  private entries: Map<string, WatcherEntry> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  constructor(options: EventTriggerWatcherOptions) {
    this.scheduler = options.scheduler;
    this.workspaceDir = options.workspaceDir;
    logger.info({ workspaceDir: this.workspaceDir }, 'EventTriggerWatcher created');
  }

  /**
   * Register file watches for a task.
   *
   * Parses the task's `watch` configuration and sets up file system
   * watchers for each declared path. If the task has no `watch` config,
   * this is a no-op.
   *
   * @param task - Task with optional watch configuration
   */
  registerTask(task: ScheduledTask): void {
    if (!task.watch || task.watch.length === 0) {
      return;
    }

    // Remove all existing watches for this task before re-registering
    this.unregisterTask(task.id);

    for (const config of task.watch) {
      const watchKey = this.getWatchKey(task.id, config.path);
      // Remove existing watcher for this key if any
      this.removeWatcherEntry(watchKey);

      const resolvedPath = this.resolveWatchPath(config.path);
      const entry: WatcherEntry = {
        watcher: null as unknown as fs.FSWatcher, // Placeholder; real watcher created in start()
        task,
        config,
        resolvedPath,
      };
      this.entries.set(watchKey, entry);

      logger.info(
        { taskId: task.id, path: config.path, resolvedPath, pattern: config.pattern ?? DEFAULT_PATTERN },
        'Registered watch config for task'
      );
    }
  }

  /**
   * Unregister all file watches for a task.
   *
   * @param taskId - Task ID to unregister watches for
   */
  unregisterTask(taskId: string): void {
    const keysToRemove: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.task.id === taskId) {
        this.removeWatcherEntry(key);
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      this.entries.delete(key);
    }

    if (keysToRemove.length > 0) {
      logger.info({ taskId, count: keysToRemove.length }, 'Unregistered watches for task');
    }
  }

  /**
   * Start all registered file watchers.
   *
   * Creates fs.watch instances for each registered watch entry.
   * If a watched directory does not exist, it logs a warning and skips.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('EventTriggerWatcher already running');
      return;
    }

    let startedCount = 0;

    for (const [, entry] of this.entries) {
      try {
        // Ensure directory exists
        await fsPromises.mkdir(entry.resolvedPath, { recursive: true });

        const watcher = fs.watch(
          entry.resolvedPath,
          { persistent: true, recursive: false },
          (_eventType, filename) => {
            this.handleFileEvent(entry, filename);
          }
        );

        watcher.on('error', (error) => {
          logger.error(
            { err: error, taskId: entry.task.id, path: entry.resolvedPath },
            'File watcher error'
          );
        });

        // Update entry with real watcher
        entry.watcher = watcher;
        startedCount++;
      } catch (error) {
        logger.warn(
          { err: error, taskId: entry.task.id, path: entry.resolvedPath },
          'Failed to start file watcher, skipping'
        );
      }
    }

    this.running = true;
    logger.info(
      { totalEntries: this.entries.size, started: startedCount },
      'EventTriggerWatcher started'
    );
  }

  /**
   * Stop all file watchers and clear debounce timers.
   */
  stop(): void {
    for (const [key] of this.entries) {
      this.removeWatcherEntry(key);
    }
    this.entries.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.running = false;
    logger.info('EventTriggerWatcher stopped');
  }

  /**
   * Check if the watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of active watch entries.
   */
  getWatchCount(): number {
    return this.entries.size;
  }

  /**
   * Handle a file system event with pattern matching and debouncing.
   */
  private handleFileEvent(entry: WatcherEntry, filename: string | null): void {
    if (!filename) {
      return;
    }

    const pattern = entry.config.pattern ?? DEFAULT_PATTERN;

    // Check if the filename matches the glob pattern
    if (!simpleGlobMatch(filename, pattern)) {
      logger.debug(
        { filename, pattern, taskId: entry.task.id },
        'File event skipped: pattern mismatch'
      );
      return;
    }

    const debounceMs = entry.config.debounce ?? DEFAULT_DEBOUNCE_MS;
    const watchKey = this.getWatchKey(entry.task.id, entry.config.path);

    logger.debug(
      { filename, taskId: entry.task.id, debounceMs },
      'File event matched, debouncing'
    );

    // Clear existing debounce timer
    const existingTimer = this.debounceTimers.get(watchKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(watchKey);
      this.triggerSchedule(entry);
    }, debounceMs);

    this.debounceTimers.set(watchKey, timer);
  }

  /**
   * Trigger schedule execution for a watcher entry.
   */
  private triggerSchedule(entry: WatcherEntry): void {
    logger.info(
      { taskId: entry.task.id, name: entry.task.name, path: entry.resolvedPath },
      'Event-triggering schedule execution'
    );

    const triggered = this.scheduler.triggerTask(entry.task.id);
    if (!triggered) {
      logger.warn(
        { taskId: entry.task.id },
        'Failed to trigger task: not found in scheduler active jobs'
      );
    }
  }

  /**
   * Remove a watcher entry and close its fs.FSWatcher.
   */
  private removeWatcherEntry(watchKey: string): void {
    const entry = this.entries.get(watchKey);
    if (entry?.watcher) {
      try {
        entry.watcher.close();
      } catch {
        // Ignore errors when closing watcher
      }
    }

    // Clear debounce timer for this key
    const timer = this.debounceTimers.get(watchKey);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(watchKey);
    }
  }

  /**
   * Generate a unique key for a watch entry.
   */
  private getWatchKey(taskId: string, watchPath: string): string {
    return `${taskId}:${watchPath}`;
  }

  /**
   * Resolve a watch path to an absolute path.
   * If the path is relative, it's resolved relative to the workspace directory.
   */
  private resolveWatchPath(watchPath: string): string {
    if (path.isAbsolute(watchPath)) {
      return watchPath;
    }
    return path.resolve(this.workspaceDir, watchPath);
  }
}
