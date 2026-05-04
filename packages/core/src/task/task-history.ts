/**
 * TaskHistory - Records and queries completed task execution history.
 *
 * Stores metadata about completed tasks in a JSON file, enabling:
 * - ETA estimation based on past similar tasks
 * - Task execution pattern analysis
 * - Historical progress tracking
 *
 * This module provides the data foundation for the prompt-based
 * ETA estimation system requested in Issue #857.
 *
 * The Agent can query task history to estimate how long a new task
 * might take, based on past similar tasks. The estimation is done
 * via prompt (not algorithmic scoring), following the owner's design.
 *
 * Storage format (task-history.json):
 * ```json
 * {
 *   "version": 1,
 *   "entries": [
 *     {
 *       "taskId": "cli-1234567890",
 *       "title": "Fix integration test timeout",
 *       "category": "bug-fix",
 *       "createdAt": "2026-05-01T10:00:00Z",
 *       "completedAt": "2026-05-01T10:15:30Z",
 *       "durationMs": 930000,
 *       "iterations": 3,
 *       "outcome": "success",
 *       "tags": ["test", "integration"]
 *     }
 *   ]
 * }
 * ```
 *
 * @module task/task-history
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskHistory');

/**
 * A single task history entry.
 */
export interface TaskHistoryEntry {
  /** Task identifier */
  taskId: string;
  /** Task title */
  title: string;
  /** Task category (e.g., 'bug-fix', 'feature', 'test', 'refactor') */
  category: string;
  /** ISO 8601 timestamp when the task was created */
  createdAt: string;
  /** ISO 8601 timestamp when the task completed */
  completedAt: string;
  /** Total execution duration in milliseconds */
  durationMs: number;
  /** Number of evaluator-executor iterations */
  iterations: number;
  /** Task outcome */
  outcome: 'success' | 'failed';
  /** Optional tags for categorization */
  tags?: string[];
}

/**
 * Aggregate statistics for a set of tasks.
 */
export interface TaskHistoryStats {
  /** Number of tasks in the sample */
  count: number;
  /** Average duration in milliseconds */
  averageDurationMs: number;
  /** Median duration in milliseconds */
  medianDurationMs: number;
  /** Minimum duration in milliseconds */
  minDurationMs: number;
  /** Maximum duration in milliseconds */
  maxDurationMs: number;
  /** Success rate (0-1) */
  successRate: number;
}

/**
 * Task history file format.
 */
interface TaskHistoryFile {
  version: number;
  entries: TaskHistoryEntry[];
}

/**
 * Options for querying task history.
 */
export interface TaskHistoryQueryOptions {
  /** Filter by category */
  category?: string;
  /** Filter by outcome */
  outcome?: 'success' | 'failed';
  /** Filter by tags (matches any) */
  tags?: string[];
  /** Maximum number of entries to return */
  limit?: number;
  /** Only include entries after this date */
  since?: string;
}

/**
 * TaskHistory - Records and queries completed task execution history.
 *
 * Stores task execution metadata in a JSON file for ETA estimation
 * and pattern analysis.
 *
 * @example
 * ```typescript
 * const history = new TaskHistory({ workspaceDir: '/path/to/workspace' });
 *
 * // Record a completed task
 * await history.recordTask({
 *   taskId: 'cli-123',
 *   title: 'Fix timeout issue',
 *   category: 'bug-fix',
 *   createdAt: '2026-05-01T10:00:00Z',
 *   completedAt: '2026-05-01T10:15:30Z',
 *   durationMs: 930000,
 *   iterations: 3,
 *   outcome: 'success',
 * });
 *
 * // Get statistics for similar tasks
 * const stats = await history.getStats({ category: 'bug-fix' });
 * console.log(`Average: ${stats.averageDurationMs / 60000} min`);
 *
 * // Get recent history for ETA estimation context
 * const recent = await history.query({ limit: 10 });
 * ```
 */
export class TaskHistory {
  private readonly historyFilePath: string;
  private cache: TaskHistoryFile | null = null;

  /**
   * Create a TaskHistory instance.
   *
   * @param config - Configuration
   * @param config.workspaceDir - Path to the workspace directory
   */
  constructor(config: { workspaceDir: string }) {
    this.historyFilePath = path.join(config.workspaceDir, 'task-history.json');
  }

  /**
   * Record a completed task in the history.
   *
   * @param entry - Task history entry to record
   */
  async recordTask(entry: TaskHistoryEntry): Promise<void> {
    const history = await this.readHistory();

    // Remove any existing entry with the same taskId (update case)
    history.entries = history.entries.filter(e => e.taskId !== entry.taskId);

    // Add the new entry
    history.entries.push(entry);

    // Keep only the last 500 entries to prevent unbounded growth
    if (history.entries.length > 500) {
      history.entries = history.entries.slice(-500);
    }

    await this.writeHistory(history);
    this.cache = history;

    logger.debug({ taskId: entry.taskId, category: entry.category }, 'Task recorded in history');
  }

  /**
   * Query task history with optional filters.
   *
   * @param options - Query options
   * @returns Array of matching history entries (most recent first)
   */
  async query(options?: TaskHistoryQueryOptions): Promise<TaskHistoryEntry[]> {
    const history = await this.readHistory();

    let entries = [...history.entries];

    // Apply filters
    if (options?.category) {
      entries = entries.filter(e => e.category === options.category);
    }

    if (options?.outcome) {
      entries = entries.filter(e => e.outcome === options.outcome);
    }

    if (options?.tags && options.tags.length > 0) {
      const filterTags = options.tags;
      entries = entries.filter(e =>
        e.tags?.some(tag => filterTags.includes(tag))
      );
    }

    if (options?.since) {
      const sinceDate = new Date(options.since);
      entries = entries.filter(e => new Date(e.completedAt) >= sinceDate);
    }

    // Sort by completion time (most recent first)
    entries.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());

    // Apply limit
    if (options?.limit) {
      entries = entries.slice(0, options.limit);
    }

    return entries;
  }

  /**
   * Get aggregate statistics for tasks matching the query.
   *
   * @param options - Query options to filter tasks
   * @returns Statistics, or null if no matching tasks
   */
  async getStats(options?: TaskHistoryQueryOptions): Promise<TaskHistoryStats | null> {
    const entries = await this.query(options);

    if (entries.length === 0) {
      return null;
    }

    const durations = entries.map(e => e.durationMs).sort((a, b) => a - b);
    const successCount = entries.filter(e => e.outcome === 'success').length;

    return {
      count: entries.length,
      averageDurationMs: Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length),
      medianDurationMs: this.median(durations),
      minDurationMs: durations[0],
      maxDurationMs: durations[durations.length - 1],
      successRate: successCount / entries.length,
    };
  }

  /**
   * Get a formatted summary of recent task history.
   * Useful for injecting into Agent prompts for ETA estimation.
   *
   * @param options - Query options
   * @returns Formatted markdown summary
   */
  async getFormattedSummary(options?: TaskHistoryQueryOptions): Promise<string> {
    const entries = await this.query({ ...options, limit: options?.limit ?? 10 });
    const stats = await this.getStats(options);

    if (entries.length === 0) {
      return 'No task history available.';
    }

    const lines: string[] = [
      `### Task History (${entries.length} tasks)`,
    ];

    if (stats) {
      lines.push('');
      lines.push('| Metric | Value |');
      lines.push('|--------|-------|');
      lines.push(`| Average duration | ${this.formatDuration(stats.averageDurationMs)} |`);
      lines.push(`| Median duration | ${this.formatDuration(stats.medianDurationMs)} |`);
      lines.push(`| Range | ${this.formatDuration(stats.minDurationMs)} ~ ${this.formatDuration(stats.maxDurationMs)} |`);
      lines.push(`| Success rate | ${(stats.successRate * 100).toFixed(0)}% |`);
    }

    lines.push('');
    lines.push('**Recent tasks:**');
    for (const entry of entries.slice(0, 5)) {
      const duration = this.formatDuration(entry.durationMs);
      const icon = entry.outcome === 'success' ? '✅' : '❌';
      lines.push(`- ${icon} ${entry.title} (${entry.category}, ${duration}, ${entry.iterations} iterations)`);
    }

    return lines.join('\n');
  }

  /**
   * Get a specific task's history entry.
   *
   * @param taskId - Task identifier
   * @returns History entry, or null if not found
   */
  async getTask(taskId: string): Promise<TaskHistoryEntry | null> {
    const history = await this.readHistory();
    return history.entries.find(e => e.taskId === taskId) ?? null;
  }

  /**
   * Clear all task history.
   */
  async clear(): Promise<void> {
    this.cache = null;
    try {
      await fs.unlink(this.historyFilePath);
      logger.info('Task history cleared');
    } catch {
      // File doesn't exist
    }
  }

  // ===== Private Methods =====

  /**
   * Read the history file.
   * Returns a default empty structure if the file doesn't exist.
   */
  private async readHistory(): Promise<TaskHistoryFile> {
    if (this.cache) {
      return { ...this.cache, entries: [...this.cache.entries] };
    }

    try {
      const content = await fs.readFile(this.historyFilePath, 'utf-8');
      const data = JSON.parse(content) as TaskHistoryFile;

      // Validate version
      if (data.version !== 1) {
        logger.warn({ version: data.version }, 'Unknown history file version, resetting');
        return { version: 1, entries: [] };
      }

      this.cache = data;
      return { ...data, entries: [...data.entries] };
    } catch {
      // File doesn't exist or is invalid
      return { version: 1, entries: [] };
    }
  }

  /**
   * Write the history file.
   */
  private async writeHistory(history: TaskHistoryFile): Promise<void> {
    const dir = path.dirname(this.historyFilePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    await fs.writeFile(this.historyFilePath, JSON.stringify(history, null, 2), 'utf-8');
  }

  /**
   * Calculate the median of a sorted array of numbers.
   */
  private median(sorted: number[]): number {
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    }
    return sorted[mid];
  }

  /**
   * Format a duration in milliseconds to a human-readable string.
   */
  private formatDuration(ms: number): string {
    if (ms < 60000) {
      return `${Math.round(ms / 1000)}s`;
    }
    if (ms < 3600000) {
      return `${(ms / 60000).toFixed(1)}min`;
    }
    return `${(ms / 3600000).toFixed(1)}h`;
  }
}
