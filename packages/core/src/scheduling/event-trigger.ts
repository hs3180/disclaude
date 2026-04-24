/**
 * EventTrigger - Watches file paths and triggers schedules on changes.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * This module enables schedules to be triggered by file system changes
 * instead of (or in addition to) cron-based polling. When a file matching
 * a declared `watch` pattern changes, the associated schedule is executed
 * immediately.
 *
 * Architecture:
 * ```
 * Schedule declares watch paths:
 *   watch:
 *     - path: "workspace/chats/*.json"
 *       debounceMs: 5000
 *
 * EventTrigger watches those paths:
 *   File change → debounce → triggerNow(taskId)
 *
 * Cron continues as fallback (reduced frequency recommended).
 * ```
 *
 * Features:
 * - Watches directories declared in schedule frontmatter
 * - Debounces rapid file changes to prevent duplicate triggers
 * - Coexists with cron-based scheduling
 * - Gracefully handles missing directories
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { Scheduler } from './scheduler.js';
import type { ScheduledTask, WatchPath } from './scheduled-task.js';

const logger = createLogger('EventTrigger');

/**
 * Watch entry tracking a single directory and its associated tasks.
 */
interface WatchEntry {
  /** The directory being watched */
  dirPath: string;
  /** Map of task IDs to their watch configuration */
  tasks: Map<string, {
    watchPath: WatchPath;
    task: ScheduledTask;
  }>;
  /** The FSWatcher instance */
  watcher: fs.FSWatcher | null;
  /** Debounce timers per taskId */
  debounceTimers: Map<string, NodeJS.Timeout>;
}

/**
 * EventTrigger options.
 */
export interface EventTriggerOptions {
  /** Scheduler instance to trigger tasks on */
  scheduler: Scheduler;
  /** Base directory for resolving relative watch paths (default: process.cwd()) */
  basePath?: string;
}

/**
 * EventTrigger - Watches file paths declared in schedule frontmatter
 * and triggers immediate schedule execution when files change.
 *
 * Usage:
 * ```typescript
 * const eventTrigger = new EventTrigger({
 *   scheduler,
 *   basePath: '/app/workspace',
 * });
 *
 * // Register tasks with watch paths
 * eventTrigger.registerTask(task);
 *
 * // Start watching
 * await eventTrigger.start();
 * ```
 */
export class EventTrigger {
  private scheduler: Scheduler;
  private basePath: string;
  private watchEntries: Map<string, WatchEntry> = new Map();
  private running = false;

  constructor(options: EventTriggerOptions) {
    this.scheduler = options.scheduler;
    this.basePath = options.basePath ?? process.cwd();
    logger.info({ basePath: this.basePath }, 'EventTrigger initialized');
  }

  /**
   * Register a task for event-driven triggering.
   * Only tasks with `watch` paths are registered.
   *
   * @param task - The scheduled task to register
   */
  registerTask(task: ScheduledTask): void {
    if (!task.watch || task.watch.length === 0) {
      return;
    }

    for (const watchPath of task.watch) {
      const resolvedDir = this.resolveWatchDir(watchPath.path);

      let entry = this.watchEntries.get(resolvedDir);
      if (!entry) {
        entry = {
          dirPath: resolvedDir,
          tasks: new Map(),
          watcher: null,
          debounceTimers: new Map(),
        };
        this.watchEntries.set(resolvedDir, entry);
      }

      entry.tasks.set(task.id, { watchPath, task });
      logger.info(
        { taskId: task.id, name: task.name, watchPath: watchPath.path, resolvedDir },
        'Registered task for event-triggered execution'
      );
    }
  }

  /**
   * Unregister a task from event-driven triggering.
   *
   * @param taskId - Task ID to unregister
   */
  unregisterTask(taskId: string): void {
    for (const [, entry] of this.watchEntries) {
      if (entry.tasks.has(taskId)) {
        entry.tasks.delete(taskId);

        // Clean up debounce timer
        const timer = entry.debounceTimers.get(taskId);
        if (timer) {
          clearTimeout(timer);
          entry.debounceTimers.delete(taskId);
        }

        // Remove empty watch entries
        if (entry.tasks.size === 0) {
          if (entry.watcher) {
            entry.watcher.close();
          }
          this.watchEntries.delete(dirPath);
        }

        logger.info({ taskId, dirPath }, 'Unregistered task from event triggering');
      }
    }
  }

  /**
   * Start watching all registered directories.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('EventTrigger already running');
      return;
    }

    this.running = true;

    for (const [, entry] of this.watchEntries) {
      await this.startWatching(entry);
    }

    logger.info({ watchCount: this.watchEntries.size }, 'EventTrigger started');
  }

  /**
   * Stop watching all directories.
   */
  stop(): void {
    for (const entry of this.watchEntries.values()) {
      if (entry.watcher) {
        entry.watcher.close();
        entry.watcher = null;
      }
      for (const timer of entry.debounceTimers.values()) {
        clearTimeout(timer);
      }
      entry.debounceTimers.clear();
    }

    this.running = false;
    logger.info('EventTrigger stopped');
  }

  /**
   * Check if EventTrigger is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of watched directories.
   */
  getWatchCount(): number {
    return this.watchEntries.size;
  }

  /**
   * Get all registered task IDs.
   */
  getRegisteredTaskIds(): string[] {
    const taskIds = new Set<string>();
    for (const entry of this.watchEntries.values()) {
      for (const taskId of entry.tasks.keys()) {
        taskIds.add(taskId);
      }
    }
    return Array.from(taskIds);
  }

  /**
   * Resolve a watch path to a directory path.
   * Handles glob patterns by extracting the directory portion.
   */
  private resolveWatchDir(watchPath: string): string {
    // Remove glob patterns to get the directory
    let dirPath = watchPath;

    // Strip glob patterns: *.json, **/*.json, etc.
    const globIndex = dirPath.indexOf('*');
    if (globIndex !== -1) {
      dirPath = dirPath.substring(0, globIndex);
    }

    // Strip filename (keep directory)
    const lastSlash = Math.max(dirPath.lastIndexOf('/'), dirPath.lastIndexOf('\\'));
    if (lastSlash !== -1) {
      dirPath = dirPath.substring(0, lastSlash);
    }

    // Resolve relative to basePath
    if (!path.isAbsolute(dirPath)) {
      dirPath = path.resolve(this.basePath, dirPath);
    }

    return dirPath;
  }

  /**
   * Start watching a single directory.
   */
  private async startWatching(entry: WatchEntry): Promise<void> {
    try {
      // Ensure directory exists
      await fsPromises.mkdir(entry.dirPath, { recursive: true });

      entry.watcher = fs.watch(
        entry.dirPath,
        { persistent: true, recursive: false },
        (eventType, filename) => {
          this.handleFileEvent(entry, eventType, filename);
        }
      );

      entry.watcher.on('error', (error) => {
        logger.error({ err: error, dirPath: entry.dirPath }, 'EventTrigger watcher error');
      });

      logger.info({ dirPath: entry.dirPath, taskCount: entry.tasks.size }, 'Started watching directory');
    } catch (error) {
      logger.error({ err: error, dirPath: entry.dirPath }, 'Failed to start watching directory');
    }
  }

  /**
   * Handle a file system event from a watcher.
   */
  private handleFileEvent(entry: WatchEntry, eventType: string, filename: string | null): void {
    if (!filename) {
      return;
    }

    logger.debug({ eventType, filename, dirPath: entry.dirPath }, 'File event received');

    // Check each registered task to see if the file matches its pattern
    for (const [taskId, { watchPath, task }] of entry.tasks) {
      if (this.matchesPattern(watchPath.path, filename)) {
        const debounceMs = watchPath.debounceMs ?? 1000;

        // Clear existing timer
        const existingTimer = entry.debounceTimers.get(taskId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        // Set new debounced trigger
        const timer = setTimeout(() => {
          entry.debounceTimers.delete(taskId);
          logger.info(
            { taskId, name: task.name, filename, eventType },
            'EventTrigger: triggering task due to file change'
          );
          void this.scheduler.triggerNow(taskId);
        }, debounceMs);

        entry.debounceTimers.set(taskId, timer);
      }
    }
  }

  /**
   * Check if a filename matches a watch pattern.
   */
  private matchesPattern(pattern: string, filename: string): boolean {
    // Extract the glob portion from the pattern
    const patternBase = path.basename(pattern);

    if (patternBase.includes('*')) {
      // Simple glob matching: *.json, *.md, etc.
      const regex = new RegExp(
        `^${  patternBase.replace(/\./g, '\\.').replace(/\*/g, '.*')  }$`
      );
      return regex.test(filename);
    }

    // Exact match
    return patternBase === filename;
  }
}
