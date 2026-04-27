/**
 * Event Trigger Manager - File-watch based event-driven schedule triggers.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Watches specified file paths for changes and triggers schedule execution
 * when files are created, modified, or deleted. Works alongside cron-based
 * scheduling — cron serves as a fallback while file watches provide
 * immediate response to relevant file changes.
 *
 * Architecture:
 * ```
 * Schedule frontmatter:
 *   watch:
 *     - path: "workspace/chats/*.json"
 *       debounce: 5000
 *
 * EventTriggerManager
 *   ├── watches configured paths via fs.watch (recursive for directories)
 *   ├── debounces rapid changes per-task
 *   └── calls triggerCallback(taskId) on file change
 *
 * Scheduler
 *   ├── receives triggerCallback → calls executeTask(task)
 *   └── same flow as cron trigger (cooldown, blocking, etc.)
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduleWatchEntry } from './scheduled-task.js';

const logger = createLogger('EventTriggerManager');

/** Default debounce interval in milliseconds */
const DEFAULT_DEBOUNCE_MS = 2000;

/**
 * Callback invoked when a watched file change triggers a schedule.
 *
 * @param taskId - The ID of the schedule task to execute
 */
export type OnTrigger = (taskId: string) => void;

/**
 * A registered watcher entry tracking state.
 */
interface WatcherEntry {
  /** The original watch config */
  config: ScheduleWatchEntry;
  /** The resolved absolute directory path being watched */
  watchDir: string;
  /** The fs.FSWatcher instance */
  watcher: fs.FSWatcher | null;
  /** Whether this is a glob pattern (needs filename matching) */
  isGlob: boolean;
  /** Glob pattern string for filename matching (e.g., "*.json") */
  globPattern: string;
}

/**
 * EventTriggerManager options.
 */
export interface EventTriggerManagerOptions {
  /** Workspace root directory (for resolving relative paths) */
  workspaceDir: string;
  /** Callback when a trigger fires */
  onTrigger: OnTrigger;
}

/**
 * Simple glob-to-regexp matcher for filename patterns.
 * Handles `*` (match any chars) and `?` (match single char).
 * Does NOT handle `[...]` character classes or `**` recursion.
 *
 * @param pattern - Glob pattern (e.g., "*.json", "chat-*.json")
 * @param filename - Filename to test against the pattern
 * @returns true if the filename matches the pattern
 */
function matchGlob(pattern: string, filename: string): boolean {
  // Escape special regex chars except * and ?
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  try {
    const re = new RegExp(`^${regexStr}$`);
    return re.test(filename);
  } catch {
    return false;
  }
}

/**
 * EventTriggerManager - Manages file watchers for event-driven schedule triggers.
 *
 * Usage:
 * ```typescript
 * const triggerManager = new EventTriggerManager({
 *   workspaceDir: './workspace',
 *   onTrigger: (taskId) => {
 *     scheduler.triggerTask(taskId);
 *   },
 * });
 *
 * // Register watches for a task
 * triggerManager.registerTask('task-1', [
 *   { path: 'workspace/chats/*.json', debounce: 5000 },
 * ]);
 *
 * // Start all watchers
 * await triggerManager.start();
 *
 * // Unregister when task is removed
 * triggerManager.unregisterTask('task-1');
 *
 * // Stop all watchers
 * triggerManager.stop();
 * ```
 */
export class EventTriggerManager {
  private workspaceDir: string;
  private onTrigger: OnTrigger;
  /** taskId → WatcherEntry[] */
  private taskWatchers: Map<string, WatcherEntry[]> = new Map();
  /** Debounce timers: taskId → NodeJS.Timeout */
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  /** All active fs.FSWatcher instances for cleanup */
  private allWatchers: fs.FSWatcher[] = [];
  private running = false;

  constructor(options: EventTriggerManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.onTrigger = options.onTrigger;
    logger.info({ workspaceDir: this.workspaceDir }, 'EventTriggerManager created');
  }

  /**
   * Register file watches for a task.
   *
   * @param taskId - Task ID to register watches for
   * @param watchEntries - Watch configurations from schedule frontmatter
   */
  registerTask(taskId: string, watchEntries: ScheduleWatchEntry[]): void {
    // Clear existing watchers for this task
    this.unregisterTask(taskId);

    if (!watchEntries || watchEntries.length === 0) {
      return;
    }

    const entries: WatcherEntry[] = [];

    for (const config of watchEntries) {
      const entry = this.createWatcherEntry(config);
      if (entry) {
        entries.push(entry);
      }
    }

    if (entries.length > 0) {
      this.taskWatchers.set(taskId, entries);
      logger.info(
        { taskId, watchCount: entries.length },
        'Registered event triggers for task'
      );
    }
  }

  /**
   * Unregister all file watches for a task.
   *
   * @param taskId - Task ID to unregister
   */
  unregisterTask(taskId: string): void {
    const entries = this.taskWatchers.get(taskId);
    if (entries) {
      for (const entry of entries) {
        if (entry.watcher) {
          entry.watcher.close();
          const idx = this.allWatchers.indexOf(entry.watcher);
          if (idx >= 0) {
            this.allWatchers.splice(idx, 1);
          }
        }
      }
      this.taskWatchers.delete(taskId);
      logger.info({ taskId }, 'Unregistered event triggers for task');
    }

    // Clear debounce timer
    const timer = this.debounceTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(taskId);
    }
  }

  /**
   * Start all registered file watchers.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('EventTriggerManager already running');
      return;
    }

    this.running = true;

    for (const [taskId, entries] of this.taskWatchers) {
      for (const entry of entries) {
        await this.startWatcher(taskId, entry);
      }
    }

    const totalWatchers = this.allWatchers.length;
    logger.info(
      { totalWatchers, tasksWatched: this.taskWatchers.size },
      'EventTriggerManager started'
    );
  }

  /**
   * Stop all file watchers.
   */
  stop(): void {
    for (const watcher of this.allWatchers) {
      watcher.close();
    }
    this.allWatchers = [];

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
   * Get the number of tasks with active event triggers.
   */
  getWatchedTaskCount(): number {
    return this.taskWatchers.size;
  }

  /**
   * Create a watcher entry from a watch config.
   */
  private createWatcherEntry(config: ScheduleWatchEntry): WatcherEntry | null {
    const rawPath = config.path;

    // Resolve relative paths against workspaceDir
    const resolvedPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(this.workspaceDir, rawPath);

    // Check if it's a glob pattern (contains wildcard chars in the basename)
    const baseName = path.basename(resolvedPath);
    const isGlob = baseName.includes('*') || baseName.includes('?') || baseName.includes('[');

    // The directory to watch is always the parent of the path
    const watchDir = isGlob
      ? path.dirname(resolvedPath)
      : resolvedPath;

    return {
      config,
      watchDir,
      watcher: null,
      isGlob,
      globPattern: isGlob ? baseName : '',
    };
  }

  /**
   * Start a single file watcher.
   */
  private async startWatcher(taskId: string, entry: WatcherEntry): Promise<void> {
    try {
      // Ensure the directory exists
      await fsPromises.mkdir(entry.watchDir, { recursive: true });

      const watcher = fs.watch(
        entry.watchDir,
        { persistent: true, recursive: false },
        (eventType, filename) => {
          this.handleFileEvent(taskId, entry, eventType, filename);
        }
      );

      watcher.on('error', (error) => {
        logger.error(
          { err: error, taskId, watchDir: entry.watchDir },
          'Event trigger watcher error'
        );
      });

      entry.watcher = watcher;
      this.allWatchers.push(watcher);

      logger.debug(
        { taskId, watchDir: entry.watchDir, isGlob: entry.isGlob },
        'Started file watcher for event trigger'
      );
    } catch (error) {
      logger.error(
        { err: error, taskId, watchDir: entry.watchDir },
        'Failed to start file watcher for event trigger'
      );
    }
  }

  /**
   * Handle a file system event with debouncing and optional glob matching.
   */
  private handleFileEvent(
    taskId: string,
    entry: WatcherEntry,
    _eventType: string,
    filename: string | null
  ): void {
    if (!filename) {
      return;
    }

    // For glob patterns, check if the changed file matches
    if (entry.isGlob) {
      if (!matchGlob(entry.globPattern, filename)) {
        return;
      }
    }

    logger.debug(
      { taskId, filename, watchDir: entry.watchDir },
      'File change detected for event trigger'
    );

    // Debounce: use the debounce from the entry config or default
    const debounceMs = entry.config.debounce ?? DEFAULT_DEBOUNCE_MS;
    this.debouncedTrigger(taskId, debounceMs);
  }

  /**
   * Trigger a task with debouncing.
   */
  private debouncedTrigger(taskId: string, debounceMs: number): void {
    const existingTimer = this.debounceTimers.get(taskId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(taskId);
      logger.info({ taskId }, 'Event trigger fired for schedule task');
      this.onTrigger(taskId);
    }, debounceMs);

    this.debounceTimers.set(taskId, timer);
  }
}
