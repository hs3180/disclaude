/**
 * Signal File Watcher - Watches for trigger signal files in schedule directories.
 *
 * Issue #1953: Event-driven schedule trigger mechanism (Option C: Signal File).
 *
 * When an external system (Skill, Agent, or Coordinator Agent) wants to
 * trigger a schedule, it creates a `.trigger` file in the schedule's directory:
 *
 * ```
 * schedules/chats-activation/.trigger          # Simple trigger
 * schedules/chats-activation/.trigger.context  # Trigger with context (JSON)
 * ```
 *
 * This watcher detects the signal file, reads optional context, triggers
 * the schedule via Scheduler.triggerTask(), and cleans up the signal file.
 *
 * ## Signal File Format
 *
 * `.trigger` - Empty file, triggers the schedule
 * `.trigger.context` - JSON file with trigger context:
 * ```json
 * {
 *   "reason": "PR #123 opened",
 *   "details": "New pull request requires review"
 * }
 * ```
 *
 * ## Architecture
 *
 * ```
 * External System (Skill / Agent / Coordinator)
 *     ↓ writes signal file
 * schedules/<slug>/.trigger
 * schedules/<slug>/.trigger.context
 *     ↓ detected by SignalWatcher
 * Scheduler.triggerTask(taskId, context)
 *     ↓ executes
 * ChatAgent runs with trigger context
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SignalWatcher');

/**
 * Callback to trigger a task.
 * Matches Scheduler.triggerTask() signature.
 */
export type OnTrigger = (taskId: string, context?: string) => Promise<{ ok: boolean; error?: string }>;

/**
 * SignalWatcher options.
 */
export interface SignalWatcherOptions {
  /** Directory containing schedule subdirectories */
  schedulesDir: string;
  /** Callback to trigger a task */
  onTrigger: OnTrigger;
  /** Polling interval in ms (default: 2000) */
  pollIntervalMs?: number;
}

/** Name of the trigger signal file */
const TRIGGER_FILE = '.trigger';
/** Name of the trigger context file */
const TRIGGER_CONTEXT_FILE = '.trigger.context';

/**
 * SignalWatcher - Watches for trigger signal files in schedule directories.
 *
 * Uses polling instead of fs.watch for simplicity and cross-platform reliability.
 * The poll interval is configurable (default 2s), which is sufficient since
 * signal-based triggering is meant to reduce cron frequency (not sub-second).
 */
export class SignalWatcher {
  private schedulesDir: string;
  private onTrigger: OnTrigger;
  private pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: SignalWatcherOptions) {
    this.schedulesDir = options.schedulesDir;
    this.onTrigger = options.onTrigger;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    logger.info({ schedulesDir: this.schedulesDir, pollIntervalMs: this.pollIntervalMs }, 'SignalWatcher initialized');
  }

  /**
   * Start watching for signal files.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('SignalWatcher already running');
      return;
    }

    await fsPromises.mkdir(this.schedulesDir, { recursive: true });

    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);

    // Prevent the timer from keeping the process alive
    if (this.timer.unref) {
      this.timer.unref();
    }

    this.running = true;
    logger.info('SignalWatcher started');
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('SignalWatcher stopped');
  }

  /**
   * Check if watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Poll for signal files in all schedule subdirectories.
   */
  private async poll(): Promise<void> {
    try {
      const entries = await fsPromises.readdir(this.schedulesDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue;
        }

        const triggerFile = path.join(this.schedulesDir, entry.name, TRIGGER_FILE);

        try {
          await fsPromises.access(triggerFile);
          // Signal file exists — process it
          await this.processSignal(entry.name, triggerFile);
        } catch {
          // No trigger file — skip
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // Directory doesn't exist yet, skip
      }
      logger.error({ err: error }, 'Error polling for signal files');
    }
  }

  /**
   * Process a signal file: read context, trigger task, clean up.
   */
  private async processSignal(slug: string, triggerFile: string): Promise<void> {
    const taskId = `schedule-${slug}`;
    const dir = path.dirname(triggerFile);
    const contextFile = path.join(dir, TRIGGER_CONTEXT_FILE);

    // Read optional context
    let context: string | undefined;
    try {
      const contextData = await fsPromises.readFile(contextFile, 'utf-8');
      const parsed = JSON.parse(contextData);

      // Build human-readable context string
      if (parsed.reason) {
        context = parsed.reason;
        if (parsed.details) {
          context += `\n${parsed.details}`;
        }
      } else {
        context = contextData; // Use raw JSON if not in expected format
      }
    } catch {
      // No context file or invalid JSON — that's fine
    }

    logger.info({ taskId, hasContext: !!context }, 'Signal file detected, triggering task');

    // Trigger the task
    const result = await this.onTrigger(taskId, context);

    if (result.ok) {
      logger.info({ taskId }, 'Signal trigger successful');
    } else {
      logger.warn({ taskId, error: result.error }, 'Signal trigger failed');
    }

    // Clean up signal files regardless of result
    try {
      await fsPromises.unlink(triggerFile);
    } catch {
      // Already deleted or doesn't exist — ignore
    }
    try {
      await fsPromises.unlink(contextFile);
    } catch {
      // Doesn't exist — ignore
    }
  }

  /**
   * Write a signal file to trigger a schedule.
   * Utility method for external systems to create trigger files.
   *
   * @param schedulesDir - The schedules directory
   * @param slug - The schedule slug (e.g., "chats-activation")
   * @param context - Optional trigger context
   */
  static async writeSignal(
    schedulesDir: string,
    slug: string,
    context?: { reason: string; details?: string }
  ): Promise<void> {
    const dir = path.join(schedulesDir, slug);
    await fsPromises.mkdir(dir, { recursive: true });

    // Write trigger file
    await fsPromises.writeFile(path.join(dir, TRIGGER_FILE), '', 'utf-8');

    // Write context file if provided
    if (context) {
      await fsPromises.writeFile(
        path.join(dir, TRIGGER_CONTEXT_FILE),
        JSON.stringify(context, null, 2),
        'utf-8'
      );
    }

    logger.info({ slug, hasContext: !!context }, 'Signal file written');
  }
}
