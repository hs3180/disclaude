/**
 * SignalWatcher - Watches for signal files and triggers schedule tasks.
 *
 * Issue #1953: Event-driven schedule trigger mechanism (Method C — Signal File).
 *
 * When a schedule has a `trigger` configuration, the SignalWatcher monitors
 * the specified signal path. When a signal file appears, the watcher:
 * 1. Consumes the signal file (deletes it)
 * 2. Notifies the scheduler to immediately execute the associated task
 *
 * Multiple tasks can share the same signal directory; the watcher creates
 * one `fs.watch` per unique parent directory for efficiency.
 *
 * Debouncing prevents rapid re-triggering: multiple signals within the
 * debounce window are batched into a single execution.
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduledTask } from './scheduled-task.js';

const logger = createLogger('SignalWatcher');

/**
 * Callback when a signal is detected and a task should be triggered.
 *
 * @param task - The task to trigger
 */
export type OnTrigger = (task: ScheduledTask) => void;

/**
 * SignalWatcher options.
 */
export interface SignalWatcherOptions {
  /** Callback when a signal triggers a task */
  onTrigger: OnTrigger;
}

/**
 * Entry tracking a watched signal path and its associated tasks.
 */
interface WatchedSignal {
  /** The signal path being watched */
  signalPath: string;
  /** Parent directory of the signal path */
  watchDir: string;
  /** Basename of the signal file */
  signalFile: string;
  /** Debounce interval in milliseconds */
  debounceMs: number;
  /** Task IDs associated with this signal */
  taskIds: Set<string>;
  /** Map from taskId to the full task object */
  tasks: Map<string, ScheduledTask>;
  /** Debounce timer */
  debounceTimer: NodeJS.Timeout | null;
}

/**
 * SignalWatcher - Monitors signal files for event-driven schedule triggers.
 *
 * Usage:
 * ```typescript
 * const watcher = new SignalWatcher({ onTrigger: (task) => scheduler.triggerNow(task) });
 *
 * // Register tasks with triggers
 * watcher.registerTask(task);
 *
 * // Start watching
 * await watcher.start();
 *
 * // Clean up
 * watcher.stop();
 * ```
 */
export class SignalWatcher {
  private onTrigger: OnTrigger;
  /** Map from normalized directory path to fs.FSWatcher */
  private watchers: Map<string, fs.FSWatcher> = new Map();
  /** Map from normalized signal path to WatchedSignal entry */
  private signals: Map<string, WatchedSignal> = new Map();
  /** Map from task ID to its signal key */
  private taskToSignal: Map<string, string> = new Map();
  private running = false;

  constructor(options: SignalWatcherOptions) {
    this.onTrigger = options.onTrigger;
    logger.info('SignalWatcher initialized');
  }

  /**
   * Register a task for signal watching.
   *
   * If the task has a `trigger` configuration, its signal path will be monitored.
   *
   * @param task - The task to register
   */
  registerTask(task: ScheduledTask): void {
    if (!task.trigger?.signalPath) {
      return;
    }

    const signalPath = path.resolve(task.trigger.signalPath);
    const watchDir = path.dirname(signalPath);
    const signalFile = path.basename(signalPath);
    const debounceMs = task.trigger.debounce ?? 1000;

    // Remove from previous signal if task was re-registered
    this.unregisterTask(task.id);

    // Find or create the watched signal entry
    let entry = this.signals.get(signalPath);
    if (!entry) {
      entry = {
        signalPath,
        watchDir,
        signalFile,
        debounceMs,
        taskIds: new Set(),
        tasks: new Map(),
        debounceTimer: null,
      };
      this.signals.set(signalPath, entry);
    }

    entry.taskIds.add(task.id);
    entry.tasks.set(task.id, task);
    this.taskToSignal.set(task.id, signalPath);

    // If debounce is different, use the minimum for the signal group
    if (debounceMs < entry.debounceMs) {
      entry.debounceMs = debounceMs;
    }

    logger.info(
      { taskId: task.id, signalPath, watchDir, debounceMs },
      'Registered signal trigger for task'
    );

    // If already running, ensure this directory is being watched
    // (directory creation is async since registerTask is sync)
    if (this.running && !this.watchers.has(watchDir)) {
      void fsPromises.mkdir(watchDir, { recursive: true }).then(() => {
        this.startWatchingDir(watchDir);
      }).catch((error) => {
        logger.error({ err: error, watchDir }, 'Failed to create signal directory');
      });
    }
  }

  /**
   * Unregister a task from signal watching.
   *
   * @param taskId - The task ID to unregister
   */
  unregisterTask(taskId: string): void {
    const signalPath = this.taskToSignal.get(taskId);
    if (!signalPath) { return; }

    const entry = this.signals.get(signalPath);
    if (entry) {
      entry.taskIds.delete(taskId);
      entry.tasks.delete(taskId);

      // If no more tasks for this signal, clean up
      if (entry.taskIds.size === 0) {
        if (entry.debounceTimer) {
          clearTimeout(entry.debounceTimer);
        }
        this.signals.delete(signalPath);
      }
    }

    this.taskToSignal.delete(taskId);
    logger.debug({ taskId }, 'Unregistered signal trigger for task');
  }

  /**
   * Start watching all registered signal paths.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('SignalWatcher already running');
      return;
    }

    this.running = true;

    // Create all signal parent directories and start watching
    for (const entry of this.signals.values()) {
      // Ensure directory exists
      await fsPromises.mkdir(entry.watchDir, { recursive: true });
      this.startWatchingDir(entry.watchDir);
    }

    logger.info(
      { watchedDirs: this.watchers.size, signalCount: this.signals.size },
      'SignalWatcher started'
    );
  }

  /**
   * Stop all signal watchers.
   */
  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    // Clear all debounce timers
    for (const entry of this.signals.values()) {
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
        entry.debounceTimer = null;
      }
    }

    this.running = false;
    logger.info('SignalWatcher stopped');
  }

  /**
   * Check if the watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of watched signals.
   */
  getWatchedSignalCount(): number {
    return this.signals.size;
  }

  /**
   * Get the number of active directory watchers.
   */
  getWatcherCount(): number {
    return this.watchers.size;
  }

  /**
   * Start watching a specific directory for file changes.
   *
   * Multiple signals can share the same directory watcher.
   */
  private startWatchingDir(dirPath: string): void {
    if (this.watchers.has(dirPath)) {
      return; // Already watching this directory
    }

    try {
      const watcher = fs.watch(
        dirPath,
        { persistent: true, recursive: false },
        (eventType, filename) => {
          this.handleFileEvent(dirPath, eventType, filename);
        }
      );

      watcher.on('error', (error) => {
        logger.error({ err: error, dirPath }, 'Signal directory watcher error');
      });

      this.watchers.set(dirPath, watcher);
      logger.debug({ dirPath }, 'Started watching signal directory');
    } catch (error) {
      logger.error({ err: error, dirPath }, 'Failed to start watching signal directory');
    }
  }

  /**
   * Handle a file system event in a watched directory.
   */
  private handleFileEvent(dirPath: string, eventType: string, filename: string | null): void {
    if (!filename) { return; }

    // Check if any registered signal matches this file
    for (const entry of this.signals.values()) {
      if (entry.watchDir !== dirPath || entry.signalFile !== filename) {
        continue;
      }

      logger.debug({ signalPath: entry.signalPath, eventType }, 'Signal file event detected');

      // Debounce: reset the timer on each event
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
      }

      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null;
        void this.processSignal(entry);
      }, entry.debounceMs);
    }
  }

  /**
   * Process a signal: consume the file and trigger associated tasks.
   */
  private async processSignal(entry: WatchedSignal): Promise<void> {
    // Consume the signal file (delete it)
    try {
      await fsPromises.access(entry.signalPath);
    } catch {
      // File no longer exists, skip
      logger.debug({ signalPath: entry.signalPath }, 'Signal file no longer exists, skipping');
      return;
    }

    // Delete the signal file
    try {
      await fsPromises.unlink(entry.signalPath);
      logger.info({ signalPath: entry.signalPath }, 'Signal file consumed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error, signalPath: entry.signalPath }, 'Failed to consume signal file');
      }
    }

    // Trigger all associated tasks
    for (const task of entry.tasks.values()) {
      if (!task.enabled) {
        logger.debug({ taskId: task.id }, 'Task is disabled, skipping signal trigger');
        continue;
      }

      logger.info(
        { taskId: task.id, taskName: task.name, signalPath: entry.signalPath },
        'Triggering task via signal'
      );

      try {
        this.onTrigger(task);
      } catch (error) {
        logger.error(
          { err: error, taskId: task.id },
          'Error in onTrigger callback'
        );
      }
    }
  }
}
