/**
 * EventTrigger - Watches file paths and triggers schedule execution on change.
 *
 * Implements Method A (File Watcher) from Issue #1953.
 * Watches specified directories/files and calls a callback when changes occur.
 *
 * Features:
 * - File system watching via fs.watch
 * - Configurable debounce to avoid rapid re-triggering
 * - Glob pattern support for watch paths (directory-level watching)
 * - Graceful error handling (falls back to cron on watch failure)
 *
 * Architecture:
 * ```
 * fs.watch (directory)
 *     ↓
 * debounce timer
 *     ↓
 * onTrigger callback → Scheduler.triggerNow(taskId)
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('EventTrigger');

/**
 * Callback when an event trigger fires.
 *
 * @param taskId - The task ID to trigger
 */
export type OnTriggerCallback = (taskId: string) => void;

/**
 * EventTrigger options.
 */
export interface EventTriggerOptions {
  /** Task ID this trigger is associated with */
  taskId: string;
  /** Directory path(s) to watch */
  watchPaths: string[];
  /** Debounce interval in milliseconds (default: 5000) */
  debounce?: number;
  /** Callback when trigger fires */
  onTrigger: OnTriggerCallback;
}

/**
 * Resolved watch entry with its fs.FSWatcher.
 */
interface ActiveWatch {
  /** The directory being watched */
  dirPath: string;
  /** The fs.FSWatcher instance */
  watcher: fs.FSWatcher;
}

/**
 * EventTrigger - Watches file paths and triggers schedule execution on change.
 *
 * Usage:
 * ```typescript
 * const trigger = new EventTrigger({
 *   taskId: 'schedule-chats-activation',
 *   watchPaths: ['./workspace/chats'],
 *   debounce: 5000,
 *   onTrigger: (taskId) => scheduler.triggerNow(taskId),
 * });
 *
 * await trigger.start();
 * // ... later
 * trigger.stop();
 * ```
 */
export class EventTrigger {
  private taskId: string;
  private watchPaths: string[];
  private debounceMs: number;
  private onTrigger: OnTriggerCallback;
  private activeWatches: ActiveWatch[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: EventTriggerOptions) {
    this.taskId = options.taskId;
    this.watchPaths = options.watchPaths;
    this.debounceMs = options.debounce ?? 5000;
    this.onTrigger = options.onTrigger;
    logger.info(
      { taskId: this.taskId, watchPaths: this.watchPaths, debounce: this.debounceMs },
      'EventTrigger created',
    );
  }

  /**
   * Start watching the configured paths.
   * Creates one fs.FSWatcher per unique directory.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn({ taskId: this.taskId }, 'EventTrigger already running');
      return;
    }

    // Resolve watch paths to directories
    const dirsToWatch = new Set<string>();
    for (const watchPath of this.watchPaths) {
      // Resolve glob-like patterns to their parent directory
      const dirPath = this.resolveDirectory(watchPath);
      if (dirPath) {
        dirsToWatch.add(dirPath);
      }
    }

    if (dirsToWatch.size === 0) {
      logger.warn({ taskId: this.taskId, watchPaths: this.watchPaths }, 'No valid directories to watch');
      return;
    }

    for (const dirPath of dirsToWatch) {
      try {
        // Ensure directory exists before watching
        await fsPromises.mkdir(dirPath, { recursive: true });

        const watcher = fs.watch(
          dirPath,
          { persistent: true, recursive: false },
          (eventType, filename) => {
            this.handleFileEvent(eventType, filename);
          },
        );

        watcher.on('error', (error) => {
          logger.error(
            { err: error, taskId: this.taskId, dirPath },
            'EventTrigger watch error',
          );
        });

        this.activeWatches.push({ dirPath, watcher });
        logger.info({ taskId: this.taskId, dirPath }, 'EventTrigger started watching');
      } catch (error) {
        logger.error(
          { err: error, taskId: this.taskId, dirPath },
          'Failed to start watching directory',
        );
        // Continue with other directories — don't fail entirely
      }
    }

    this.running = this.activeWatches.length > 0;
    if (this.running) {
      logger.info(
        { taskId: this.taskId, watchCount: this.activeWatches.length },
        'EventTrigger started',
      );
    }
  }

  /**
   * Stop watching and clean up resources.
   */
  stop(): void {
    // Clear debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Close all watchers
    for (const { dirPath, watcher } of this.activeWatches) {
      watcher.close();
      logger.debug({ taskId: this.taskId, dirPath }, 'EventTrigger stopped watching');
    }
    this.activeWatches = [];

    this.running = false;
    logger.info({ taskId: this.taskId }, 'EventTrigger stopped');
  }

  /**
   * Check if the trigger is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Immediately fire the trigger (bypassing debounce).
   * Useful for testing and direct invocation.
   */
  fireNow(): void {
    logger.info({ taskId: this.taskId }, 'EventTrigger manually fired');
    this.onTrigger(this.taskId);
  }

  /**
   * Resolve a watch path to a directory path.
   *
   * Handles:
   * - Plain directory paths: `./workspace/chats` → `./workspace/chats`
   * - Glob patterns: `./workspace/chats/*.json` → `./workspace/chats`
   *
   * @param watchPath - The watch path to resolve
   * @returns The directory path, or null if invalid
   */
  private resolveDirectory(watchPath: string): string | null {
    // Remove glob patterns — we watch the directory and filter by extension
    const cleanPath = watchPath
      .replace(/\/\*\*?\/.*$/, '')   // Remove /**/... or /*... patterns
      .replace(/\/\*+\..*$/, '');     // Remove /*.ext patterns

    if (!cleanPath) {
      return null;
    }

    // Resolve to absolute path
    return path.resolve(cleanPath);
  }

  /**
   * Handle a file system event from fs.watch.
   */
  private handleFileEvent(eventType: string, filename: string | null): void {
    if (!filename) {
      return;
    }

    // Check if the file matches our watch patterns
    if (!this.matchesWatchPatterns(filename)) {
      return;
    }

    logger.debug(
      { taskId: this.taskId, eventType, filename },
      'File change detected',
    );

    // Debounce: reset timer on each event
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      logger.info({ taskId: this.taskId }, 'EventTrigger fired (debounced)');
      this.onTrigger(this.taskId);
    }, this.debounceMs);
  }

  /**
   * Check if a filename matches any of the configured watch patterns.
   *
   * @param filename - The filename (not full path) to check
   * @returns true if the file matches at least one watch pattern
   */
  private matchesWatchPatterns(filename: string): boolean {
    // If any watch path is a bare directory (no glob), match all files
    const hasBareDir = this.watchPaths.some((p) => !p.includes('*'));
    if (hasBareDir) {
      return true;
    }

    // Otherwise, check glob patterns
    for (const pattern of this.watchPaths) {
      if (this.filenameMatchesGlob(filename, pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a filename matches a simple glob pattern.
   * Supports `*.ext` style patterns.
   *
   * @param filename - The filename to check
   * @param pattern - The glob pattern (e.g., `workspace/chats/*.json`)
   * @returns true if the filename matches
   */
  private filenameMatchesGlob(filename: string, pattern: string): boolean {
    // Extract the glob portion (last segment after /)
    const segments = pattern.split('/');
    const lastSegment = segments[segments.length - 1];

    // Simple *.ext matching
    if (lastSegment.startsWith('*.')) {
      const ext = lastSegment.slice(1); // e.g., ".json"
      return filename.endsWith(ext);
    }

    // No glob — match all
    return true;
  }
}
