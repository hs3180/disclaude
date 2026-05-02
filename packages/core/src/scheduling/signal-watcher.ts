/**
 * Signal Watcher - Watches for signal files to trigger scheduled tasks.
 *
 * Implements the signal-file event trigger mechanism for Issue #1953.
 * External systems (Coordinator Agent, webhooks, etc.) can create signal
 * files to trigger scheduled tasks immediately, without waiting for cron.
 *
 * ## Signal File Format
 *
 * Signal files are JSON files placed in a designated `.signals/` directory:
 *
 * ```json
 * {
 *   "targetTaskId": "schedule-pr-scanner",
 *   "eventType": "github.pr.opened",
 *   "payload": { "prNumber": 42, "author": "octocat" },
 *   "timestamp": "2026-05-02T12:00:00.000Z"
 * }
 * ```
 *
 * ## Workflow
 *
 * 1. External system creates a signal file in `.signals/` directory
 * 2. SignalWatcher detects the new file via fs.watch
 * 3. SignalWatcher reads and validates the signal
 * 4. Calls onSignal callback with the parsed signal
 * 5. Deletes the signal file (consumed)
 *
 * ## Architecture
 *
 * ```
 * External System → writes signal file → .signals/ directory
 *                                          ↓
 * SignalWatcher (fs.watch) → reads signal → onSignal callback
 *                                          ↓
 * Scheduler.triggerTask(taskId) → executor → ChatAgent
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SignalWatcher');

// ============================================================================
// Types
// ============================================================================

/**
 * Signal file structure.
 *
 * Represents a signal that triggers one or more scheduled tasks.
 */
export interface Signal {
  /** Target task ID to trigger (e.g., "schedule-pr-scanner") */
  targetTaskId: string;
  /** Event type that triggered this signal (e.g., "github.pr.opened") */
  eventType: string;
  /** Optional payload with event-specific data */
  payload?: Record<string, unknown>;
  /** ISO timestamp when the signal was created */
  timestamp: string;
}

/**
 * Callback when a signal is received.
 *
 * @param signal - The parsed signal
 */
export type OnSignal = (signal: Signal) => void;

/**
 * SignalWatcher options.
 */
export interface SignalWatcherOptions {
  /** Directory to watch for signal files */
  signalsDir: string;
  /** Callback when a signal is received */
  onSignal: OnSignal;
  /** Debounce interval in ms (default: 50) */
  debounceMs?: number;
}

// ============================================================================
// SignalWatcher
// ============================================================================

/**
 * SignalWatcher - Watches a directory for signal files and triggers
 * scheduled tasks when signals arrive.
 *
 * Signal files are consumed (deleted) after processing to prevent
 * re-triggering. This design follows the "write once, consume once" pattern.
 *
 * Usage:
 * ```typescript
 * const watcher = new SignalWatcher({
 *   signalsDir: './workspace/schedules/.signals',
 *   onSignal: (signal) => {
 *     scheduler.triggerTask(signal.targetTaskId);
 *   },
 * });
 *
 * await watcher.start();
 * ```
 */
export class SignalWatcher {
  private signalsDir: string;
  private onSignal: OnSignal;
  private debounceMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;
  /** Track files being processed to avoid race conditions */
  private processingFiles: Set<string> = new Set();

  constructor(options: SignalWatcherOptions) {
    this.signalsDir = options.signalsDir;
    this.onSignal = options.onSignal;
    this.debounceMs = options.debounceMs ?? 50;
    logger.info({ signalsDir: this.signalsDir }, 'SignalWatcher initialized');
  }

  /**
   * Start watching for signal files.
   *
   * Also processes any existing signal files that were created before
   * the watcher started (e.g., after a restart).
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Signal watcher already running');
      return;
    }

    await fsPromises.mkdir(this.signalsDir, { recursive: true });

    try {
      // Process any existing signals first (recovery after restart)
      await this.processExistingSignals();

      this.watcher = fs.watch(
        this.signalsDir,
        { persistent: true },
        (eventType, filename) => {
          this.handleFileEvent(eventType, filename);
        }
      );

      this.watcher.on('error', (error) => {
        logger.error({ err: error }, 'Signal watcher error');
      });

      this.running = true;
      logger.info({ signalsDir: this.signalsDir }, 'Signal watcher started');

    } catch (error) {
      logger.error({ err: error }, 'Failed to start signal watcher');
      throw error;
    }
  }

  /**
   * Stop watching for signal files.
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
    logger.info('Signal watcher stopped');
  }

  /**
   * Check if watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Process any existing signal files in the directory.
   * Called on startup to handle signals that arrived during downtime.
   */
  private async processExistingSignals(): Promise<void> {
    try {
      const entries = await fsPromises.readdir(this.signalsDir);

      for (const entry of entries) {
        if (!entry.endsWith('.json')) {
          continue;
        }

        const filePath = path.join(this.signalsDir, entry);
        await this.processSignalFile(filePath);
      }

      if (entries.length > 0) {
        logger.info({ count: entries.length }, 'Processed existing signal files');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug('Signals directory does not exist, nothing to process');
        return;
      }
      logger.error({ err: error }, 'Error processing existing signals');
    }
  }

  /**
   * Handle file system event.
   */
  private handleFileEvent(eventType: string, filename: string | null): void {
    if (!filename || !filename.endsWith('.json')) {
      return;
    }

    const filePath = path.join(this.signalsDir, filename);
    logger.debug({ eventType, filename }, 'Signal file event received');

    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.processSignalFile(filePath);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Process a single signal file.
   *
   * Reads the file, validates it, calls the onSignal callback,
   * and then deletes the file (consume-once pattern).
   */
  private async processSignalFile(filePath: string): Promise<void> {
    // Prevent concurrent processing of the same file
    if (this.processingFiles.has(filePath)) {
      return;
    }
    this.processingFiles.add(filePath);

    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      const signal = this.parseSignal(content, filePath);

      if (signal) {
        logger.info(
          { targetTaskId: signal.targetTaskId, eventType: signal.eventType },
          'Signal received'
        );

        // Call the callback
        this.onSignal(signal);
      }

      // Delete the signal file (consume-once)
      await fsPromises.unlink(filePath);
      logger.debug({ filePath }, 'Signal file consumed');

    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug({ filePath }, 'Signal file already consumed');
      } else {
        logger.error({ err: error, filePath }, 'Error processing signal file');
      }
    } finally {
      this.processingFiles.delete(filePath);
    }
  }

  /**
   * Parse and validate a signal from file content.
   */
  private parseSignal(content: string, filePath: string): Signal | null {
    try {
      const data = JSON.parse(content);

      // Validate required fields
      if (!data.targetTaskId || typeof data.targetTaskId !== 'string') {
        logger.warn({ filePath }, 'Signal missing required field: targetTaskId');
        return null;
      }

      if (!data.eventType || typeof data.eventType !== 'string') {
        logger.warn({ filePath }, 'Signal missing required field: eventType');
        return null;
      }

      return {
        targetTaskId: data.targetTaskId,
        eventType: data.eventType,
        payload: data.payload,
        timestamp: data.timestamp || new Date().toISOString(),
      };
    } catch (error) {
      logger.warn({ err: error, filePath }, 'Invalid signal file (not valid JSON)');
      return null;
    }
  }
}

// ============================================================================
// Signal File Writer Utility
// ============================================================================

/**
 * Write a signal file to trigger a scheduled task.
 *
 * This is the "producer" side of the signal mechanism. External systems
 * (Coordinator Agent, webhook handlers, etc.) use this to trigger tasks.
 *
 * @param signalsDir - Directory for signal files
 * @param signal - Signal to write
 * @returns Path of the created signal file
 */
export async function writeSignal(
  signalsDir: string,
  signal: Omit<Signal, 'timestamp'> & { timestamp?: string }
): Promise<string> {
  await fsPromises.mkdir(signalsDir, { recursive: true });

  const fullSignal: Signal = {
    ...signal,
    timestamp: signal.timestamp || new Date().toISOString(),
  };

  // Generate unique filename to avoid collisions
  const filename = `${fullSignal.eventType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filePath = path.join(signalsDir, filename);

  await fsPromises.writeFile(filePath, JSON.stringify(fullSignal, null, 2), 'utf-8');

  logger.debug({ filePath, targetTaskId: fullSignal.targetTaskId }, 'Signal file written');
  return filePath;
}
