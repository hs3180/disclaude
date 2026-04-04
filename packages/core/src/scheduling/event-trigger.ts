/**
 * Event Trigger Manager - File-based event-driven schedule triggering.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Watches specified file paths for changes and immediately triggers
 * schedule execution when matching events occur, without waiting for cron.
 *
 * Architecture:
 * ```
 * Skill writes file → fs.watch() detects change → filter check → debounce → trigger callback
 * ```
 *
 * Features:
 * - Glob pattern support for file matching (e.g., "workspace/chats/*.json")
 * - JSON field filter (e.g., '.status == "pending"')
 * - Per-trigger debouncing to prevent rapid re-triggers
 * - Automatic directory creation and cleanup
 * - Graceful error handling (falls back to cron on watcher errors)
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { WatchTrigger } from './scheduled-task.js';

const logger = createLogger('EventTrigger');

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert a simple glob pattern to a RegExp for filename matching.
 * Supports `*` wildcard (matches any characters except `/`).
 *
 * @param pattern - Glob pattern (e.g., "*.json", "chat-*.json")
 * @returns RegExp that matches the pattern
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Parse a simple JSON field filter expression.
 * Supports format: `.fieldName == "value"` or `.fieldName == 'value'`
 *
 * @param filterExpr - Filter expression (e.g., '.status == "pending"')
 * @returns Object with field name and expected value, or null if invalid
 */
function parseFilterExpression(filterExpr: string): { field: string; value: string } | null {
  const match = filterExpr.match(/^\s*\.(\w+)\s*==\s*["']([^"']+)["']\s*$/);
  if (!match) {
    return null;
  }
  return { field: match[1], value: match[2] };
}

/**
 * Check if a JSON file content matches a filter expression.
 *
 * @param filePath - Path to the JSON file
 * @param filterExpr - Filter expression
 * @returns true if the filter matches, false otherwise
 */
async function matchesFilter(filePath: string, filterExpr: string): Promise<boolean> {
  const parsed = parseFilterExpression(filterExpr);
  if (!parsed) {
    logger.warn({ filterExpr }, 'Invalid filter expression, skipping filter check');
    return true; // If filter is invalid, allow trigger (fail-open)
  }

  try {
    const content = await fsPromises.readFile(filePath, 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;

    const actualValue = data[parsed.field];
    return actualValue === parsed.value;
  } catch (error) {
    logger.debug({ err: error, filePath }, 'Failed to read/parse file for filter check');
    return false; // If file can't be read or parsed, don't trigger
  }
}

/**
 * Extract the watch directory and filename pattern from a watch path.
 *
 * @param watchPath - Watch path (e.g., "workspace/chats/*.json")
 * @param workspaceDir - Base workspace directory
 * @returns Object with directory path and filename regex, or null if invalid
 */
function parseWatchPath(watchPath: string, workspaceDir: string): { dir: string; pattern: RegExp } | null {
  if (!watchPath || watchPath.trim().length === 0) {
    return null;
  }

  const normalizedPath = watchPath.replace(/\\/g, '/');

  // Find the first `*` in the path
  const starIndex = normalizedPath.indexOf('*');
  if (starIndex === -1) {
    // No wildcard - watch the specific file's parent directory
    // The entire basename is the "pattern"
    const dir = path.resolve(workspaceDir, path.dirname(normalizedPath));
    const basename = path.basename(normalizedPath);
    return { dir, pattern: globToRegex(basename) };
  }

  // Everything before the last `/` before `*` is the directory
  const lastSlash = normalizedPath.lastIndexOf('/', starIndex);
  const dirPart = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash) : '.';
  const patternPart = lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;

  const resolvedDir = path.resolve(workspaceDir, dirPart);
  return { dir: resolvedDir, pattern: globToRegex(patternPart) };
}

// ============================================================================
// EventTriggerManager
// ============================================================================

/**
 * Callback type for when a watch trigger fires.
 */
export type OnTriggerFired = (taskId: string, trigger: WatchTrigger, changedFile: string) => void;

/**
 * Active watcher entry.
 */
interface ActiveWatcher {
  /** fs.FSWatcher instance */
  watcher: fs.FSWatcher;
  /** Watched directory path */
  dir: string;
  /** Filename pattern RegExp */
  pattern: RegExp;
  /** Filter expression (if any) */
  filter?: string;
  /** Debounce timer */
  debounceTimer?: ReturnType<typeof setTimeout>;
  /** Last triggered file path */
  lastTriggeredFile?: string;
}

/**
 * EventTriggerManager options.
 */
export interface EventTriggerManagerOptions {
  /** Base workspace directory for resolving relative watch paths */
  workspaceDir: string;
  /** Callback when a trigger fires */
  onTrigger: OnTriggerFired;
}

/**
 * EventTriggerManager - Manages file watchers for event-driven schedule triggering.
 *
 * Issue #1953: Enables schedules to be triggered by file changes
 * in addition to cron-based timing.
 *
 * Usage:
 * ```typescript
 * const manager = new EventTriggerManager({
 *   workspaceDir: './workspace',
 *   onTrigger: (taskId, trigger, file) => {
 *     console.log(`Task ${taskId} triggered by ${file}`);
 *     scheduler.triggerTask(taskId);
 *   },
 * });
 *
 * // Register a task's watch triggers
 * manager.registerTask('my-task', [{ path: 'chats/*.json', debounce: 5000 }]);
 *
 * // Unregister when task is removed
 * manager.unregisterTask('my-task');
 *
 * // Stop all watchers
 * manager.stop();
 * ```
 */
export class EventTriggerManager {
  private workspaceDir: string;
  private onTrigger: OnTriggerFired;
  /** Map of taskId -> array of active watchers */
  private watchers: Map<string, ActiveWatcher[]> = new Map();

  constructor(options: EventTriggerManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.onTrigger = options.onTrigger;
    logger.info({ workspaceDir: this.workspaceDir }, 'EventTriggerManager initialized');
  }

  /**
   * Register watch triggers for a task.
   * Sets up file watchers for each trigger configuration.
   *
   * @param taskId - Task ID to register watchers for
   * @param triggers - Array of watch trigger configurations
   */
  registerTask(taskId: string, triggers: WatchTrigger[]): void {
    // Remove existing watchers for this task
    this.unregisterTask(taskId);

    if (!triggers || triggers.length === 0) {
      return;
    }

    const watchers: ActiveWatcher[] = [];

    for (const trigger of triggers) {
      const parsed = parseWatchPath(trigger.path, this.workspaceDir);
      if (!parsed) {
        logger.warn({ taskId, path: trigger.path }, 'Invalid watch path, skipping');
        continue;
      }

      const { dir, pattern } = parsed;
      const debounceMs = trigger.debounce ?? 5000;

      try {
        // Ensure watched directory exists
        fs.mkdirSync(dir, { recursive: true });

        // Create ActiveWatcher entry first (needed for debounce state in callback)
        const activeWatcher: ActiveWatcher = {
          watcher: null as unknown as fs.FSWatcher,
          dir,
          pattern,
          filter: trigger.filter,
        };

        activeWatcher.watcher = fs.watch(
          dir,
          { persistent: true, recursive: false },
          (_eventType, filename) => {
            this.handleFileEvent(taskId, trigger, activeWatcher, filename, debounceMs);
          }
        );

        activeWatcher.watcher.on('error', (error) => {
          logger.error({ err: error, taskId, dir }, 'File watcher error');
        });

        watchers.push(activeWatcher);

        logger.info(
          { taskId, dir, pattern: trigger.path, debounce: debounceMs, filter: trigger.filter },
          'Registered watch trigger'
        );

      } catch (error) {
        logger.error({ err: error, taskId, dir }, 'Failed to create file watcher');
      }
    }

    if (watchers.length > 0) {
      this.watchers.set(taskId, watchers);
    }
  }

  /**
   * Unregister all watch triggers for a task.
   *
   * @param taskId - Task ID to unregister
   */
  unregisterTask(taskId: string): void {
    const taskWatchers = this.watchers.get(taskId);
    if (taskWatchers) {
      for (const w of taskWatchers) {
        if (w.debounceTimer) {
          clearTimeout(w.debounceTimer);
        }
        w.watcher.close();
      }
      this.watchers.delete(taskId);
      logger.info({ taskId }, 'Unregistered watch triggers');
    }
  }

  /**
   * Stop all watchers.
   */
  stop(): void {
    for (const [taskId] of this.watchers) {
      this.unregisterTask(taskId);
    }
    this.watchers.clear();
    logger.info('EventTriggerManager stopped');
  }

  /**
   * Check if the manager has any active watchers.
   */
  hasWatchers(): boolean {
    return this.watchers.size > 0;
  }

  /**
   * Get the number of active watchers.
   */
  getWatcherCount(): number {
    let count = 0;
    for (const watchers of this.watchers.values()) {
      count += watchers.length;
    }
    return count;
  }

  /**
   * Get the task IDs that have active watchers.
   */
  getWatchedTaskIds(): string[] {
    return Array.from(this.watchers.keys());
  }

  /**
   * Handle a file system event from a watcher.
   */
  private handleFileEvent(
    taskId: string,
    trigger: WatchTrigger,
    activeWatcher: ActiveWatcher,
    filename: string | null,
    debounceMs: number
  ): void {
    if (!filename) {
      return;
    }

    // Check if filename matches the glob pattern
    if (!activeWatcher.pattern.test(filename)) {
      logger.debug({ taskId, filename, pattern: trigger.path }, 'File does not match watch pattern, ignoring');
      return;
    }

    const filePath = path.join(activeWatcher.dir, filename);
    logger.debug({ taskId, filename, eventType: 'change' }, 'File event matched watch pattern');

    // Clear existing debounce timer
    if (activeWatcher.debounceTimer) {
      clearTimeout(activeWatcher.debounceTimer);
    }

    // Set debounced trigger
    activeWatcher.debounceTimer = setTimeout(async () => {
      activeWatcher.debounceTimer = undefined;

      // Check filter if specified
      if (trigger.filter) {
        const matched = await matchesFilter(filePath, trigger.filter);
        if (!matched) {
          logger.debug(
            { taskId, filePath, filter: trigger.filter },
            'File does not match filter condition, skipping trigger'
          );
          return;
        }
      }

      logger.info(
        { taskId, filePath, trigger: trigger.path },
        'Event trigger fired'
      );

      this.onTrigger(taskId, trigger, filePath);
    }, debounceMs);
  }
}
