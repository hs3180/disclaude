/**
 * EventTriggerWatcher - Watches file paths for changes and triggers schedule execution.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Complements cron-based scheduling by allowing schedules to declare watch triggers
 * in their frontmatter. When a watched file changes, the schedule is immediately
 * executed without waiting for the next cron tick.
 *
 * Features:
 * - Glob pattern support for watch paths
 * - Configurable debounce per watch path (default: 5000ms)
 * - Reuses existing fs.watch for file system events
 * - Integrates with Scheduler via triggerTask() method
 * - Graceful cleanup on stop
 *
 * @example
 * Schedule frontmatter with event-driven trigger (see issue #1953 for full YAML):
 *   name: "Temporary Sessions Manager"
 *   cron: "0 &#47;5 * * * *"
 *   watch:
 *     - path: "workspace/temporary-sessions&#47;*.json"
 *       debounce: 5000
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduledTask, WatchTrigger } from './scheduled-task.js';

const logger = createLogger('EventTriggerWatcher');

/**
 * Callback to trigger a schedule execution by task ID.
 * Provided by the Scheduler to allow event-driven execution.
 */
export type TriggerTaskCallback = (taskId: string) => Promise<void>;

/**
 * Options for EventTriggerWatcher.
 */
export interface EventTriggerWatcherOptions {
  /** Workspace root directory (used to resolve relative watch paths) */
  workspaceDir: string;
  /** Callback to trigger a schedule task execution */
  triggerTask: TriggerTaskCallback;
}

/**
 * Active watch entry tracking a watched directory.
 */
interface ActiveWatch {
  /** The original glob pattern */
  pattern: string;
  /** The directory being watched */
  watchDir: string;
  /** The fs.FSWatcher instance */
  watcher: fs.FSWatcher;
  /** Per-task debounce timers keyed by taskId */
  debounceTimers: Map<string, NodeJS.Timeout>;
  /** Debounce interval in ms (from watch config) */
  debounce: number;
}

/**
 * EventTriggerWatcher - Watches file paths for changes and triggers schedule execution.
 *
 * Usage:
 *   const eventWatcher = new EventTriggerWatcher({
 *     workspaceDir: '/app/workspace',
 *     triggerTask: (taskId) => scheduler.triggerTask(taskId),
 *   });
 *   eventWatcher.registerTask(task);
 *   await eventWatcher.start();
 *   eventWatcher.stop();
 */
export class EventTriggerWatcher {
  private workspaceDir: string;
  private triggerTask: TriggerTaskCallback;
  /** Registered tasks with watch triggers, keyed by taskId */
  private registeredTasks: Map<string, ScheduledTask> = new Map();
  /** Active fs.watch entries, keyed by normalized watch directory */
  private activeWatches: Map<string, ActiveWatch> = new Map();
  private running = false;

  constructor(options: EventTriggerWatcherOptions) {
    this.workspaceDir = options.workspaceDir;
    this.triggerTask = options.triggerTask;
    logger.info({ workspaceDir: this.workspaceDir }, 'EventTriggerWatcher initialized');
  }

  /**
   * Register a task with watch triggers.
   * If the task has no `watch` configuration, this is a no-op.
   *
   * @param task - The scheduled task to register
   */
  registerTask(task: ScheduledTask): void {
    if (!task.watch || task.watch.length === 0) {
      return;
    }

    this.registeredTasks.set(task.id, task);
    logger.info(
      { taskId: task.id, name: task.name, watchCount: task.watch.length },
      'Registered task for event-driven triggers'
    );

    // If already running, start watching immediately
    if (this.running) {
      void this.setupWatchForTask(task);
    }
  }

  /**
   * Unregister a task and stop watching its paths.
   *
   * @param taskId - Task ID to unregister
   */
  unregisterTask(taskId: string): void {
    const removed = this.registeredTasks.delete(taskId);
    if (removed) {
      logger.info({ taskId }, 'Unregistered task from event-driven triggers');
    }
  }

  /**
   * Start all watch triggers for registered tasks.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('EventTriggerWatcher already running');
      return;
    }

    this.running = true;

    for (const task of this.registeredTasks.values()) {
      await this.setupWatchForTask(task);
    }

    logger.info(
      { taskCount: this.registeredTasks.size, watchCount: this.activeWatches.size },
      'EventTriggerWatcher started'
    );
  }

  /**
   * Stop all watch triggers.
   */
  stop(): void {
    for (const watch of this.activeWatches.values()) {
      watch.watcher.close();
      for (const timer of watch.debounceTimers.values()) {
        clearTimeout(timer);
      }
      watch.debounceTimers.clear();
    }

    this.activeWatches.clear();
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
   * Get the number of active watches.
   */
  getWatchCount(): number {
    return this.activeWatches.size;
  }

  /**
   * Set up file watching for a task's watch triggers.
   */
  private async setupWatchForTask(task: ScheduledTask): Promise<void> {
    if (!task.watch) return;

    for (const watchConfig of task.watch) {
      await this.setupSingleWatch(task, watchConfig);
    }
  }

  /**
   * Set up a single watch trigger.
   *
   * Resolves glob patterns to determine the base directory to watch,
   * then uses fs.watch to detect changes.
   */
  private async setupSingleWatch(task: ScheduledTask, watchConfig: WatchTrigger): Promise<void> {
    const resolvedPattern = path.resolve(this.workspaceDir, watchConfig.path);
    const debounce = watchConfig.debounce ?? 5000;

    // Determine the directory to watch and the file glob
    // For patterns like "workspace/temporary-sessions/*.json",
    // we watch the directory "workspace/temporary-sessions/"
    const watchDir = this.getWatchDirectory(resolvedPattern);
    const fileGlob = this.getFileGlob(resolvedPattern, watchDir);

    try {
      // Ensure directory exists
      await fsPromises.mkdir(watchDir, { recursive: true });

      // Check if we already have a watcher for this directory
      const existingWatch = this.activeWatches.get(watchDir);
      if (existingWatch) {
        logger.debug(
          { taskId: task.id, watchDir },
          'Reusing existing watcher for directory'
        );
        return;
      }

      // Create the watcher
      const watcher = fs.watch(watchDir, { persistent: true, recursive: false }, (eventType, filename) => {
        if (!filename) return;

        // Check if the changed file matches the glob pattern
        const filePath = path.join(watchDir, filename);
        if (!this.matchesGlob(filePath, fileGlob, watchDir)) {
          return;
        }

        logger.debug(
          { taskId: task.id, eventType, filename, pattern: resolvedPattern },
          'Watch event received'
        );

        this.debouncedTrigger(task.id, debounce, watchDir);
      });

      watcher.on('error', (error) => {
        logger.error({ err: error, watchDir, taskId: task.id }, 'Watch error');
      });

      this.activeWatches.set(watchDir, {
        pattern: resolvedPattern,
        watchDir,
        watcher,
        debounceTimers: new Map(),
        debounce,
      });

      logger.info(
        { taskId: task.id, watchDir, pattern: resolvedPattern, debounce },
        'Started watching path for event-driven triggers'
      );
    } catch (error) {
      logger.error(
        { err: error, taskId: task.id, watchDir, pattern: resolvedPattern },
        'Failed to set up watch trigger'
      );
    }
  }

  /**
   * Extract the directory to watch from a resolved pattern.
   *
   * For "workspace/temporary-sessions/*.json" → "workspace/temporary-sessions"
   * For "workspace/some-dir" → "workspace/some-dir" (watch directory itself)
   */
  private getWatchDirectory(resolvedPattern: string): string {
    // If pattern contains a glob wildcard, watch the parent directory
    const lastSep = resolvedPattern.lastIndexOf(path.sep);
    const basename = resolvedPattern.slice(lastSep + 1);

    if (basename.includes('*') || basename.includes('?') || basename.includes('[')) {
      return resolvedPattern.slice(0, lastSep);
    }

    // If the pattern points to a specific file, watch its parent directory
    return resolvedPattern;
  }

  /**
   * Extract the file glob pattern for matching changed files.
   */
  private getFileGlob(resolvedPattern: string, watchDir: string): string {
    const relative = path.relative(watchDir, resolvedPattern);
    return relative || '*';
  }

  /**
   * Check if a file path matches a glob pattern.
   */
  private matchesGlob(filePath: string, fileGlob: string, watchDir: string): boolean {
    const relativePath = path.relative(watchDir, filePath);

    if (fileGlob === '*') return true;

    // Simple glob matching for common patterns
    // Supports * (any chars) and ? (single char)
    const regexStr = '^' + fileGlob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') + '$';

    try {
      return new RegExp(regexStr).test(relativePath);
    } catch {
      // Fallback: if regex fails, just check if the extension matches
      const ext = path.extname(relativePath);
      const globExt = path.extname(fileGlob);
      return ext === globExt;
    }
  }

  /**
   * Debounce and trigger a task execution.
   * Multiple file changes within the debounce window are coalesced into a single trigger.
   */
  private debouncedTrigger(taskId: string, debounce: number, watchDir: string): void {
    const watch = this.activeWatches.get(watchDir);
    if (!watch) return;

    const existingTimer = watch.debounceTimers.get(taskId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      watch.debounceTimers.delete(taskId);
      logger.info({ taskId, watchDir }, 'Event-driven trigger firing after debounce');

      void this.triggerTask(taskId).catch((error) => {
        logger.error({ err: error, taskId }, 'Event-driven task trigger failed');
      });
    }, debounce);

    watch.debounceTimers.set(taskId, timer);
  }
}
