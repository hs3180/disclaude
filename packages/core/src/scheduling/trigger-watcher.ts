/**
 * TriggerWatcher - Event-driven schedule trigger via file system watching.
 *
 * Issue #1953: Watches data directories declared in schedule `watch` config.
 * When files are created or modified in watched directories, the corresponding
 * schedule is triggered immediately (bypassing cron delay).
 *
 * Architecture:
 * ```
 * Skill writes file to workspace/chats/xxx.json
 *   ↓
 * TriggerWatcher detects change via fs.watch
 *   ↓
 * Debounce timer (5s default) collects rapid changes
 *   ↓
 * scheduler.triggerTask(taskId) called
 *   ↓
 * Schedule executes immediately (respects cooldown/blocking)
 * ```
 *
 * Features:
 * - Per-directory fs.watch with debouncing
 * - Respects Scheduler's existing cooldown and blocking mechanisms
 * - Graceful handling of missing directories
 * - Automatic cleanup on stop
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { Scheduler } from './scheduler.js';
import type { ScheduleManager } from './schedule-manager.js';

const logger = createLogger('TriggerWatcher');

/** Default debounce interval in milliseconds */
const DEFAULT_DEBOUNCE_MS = 5000;

/**
 * TriggerWatcher options.
 */
export interface TriggerWatcherOptions {
  /** Scheduler instance to trigger tasks on */
  scheduler: Scheduler;
  /** ScheduleManager to load watch configurations from */
  scheduleManager: ScheduleManager;
  /** Workspace root directory (for resolving relative watch paths) */
  workspaceDir: string;
  /** Debounce interval in ms (default: 5000) */
  debounceMs?: number;
}

/**
 * A watched directory entry with its fs.FSWatcher and debounce state.
 */
interface WatchedDir {
  /** Absolute path being watched */
  absolutePath: string;
  /** The fs.FSWatcher instance */
  watcher: fs.FSWatcher;
  /** Task IDs that have this directory in their watch config */
  taskIds: Set<string>;
  /** Debounce timer for this directory */
  debounceTimer: NodeJS.Timeout | null;
}

/**
 * TriggerWatcher - Monitors data directories for file changes
 * and triggers corresponding schedules immediately.
 *
 * Usage:
 * ```typescript
 * const watcher = new TriggerWatcher({
 *   scheduler,
 *   scheduleManager,
 *   workspaceDir: './workspace',
 *   debounceMs: 5000,
 * });
 *
 * await watcher.start();
 * // ... file changes in watched dirs trigger schedules ...
 * watcher.stop();
 * ```
 */
export class TriggerWatcher {
  private scheduler: Scheduler;
  private scheduleManager: ScheduleManager;
  private workspaceDir: string;
  private debounceMs: number;
  private watchedDirs: Map<string, WatchedDir> = new Map();
  private running = false;
  /** Resolved watch paths per task */
  private taskWatchPaths: Map<string, string[]> = new Map();

  constructor(options: TriggerWatcherOptions) {
    this.scheduler = options.scheduler;
    this.scheduleManager = options.scheduleManager;
    this.workspaceDir = options.workspaceDir;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    logger.info({ workspaceDir: this.workspaceDir, debounceMs: this.debounceMs }, 'TriggerWatcher created');
  }

  /**
   * Start watching all configured directories.
   * Scans all enabled tasks for `watch` configs and sets up fs.watch.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('TriggerWatcher already running');
      return;
    }

    this.running = true;

    // Load all enabled tasks and find those with watch configs
    const tasks = await this.scheduleManager.listEnabled();
    let watchCount = 0;

    for (const task of tasks) {
      if (task.watch?.paths && task.watch.paths.length > 0) {
        for (const watchPath of task.watch.paths) {
          const absolutePath = path.resolve(this.workspaceDir, watchPath);
          await this.setupWatch(absolutePath, task.id);
          watchCount++;

          // Track per-task watch paths
          const existing = this.taskWatchPaths.get(task.id) ?? [];
          existing.push(absolutePath);
          this.taskWatchPaths.set(task.id, existing);
        }
      }
    }

    logger.info({ taskCount: tasks.length, watchedPaths: watchCount }, 'TriggerWatcher started');
  }

  /**
   * Stop all watchers and clean up resources.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    for (const [dirPath, entry] of this.watchedDirs) {
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
      }
      entry.watcher.close();
      logger.debug({ dirPath }, 'Stopped watching directory');
    }

    this.watchedDirs.clear();
    this.taskWatchPaths.clear();
    this.running = false;
    logger.info('TriggerWatcher stopped');
  }

  /**
   * Check if watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of directories being watched.
   */
  getWatchedDirCount(): number {
    return this.watchedDirs.size;
  }

  /**
   * Reload watch configurations from ScheduleManager.
   * Useful after schedule files are added/removed/modified.
   */
  async reload(): Promise<void> {
    this.stop();
    await this.start();
    logger.info('TriggerWatcher reloaded');
  }

  /**
   * Set up a file system watcher for a directory.
   *
   * @param absolutePath - Absolute path to watch
   * @param taskId - Task ID to associate with this watch
   */
  private async setupWatch(absolutePath: string, taskId: string): Promise<void> {
    // Check if already watching this directory
    const existing = this.watchedDirs.get(absolutePath);
    if (existing) {
      existing.taskIds.add(taskId);
      return;
    }

    // Ensure directory exists
    try {
      await fsPromises.mkdir(absolutePath, { recursive: true });
    } catch (error) {
      logger.error({ err: error, dirPath: absolutePath }, 'Failed to create watch directory');
      return;
    }

    try {
      const watcher = fs.watch(
        absolutePath,
        { persistent: false, recursive: false },
        (_eventType, filename) => {
          if (filename) {
            this.handleFileChange(absolutePath, filename);
          }
        }
      );

      watcher.on('error', (error) => {
        logger.error({ err: error, dirPath: absolutePath }, 'Watch error');
      });

      this.watchedDirs.set(absolutePath, {
        absolutePath,
        watcher,
        taskIds: new Set([taskId]),
        debounceTimer: null,
      });

      logger.info({ dirPath: absolutePath, taskId }, 'Watching directory for file changes');

    } catch (error) {
      logger.error({ err: error, dirPath: absolutePath }, 'Failed to set up watcher');
    }
  }

  /**
   * Handle a file change event with debouncing.
   *
   * @param dirPath - Directory where change occurred
   * @param filename - Name of the changed file
   */
  private handleFileChange(dirPath: string, filename: string): void {
    const entry = this.watchedDirs.get(dirPath);
    if (!entry) { return; }
    if (filename.startsWith('.') || filename.endsWith('.lock') || filename.endsWith('.tmp')) {
      logger.debug({ dirPath, filename }, 'Ignored file change (hidden/lock/tmp file)');
      return;
    }

    logger.debug({ dirPath, filename, taskIds: [...entry.taskIds] }, 'File change detected');

    // Reset debounce timer
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }

    // Set new debounce timer
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      void this.flushTriggers(dirPath);
    }, this.debounceMs);
  }

  /**
   * Flush all pending triggers for a directory.
   * Called after debounce period expires.
   *
   * @param dirPath - Directory to flush triggers for
   */
  private async flushTriggers(dirPath: string): Promise<void> {
    const entry = this.watchedDirs.get(dirPath);
    if (!entry) { return; }

    for (const taskId of entry.taskIds) {
      logger.info({ taskId, dirPath }, 'Triggering schedule due to file change');
      try {
        await this.scheduler.triggerTask(taskId);
      } catch (error) {
        logger.error({ err: error, taskId }, 'Failed to trigger schedule');
      }
    }
  }
}
