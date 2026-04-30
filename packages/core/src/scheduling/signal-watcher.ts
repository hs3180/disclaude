/**
 * Signal Watcher - Watches for signal files to trigger event-driven schedule execution.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * When a schedule declares `watchPath` in its frontmatter, the SignalWatcher
 * monitors that directory for signal files. When a signal file appears, the
 * associated schedule is immediately triggered via `Scheduler.triggerNow()`.
 *
 * ## How it works
 *
 * 1. Schedule declares `watchPath` and optional `signalFile` in frontmatter
 * 2. SignalWatcher monitors all declared watch paths
 * 3. When a signal file appears, the watcher:
 *    a. Identifies which schedules watch this path
 *    b. Deletes the signal file (consumed)
 *    c. Triggers each matching schedule via `Scheduler.triggerNow()`
 * 4. Cron schedule remains active as a fallback
 *
 * ## Signal file creation (by Skills/Agents)
 *
 * ```bash
 * # Simple trigger - creates signal file
 * touch workspace/chats/.trigger
 * ```
 *
 * ## Schedule frontmatter example
 *
 * ```yaml
 * ---
 * name: "Chats Activation"
 * cron: "0 0-23/5 * * *"
 * watchPath: "workspace/chats"
 * signalFile: ".trigger"
 * ---
 * ```
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
 * Default signal filename when not specified in schedule frontmatter.
 */
const DEFAULT_SIGNAL_FILE = '.trigger';

/**
 * Callback type for triggering a schedule by task ID.
 */
export type OnTriggerSchedule = (taskId: string) => Promise<boolean>;

/**
 * SignalWatcher options.
 */
export interface SignalWatcherOptions {
  /** Callback to trigger a schedule by task ID */
  onTrigger: OnTriggerSchedule;
}

/**
 * Watch entry mapping a directory to one or more schedules.
 */
interface WatchEntry {
  /** Absolute directory path being watched */
  dirPath: string;
  /** Task IDs that watch this directory */
  taskIds: string[];
  /** Signal filename to watch for */
  signalFile: string;
  /** The fs.FSWatcher instance */
  watcher: fs.FSWatcher | null;
}

/**
 * SignalWatcher - Watches for signal files and triggers event-driven schedule execution.
 *
 * Issue #1953: Provides the "signal file" trigger mechanism.
 * Complements the existing cron-based scheduling with immediate,
 * event-driven execution based on file system signals.
 *
 * Features:
 * - Zero-config: only watches paths declared in schedule frontmatter
 * - Automatic cleanup: signal files are consumed (deleted) after detection
 * - Debounced: rapid signal file creation only triggers once per debounce period
 * - Coexistence: cron fallback remains active for reliability
 * - Backward-compatible: schedules without `watchPath` are unaffected
 */
export class SignalWatcher {
  private onTrigger: OnTriggerSchedule;
  private watchEntries: Map<string, WatchEntry> = new Map();
  /** Debounce timers per directory to prevent rapid re-triggering */
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Debounce interval in ms */
  private debounceMs: number;
  private running = false;

  constructor(options: SignalWatcherOptions) {
    this.onTrigger = options.onTrigger;
    this.debounceMs = 500; // 500ms debounce for signal files
    logger.info('SignalWatcher initialized');
  }

  /**
   * Register a schedule for signal watching.
   * If the schedule has a `watchPath`, it will be monitored.
   *
   * @param task - The scheduled task to register
   */
  registerTask(task: ScheduledTask): void {
    if (!task.watchPath) {
      return; // Not a signal-triggered schedule
    }

    const dirPath = path.resolve(task.watchPath);
    const signalFile = task.signalFile || DEFAULT_SIGNAL_FILE;
    const key = `${dirPath}:${signalFile}`;

    const existing = this.watchEntries.get(key);
    if (existing) {
      // Add this task ID to the existing watch entry
      if (!existing.taskIds.includes(task.id)) {
        existing.taskIds.push(task.id);
      }
    } else {
      this.watchEntries.set(key, {
        dirPath,
        taskIds: [task.id],
        signalFile,
        watcher: null,
      });
    }

    logger.debug(
      { taskId: task.id, dirPath, signalFile },
      'Registered task for signal watching'
    );
  }

  /**
   * Unregister a schedule from signal watching.
   *
   * @param taskId - The task ID to unregister
   */
  unregisterTask(taskId: string): void {
    for (const [key, entry] of this.watchEntries) {
      const idx = entry.taskIds.indexOf(taskId);
      if (idx !== -1) {
        entry.taskIds.splice(idx, 1);
        if (entry.taskIds.length === 0) {
          // No more tasks watching this path — clean up
          if (entry.watcher) {
            entry.watcher.close();
          }
          this.watchEntries.delete(key);
        }
        logger.debug({ taskId }, 'Unregistered task from signal watching');
        return;
      }
    }
  }

  /**
   * Start watching all registered paths.
   * Creates directory watchers for each unique watch path.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('SignalWatcher already running');
      return;
    }

    this.running = true;

    for (const [key, entry] of this.watchEntries) {
      await this.startWatching(key, entry);
    }

    logger.info(
      { watchCount: this.watchEntries.size },
      'SignalWatcher started'
    );
  }

  /**
   * Stop watching all paths.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;

    for (const [, entry] of this.watchEntries) {
      if (entry.watcher) {
        entry.watcher.close();
        entry.watcher = null;
      }
    }

    // Clear debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    logger.info('SignalWatcher stopped');
  }

  /**
   * Check if the watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get all registered watch entries (for testing/debugging).
   */
  getWatchEntries(): ReadonlyArray<Readonly<WatchEntry>> {
    return Array.from(this.watchEntries.values());
  }

  /**
   * Start watching a specific directory.
   */
  private async startWatching(key: string, entry: WatchEntry): Promise<void> {
    try {
      // Ensure the watched directory exists
      await fsPromises.mkdir(entry.dirPath, { recursive: true });

      const watcher = fs.watch(
        entry.dirPath,
        { persistent: true, recursive: false },
        (eventType, filename) => {
          this.handleFileEvent(key, entry, eventType, filename);
        }
      );

      watcher.on('error', (error) => {
        logger.error({ err: error, dirPath: entry.dirPath }, 'Signal watcher error');
      });

      entry.watcher = watcher;
      logger.info({ dirPath: entry.dirPath, signalFile: entry.signalFile }, 'Watching for signal files');

    } catch (error) {
      logger.error({ err: error, dirPath: entry.dirPath }, 'Failed to start watching');
    }
  }

  /**
   * Handle a file system event in a watched directory.
   */
  private handleFileEvent(
    key: string,
    entry: WatchEntry,
    eventType: string,
    filename: string | null
  ): void {
    if (!filename || filename !== entry.signalFile) {
      return; // Not our signal file
    }

    logger.debug({ dirPath: entry.dirPath, filename, eventType }, 'Signal file event detected');

    // Debounce: reset timer if one exists
    const existingTimer = this.debounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      void this.processSignal(key, entry);
    }, this.debounceMs);

    this.debounceTimers.set(key, timer);
  }

  /**
   * Process a detected signal file.
   * Consumes (deletes) the signal file and triggers associated schedules.
   */
  private async processSignal(_key: string, entry: WatchEntry): Promise<void> {
    const signalPath = path.join(entry.dirPath, entry.signalFile);

    try {
      // Check if signal file still exists (might have been consumed already)
      try {
        await fsPromises.access(signalPath);
      } catch {
        logger.debug({ signalPath }, 'Signal file already consumed');
        return;
      }

      // Consume (delete) the signal file
      await fsPromises.unlink(signalPath);
      logger.info({ signalPath }, 'Signal file consumed');

      // Trigger all schedules watching this path
      for (const taskId of entry.taskIds) {
        try {
          const triggered = await this.onTrigger(taskId);
          if (triggered) {
            logger.info({ taskId, signalPath }, 'Schedule triggered by signal');
          } else {
            logger.warn({ taskId, signalPath }, 'Schedule trigger skipped (not found or cooldown)');
          }
        } catch (error) {
          logger.error({ err: error, taskId }, 'Error triggering schedule from signal');
        }
      }

    } catch (error) {
      logger.error({ err: error, signalPath }, 'Error processing signal file');
    }
  }
}

/**
 * Helper function to create a signal file.
 * Used by Skills/Agents to trigger event-driven schedules.
 *
 * Issue #1953: Signal file creation utility.
 *
 * @param watchPath - The directory to create the signal file in
 * @param signalFile - The signal filename (default: '.trigger')
 */
export async function createSignalFile(watchPath: string, signalFile?: string): Promise<void> {
  const filename = signalFile || DEFAULT_SIGNAL_FILE;
  const filePath = path.join(watchPath, filename);

  // Ensure directory exists
  await fsPromises.mkdir(watchPath, { recursive: true });

  // Write empty file (touch)
  await fsPromises.writeFile(filePath, '', 'utf-8');

  logger.info({ filePath }, 'Signal file created');
}
