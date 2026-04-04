/**
 * EventTriggerManager - Watches file system paths and triggers schedule execution.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Enables schedules to be triggered by file changes in addition to cron.
 * Uses Node.js `fs.watch()` to monitor directories and filters events
 * by glob patterns.
 *
 * Architecture:
 * ```
 * Schedule frontmatter:
 *   watch: "workspace/chats/*.json"
 *   watchDebounce: 5000
 *
 * EventTriggerManager:
 *   1. Extract directory from glob pattern
 *   2. Start fs.watch() on the directory
 *   3. Filter file events by extension
 *   4. Debounce rapid changes (default 5s)
 *   5. Call onTrigger callback
 *
 * Scheduler:
 *   addTask(task with watch config)
 *     -> creates EventTriggerManager
 *     -> on file change -> triggerTask(taskId)
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('EventTriggerManager');

/**
 * Default debounce interval for event triggers (5 seconds).
 * Multiple file changes within this window are coalesced into a single trigger.
 */
const DEFAULT_DEBOUNCE_MS = 5000;

/**
 * Options for creating an EventTriggerManager.
 */
export interface EventTriggerManagerOptions {
  /** Base directory for resolving relative watch patterns (e.g., project root) */
  baseDir: string;
  /** Glob pattern to watch (relative to baseDir, e.g., "workspace/chats/*.json") */
  pattern: string;
  /** Debounce interval in milliseconds (default: 5000) */
  debounceMs?: number;
  /** Callback invoked when a matching file change is detected (debounced) */
  onTrigger: () => void | Promise<void>;
}

/**
 * Parsed watch pattern components.
 */
interface ParsedPattern {
  /** Absolute directory path to watch */
  watchDir: string;
  /** File extension filter (e.g., ".json"), or null for all files */
  extension: string | null;
}

/**
 * EventTriggerManager - Watches a glob pattern and triggers a callback on file changes.
 *
 * Features:
 * - Directory-level fs.watch() with extension filtering
 * - Configurable debounce to prevent rapid re-triggering
 * - Graceful handling of missing directories (logs warning, skips watch)
 * - Clean start/stop lifecycle
 *
 * Usage:
 * ```typescript
 * const trigger = new EventTriggerManager({
 *   baseDir: '/project/root',
 *   pattern: 'workspace/chats/*.json',
 *   debounceMs: 5000,
 *   onTrigger: () => scheduler.triggerTask('my-task'),
 * });
 *
 * await trigger.start();
 * // ... file changes in workspace/chats/ trigger the callback
 * trigger.stop();
 * ```
 */
export class EventTriggerManager {
  private baseDir: string;
  private pattern: string;
  private debounceMs: number;
  private onTrigger: () => void | Promise<void>;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private running = false;
  private parsedPattern: ParsedPattern | null = null;

  constructor(options: EventTriggerManagerOptions) {
    this.baseDir = options.baseDir;
    this.pattern = options.pattern;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onTrigger = options.onTrigger;
  }

  /**
   * Start watching the configured pattern.
   *
   * If the watched directory doesn't exist, logs a warning and skips setup.
   * The watch will NOT auto-create directories — this is intentional to avoid
   * accidental directory creation from typo patterns.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('EventTriggerManager already running');
      return;
    }

    this.parsedPattern = this.parsePattern(this.pattern);
    const { watchDir } = this.parsedPattern;

    // Check if directory exists
    const dirExists = await this.directoryExists(watchDir);
    if (!dirExists) {
      logger.warn(
        { pattern: this.pattern, watchDir },
        'Watch directory does not exist, skipping event trigger setup'
      );
      return;
    }

    try {
      this.watcher = fs.watch(
        watchDir,
        { persistent: true, recursive: false },
        (eventType, filename) => {
          this.handleFileEvent(eventType, filename);
        }
      );

      this.watcher.on('error', (error) => {
        logger.error({ err: error, pattern: this.pattern }, 'File watcher error');
      });

      this.running = true;
      logger.info(
        { pattern: this.pattern, watchDir, debounceMs: this.debounceMs },
        'Event trigger started'
      );
    } catch (error) {
      logger.error(
        { err: error, pattern: this.pattern, watchDir },
        'Failed to start file watcher'
      );
    }
  }

  /**
   * Stop watching and clean up resources.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.running = false;
    logger.info({ pattern: this.pattern }, 'Event trigger stopped');
  }

  /**
   * Check if the trigger is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the watch pattern.
   */
  getPattern(): string {
    return this.pattern;
  }

  /**
   * Parse a glob pattern into directory and extension components.
   *
   * Examples:
   * - "workspace/chats/*.json" → { watchDir: "<base>/workspace/chats", extension: ".json" }
   * - "workspace/chats/" → { watchDir: "<base>/workspace/chats", extension: null }
   * - "*.log" → { watchDir: "<base>", extension: ".log" }
   *
   * @param pattern - Glob pattern relative to baseDir
   * @returns Parsed pattern with absolute directory and extension filter
   */
  parsePattern(pattern: string): ParsedPattern {
    // Find the last path separator
    const lastSep = Math.max(pattern.lastIndexOf('/'), pattern.lastIndexOf('\\'));

    let dirPart: string;
    let filePart: string;

    if (lastSep >= 0) {
      dirPart = pattern.substring(0, lastSep);
      filePart = pattern.substring(lastSep + 1);
    } else {
      dirPart = '.';
      filePart = pattern;
    }

    // Extract extension from file part (e.g., "*.json" → ".json", "data.*" → null)
    let extension: string | null = null;
    if (filePart.startsWith('*.')) {
      extension = filePart.substring(1); // "*.json" → ".json"
    } else if (filePart.includes('*')) {
      // Complex patterns like "chat-*.json" — match by extracting extension after last dot
      const dotIndex = filePart.lastIndexOf('.');
      if (dotIndex > 0) {
        extension = filePart.substring(dotIndex); // "chat-*.json" → ".json"
      }
      // If no dot after *, watch all files in the directory
    } else if (filePart.includes('.')) {
      // Exact file match (e.g., "specific-file.json") — match by full extension
      extension = filePart.substring(filePart.lastIndexOf('.'));
    }

    const watchDir = path.resolve(this.baseDir, dirPart === '.' ? '.' : dirPart);

    return { watchDir, extension };
  }

  /**
   * Handle a file system event from fs.watch().
   */
  private handleFileEvent(eventType: string, filename: string | null): void {
    if (!filename) {
      return;
    }

    // Check if the file matches the pattern
    if (!this.matchesPattern(filename)) {
      return;
    }

    logger.debug(
      { eventType, filename, pattern: this.pattern },
      'Matching file event detected'
    );

    this.scheduleDebouncedTrigger();
  }

  /**
   * Check if a filename matches the watch pattern.
   */
  private matchesPattern(filename: string): boolean {
    if (!this.parsedPattern) {
      return false;
    }

    const { extension } = this.parsedPattern;

    // No extension filter — match all files
    if (!extension) {
      return true;
    }

    return filename.endsWith(extension);
  }

  /**
   * Schedule a debounced trigger callback.
   * Multiple file changes within the debounce window are coalesced.
   */
  private scheduleDebouncedTrigger(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      logger.info({ pattern: this.pattern }, 'Event trigger fired (debounced)');
      try {
        this.onTrigger();
      } catch (error) {
        logger.error({ err: error, pattern: this.pattern }, 'Event trigger callback failed');
      }
    }, this.debounceMs);
  }

  /**
   * Check if a directory exists.
   */
  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fsPromises.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}
