/**
 * ScheduleTriggerWatcher - Watches arbitrary file paths for event-driven schedule triggers.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * When a schedule declares a `watch` path in its frontmatter, this watcher
 * monitors the specified directory for file changes and immediately triggers
 * the associated schedule task, bypassing the cron timer.
 *
 * ## Architecture
 *
 * ```
 * Schedule markdown file declares:
 *   watch: "workspace/chats/*.json"
 *   watchDebounce: 5000
 *
 * ScheduleTriggerWatcher:
 *   1. Extracts directory + extension from watch path
 *   2. Watches the directory with fs.watch()
 *   3. Filters events by extension
 *   4. Debounces rapid events
 *   5. Calls onTrigger callback → Scheduler.triggerTask()
 * ```
 *
 * ## Watch Path Format
 *
 * - `workspace/chats/*.json` → watch `workspace/chats/` dir, filter `.json` files
 * - `workspace/data/` → watch `workspace/data/` dir, all files
 * - Absolute paths also supported
 *
 * ## Coexistence with Cron
 *
 * The cron schedule serves as a **fallback/redundancy** when watch triggers are used.
 * Events trigger immediate execution, while cron ensures no events are missed.
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduledTask } from './scheduled-task.js';

const logger = createLogger('TriggerWatcher');

/**
 * Parsed watch configuration extracted from a watch path.
 */
interface ParsedWatchPath {
  /** Directory to watch */
  dir: string;
  /** File extension to filter (e.g., '.json'), or undefined to watch all files */
  extension: string | undefined;
}

/**
 * Callback when a watch trigger fires for a task.
 *
 * @param taskId - The ID of the task to trigger
 */
export type OnTriggerCallback = (taskId: string) => void;

/**
 * ScheduleTriggerWatcher options.
 */
export interface ScheduleTriggerWatcherOptions {
  /** Root directory for resolving relative watch paths */
  workspaceDir: string;
  /** Callback when a watch trigger fires */
  onTrigger: OnTriggerCallback;
}

/**
 * Internal state for a single watch entry.
 */
interface WatchEntry {
  /** The task being watched */
  taskId: string;
  /** Parsed watch path */
  parsed: ParsedWatchPath;
  /** Debounce interval in ms */
  debounceMs: number;
  /** The fs.FSWatcher instance */
  watcher: fs.FSWatcher | null;
  /** Active debounce timer */
  debounceTimer: NodeJS.Timeout | null;
}

/**
 * Default debounce interval for watch triggers (1 second).
 */
const DEFAULT_WATCH_DEBOUNCE_MS = 1000;

/**
 * ScheduleTriggerWatcher - Monitors file paths for event-driven schedule triggers.
 *
 * This class:
 * 1. Accepts schedule tasks with `watch` configuration
 * 2. Watches the declared file paths for changes
 * 3. Debounces rapid file change events
 * 4. Triggers the associated schedule task via callback
 *
 * Usage:
 * ```typescript
 * const triggerWatcher = new ScheduleTriggerWatcher({
 *   workspaceDir: '/path/to/workspace',
 *   onTrigger: (taskId) => scheduler.triggerTask(taskId),
 * });
 *
 * // Add a task with watch config
 * triggerWatcher.addWatch(task);
 *
 * // Start watching
 * await triggerWatcher.start();
 *
 * // Clean up
 * triggerWatcher.stop();
 * ```
 */
export class ScheduleTriggerWatcher {
  private workspaceDir: string;
  private onTrigger: OnTriggerCallback;
  private entries: Map<string, WatchEntry> = new Map();
  private running = false;

  constructor(options: ScheduleTriggerWatcherOptions) {
    this.workspaceDir = options.workspaceDir;
    this.onTrigger = options.onTrigger;
    logger.info({ workspaceDir: this.workspaceDir }, 'ScheduleTriggerWatcher initialized');
  }

  /**
   * Start all registered watch entries.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Trigger watcher already running');
      return;
    }

    this.running = true;

    for (const [taskId, entry] of this.entries) {
      await this.startWatchEntry(taskId, entry);
    }

    logger.info({ watchCount: this.entries.size }, 'Trigger watcher started');
  }

  /**
   * Stop all watch entries and clean up resources.
   */
  stop(): void {
    this.running = false;

    for (const [taskId, entry] of this.entries) {
      this.stopWatchEntry(taskId, entry);
    }

    logger.info('Trigger watcher stopped');
  }

  /**
   * Check if the watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Add a watch entry for a task.
   * If the task doesn't have a `watch` field, this is a no-op.
   *
   * @param task - The task to watch
   */
  addWatch(task: ScheduledTask): void {
    // Remove existing watch first
    this.removeWatch(task.id);

    if (!task.watch) {
      return;
    }

    if (!task.enabled) {
      logger.debug({ taskId: task.id }, 'Task is disabled, not watching');
      return;
    }

    const parsed = this.parseWatchPath(task.watch);
    if (!parsed) {
      logger.warn({ taskId: task.id, watch: task.watch }, 'Invalid watch path');
      return;
    }

    const debounceMs = task.watchDebounce ?? DEFAULT_WATCH_DEBOUNCE_MS;

    const entry: WatchEntry = {
      taskId: task.id,
      parsed,
      debounceMs,
      watcher: null,
      debounceTimer: null,
    };

    this.entries.set(task.id, entry);

    // Start watching if already running
    if (this.running) {
      void this.startWatchEntry(task.id, entry);
    }

    logger.info(
      { taskId: task.id, dir: parsed.dir, extension: parsed.extension, debounceMs },
      'Added watch for task'
    );
  }

  /**
   * Remove a watch entry for a task.
   *
   * @param taskId - Task ID to remove watch for
   */
  removeWatch(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (entry) {
      this.stopWatchEntry(taskId, entry);
      this.entries.delete(taskId);
      logger.info({ taskId }, 'Removed watch for task');
    }
  }

  /**
   * Get the number of active watch entries.
   */
  getWatchCount(): number {
    return this.entries.size;
  }

  /**
   * Get the IDs of all watched tasks.
   */
  getWatchedTaskIds(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Parse a watch path into directory and extension filter.
   *
   * Supported formats:
   * - `workspace/chats/*.json` → dir: `workspace/chats`, ext: `.json`
   * - `workspace/data/` → dir: `workspace/data`, ext: undefined
   * - `/absolute/path/*.csv` → dir: `/absolute/path`, ext: `.csv`
   *
   * @param watchPath - The watch path from schedule frontmatter
   * @returns Parsed result or null if invalid
   */
  private parseWatchPath(watchPath: string): ParsedWatchPath | null {
    if (!watchPath || watchPath.trim().length === 0) {
      return null;
    }

    let normalizedPath = watchPath.trim();

    // Handle glob pattern (e.g., *.json)
    const globMatch = normalizedPath.match(/^(.+)\/\*\.(\w+)$/);
    if (globMatch) {
      const dir = this.resolvePath(globMatch[1]);
      return { dir, extension: `.${globMatch[2]}` };
    }

    // Handle trailing slash (directory watch, all files)
    if (normalizedPath.endsWith('/')) {
      const dir = this.resolvePath(normalizedPath.slice(0, -1));
      return { dir, extension: undefined };
    }

    // Handle specific file extension without glob
    // e.g., "workspace/chats/" or "workspace/chats"
    const dir = this.resolvePath(normalizedPath);
    return { dir, extension: undefined };
  }

  /**
   * Resolve a path relative to workspace directory.
   *
   * @param relativePath - Path relative to workspace
   * @returns Absolute path
   */
  private resolvePath(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }
    return path.resolve(this.workspaceDir, relativePath);
  }

  /**
   * Start watching a single entry.
   */
  private async startWatchEntry(taskId: string, entry: WatchEntry): Promise<void> {
    if (entry.watcher) {
      return; // Already watching
    }

    const { dir } = entry.parsed;

    try {
      // Ensure directory exists
      await fsPromises.mkdir(dir, { recursive: true });

      entry.watcher = fs.watch(
        dir,
        { persistent: true, recursive: false },
        (eventType, filename) => {
          this.handleFileEvent(entry, eventType, filename);
        }
      );

      entry.watcher.on('error', (error) => {
        logger.error({ err: error, taskId, dir }, 'Watch error for task');
      });

      logger.debug({ taskId, dir }, 'Started watching for task');
    } catch (error) {
      logger.error({ err: error, taskId, dir }, 'Failed to start watch for task');
    }
  }

  /**
   * Stop watching a single entry.
   */
  private stopWatchEntry(_taskId: string, entry: WatchEntry): void {
    if (entry.watcher) {
      entry.watcher.close();
      entry.watcher = null;
    }

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
  }

  /**
   * Handle a file system event from a watch entry.
   */
  private handleFileEvent(
    entry: WatchEntry,
    eventType: string,
    filename: string | null
  ): void {
    if (!filename) {
      return;
    }

    // Filter by extension if specified
    if (entry.parsed.extension) {
      if (!filename.endsWith(entry.parsed.extension)) {
        return;
      }
    }

    logger.debug(
      { taskId: entry.taskId, eventType, filename },
      'File event for watched task'
    );

    // Debounce: clear existing timer and set a new one
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }

    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      logger.info(
        { taskId: entry.taskId, dir: entry.parsed.dir },
        'Watch trigger firing for task'
      );
      this.onTrigger(entry.taskId);
    }, entry.debounceMs);
  }
}
