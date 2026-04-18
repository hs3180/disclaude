/**
 * Trigger Watcher - Watches for event-driven schedule trigger signal files.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * This module provides a file-based mechanism for triggering schedules
 * via signal files. When a schedule has `invocable: true` in its frontmatter,
 * external components (skills, agents, etc.) can trigger it by writing a
 * signal file to the `.triggers/` subdirectory of the schedules directory.
 *
 * ## How it works
 *
 * 1. Skills/agents write a trigger signal file: `schedules/.triggers/{schedule-name}.trigger`
 * 2. TriggerWatcher detects the new file via `fs.watch`
 * 3. TriggerWatcher extracts the schedule name from the filename
 * 4. TriggerWatcher calls the `onTrigger` callback with the schedule name
 * 5. The callback (typically Scheduler.invoke()) executes the schedule
 * 6. TriggerWatcher deletes the consumed signal file
 *
 * ## Signal File Format
 *
 * The signal file is a simple empty file or a JSON file with optional metadata:
 * ```json
 * {
 *   "triggeredAt": "2026-04-19T10:00:00.000Z",
 *   "triggeredBy": "skill:chat"
 * }
 * ```
 *
 * ## Example Usage
 *
 * A skill can trigger the `chats-activation` schedule immediately:
 * ```bash
 * echo '{"triggeredBy":"skill:chat"}' > schedules/.triggers/chats-activation.trigger
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TriggerWatcher');

/**
 * Callback when a trigger signal is detected.
 *
 * @param scheduleName - The schedule name derived from the trigger filename
 *   (e.g., "chats-activation" from "chats-activation.trigger")
 * @param source - Description of what created the trigger (from signal file metadata)
 */
export type OnTrigger = (scheduleName: string, source?: string) => Promise<void>;

/**
 * TriggerWatcher options.
 */
export interface TriggerWatcherOptions {
  /** Directory containing schedule files (`.triggers/` subdirectory will be used) */
  schedulesDir: string;
  /** Callback when a trigger signal is detected */
  onTrigger: OnTrigger;
  /** Debounce interval in ms (default: 200) */
  debounceMs?: number;
}

/**
 * Trigger signal file metadata (optional JSON content).
 */
interface TriggerMetadata {
  /** ISO timestamp of when the trigger was created */
  triggeredAt?: string;
  /** Description of what created the trigger */
  triggeredBy?: string;
}

/**
 * Extract schedule name from trigger filename.
 *
 * @example
 * extractScheduleName('chats-activation.trigger') // 'chats-activation'
 * extractScheduleName('pr-scanner.trigger') // 'pr-scanner'
 */
function extractScheduleName(filename: string): string | null {
  if (!filename.endsWith('.trigger')) {
    return null;
  }
  return path.basename(filename, '.trigger');
}

/**
 * TriggerWatcher - Watches for schedule trigger signal files.
 *
 * Watches the `.triggers/` subdirectory of the schedules directory.
 * When a `.trigger` file appears, extracts the schedule name and
 * invokes the callback. After processing, the signal file is deleted.
 */
export class TriggerWatcher {
  private triggersDir: string;
  private onTrigger: OnTrigger;
  private debounceMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  constructor(options: TriggerWatcherOptions) {
    this.triggersDir = path.join(options.schedulesDir, '.triggers');
    this.onTrigger = options.onTrigger;
    this.debounceMs = options.debounceMs ?? 200;
    logger.info({ triggersDir: this.triggersDir }, 'TriggerWatcher initialized');
  }

  /**
   * Start watching for trigger signal files.
   *
   * Creates the `.triggers/` directory if it doesn't exist,
   * then starts an fs.watch listener.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('TriggerWatcher already running');
      return;
    }

    // Ensure triggers directory exists
    await fsPromises.mkdir(this.triggersDir, { recursive: true });

    // Process any existing trigger files (leftover from previous run)
    await this.processExistingTriggers();

    try {
      this.watcher = fs.watch(
        this.triggersDir,
        { persistent: true, recursive: false },
        (eventType, filename) => {
          this.handleFileEvent(eventType, filename);
        }
      );

      this.watcher.on('error', (error) => {
        logger.error({ err: error }, 'TriggerWatcher file watcher error');
      });

      this.running = true;
      logger.info({ triggersDir: this.triggersDir }, 'TriggerWatcher started');

    } catch (error) {
      logger.error({ err: error }, 'Failed to start TriggerWatcher');
      throw error;
    }
  }

  /**
   * Stop watching for trigger signal files.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

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
   * Get the triggers directory path.
   */
  getTriggersDir(): string {
    return this.triggersDir;
  }

  /**
   * Write a trigger signal file for a schedule.
   *
   * Utility method for external components to create trigger signals.
   *
   * @param schedulesDir - The schedules directory (not the .triggers subdirectory)
   * @param scheduleName - Name of the schedule to trigger
   * @param source - Optional description of what is creating the trigger
   */
  static async writeTrigger(
    schedulesDir: string,
    scheduleName: string,
    source?: string
  ): Promise<void> {
    const triggersDir = path.join(schedulesDir, '.triggers');
    await fsPromises.mkdir(triggersDir, { recursive: true });

    const triggerPath = path.join(triggersDir, `${scheduleName}.trigger`);
    const metadata: TriggerMetadata = {
      triggeredAt: new Date().toISOString(),
      triggeredBy: source ?? 'unknown',
    };

    await fsPromises.writeFile(triggerPath, JSON.stringify(metadata, null, 2), 'utf-8');
    logger.info({ scheduleName, source, triggerPath }, 'Trigger signal file written');
  }

  /**
   * Process any trigger files that already exist in the directory.
   * Handles leftover triggers from a previous run.
   */
  private async processExistingTriggers(): Promise<void> {
    try {
      const files = await fsPromises.readdir(this.triggersDir);
      const triggerFiles = files.filter(f => f.endsWith('.trigger'));

      if (triggerFiles.length > 0) {
        logger.info({ count: triggerFiles.length }, 'Processing existing trigger files');
        for (const file of triggerFiles) {
          await this.processTriggerFile(path.join(this.triggersDir, file), file);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      logger.error({ err: error }, 'Error processing existing triggers');
    }
  }

  /**
   * Handle file system event with debouncing.
   */
  private handleFileEvent(eventType: string, filename: string | null): void {
    if (!filename) {
      return;
    }

    const scheduleName = extractScheduleName(filename);
    if (!scheduleName) {
      return;
    }

    logger.debug({ eventType, filename, scheduleName }, 'Trigger file event received');

    // Debounce: only process after a short delay
    const existingTimer = this.debounceTimers.get(filename);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filename);
      const filePath = path.join(this.triggersDir, filename);
      void this.processTriggerFile(filePath, filename);
    }, this.debounceMs);

    this.debounceTimers.set(filename, timer);
  }

  /**
   * Process a single trigger signal file.
   *
   * Reads optional metadata, invokes the callback, then deletes the file.
   */
  private async processTriggerFile(filePath: string, filename: string): Promise<void> {
    const scheduleName = extractScheduleName(filename);
    if (!scheduleName) {
      return;
    }

    try {
      // Check file still exists (may have been processed already)
      await fsPromises.access(filePath);

      // Read optional metadata
      let source: string | undefined;
      try {
        const content = await fsPromises.readFile(filePath, 'utf-8');
        if (content.trim()) {
          const metadata: TriggerMetadata = JSON.parse(content);
          source = metadata.triggeredBy;
        }
      } catch {
        // Not valid JSON, treat as empty trigger
        logger.debug({ filePath }, 'Trigger file has no valid JSON metadata, treating as empty');
      }

      // Invoke the callback
      logger.info({ scheduleName, source }, 'Processing trigger signal');
      await this.onTrigger(scheduleName, source);

    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug({ filePath }, 'Trigger file already consumed');
        return;
      }
      logger.error({ err: error, filePath }, 'Error processing trigger file');
    } finally {
      // Always attempt to clean up the trigger file
      try {
        await fsPromises.unlink(filePath);
      } catch {
        // File may have already been deleted
      }
    }
  }
}
