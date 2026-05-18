/**
 * TaskHistory - Records completed task metrics for learning and estimation.
 *
 * Stores task completion records in a JSON file so the agent can learn from
 * past executions to provide better time estimates in the future.
 *
 * Issue #857: Owner requested recording past task processing records
 * and periodically summarizing time estimation experience.
 *
 * @module task/task-history
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskHistory');

/**
 * A single completed task record.
 */
export interface TaskHistoryEntry {
  /** Task identifier */
  taskId: string;
  /** Task description or title */
  description: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Number of tool calls made */
  toolCallCount: number;
  /** Number of steps completed */
  stepCount: number;
  /** Whether the task succeeded */
  success: boolean;
  /** Completion timestamp */
  completedAt: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Summary statistics derived from task history.
 */
export interface TaskHistorySummary {
  /** Total tasks recorded */
  totalTasks: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Average duration of successful tasks (ms) */
  avgDurationMs: number;
  /** Average tool calls per task */
  avgToolCalls: number;
  /** Average steps per task */
  avgSteps: number;
}

const MAX_HISTORY_SIZE = 100;
const HISTORY_FILENAME = 'task-history.json';

/**
 * TaskHistory manages a JSON file of completed task records.
 */
export class TaskHistory {
  private readonly historyPath: string;
  private cache?: TaskHistoryEntry[];

  constructor(workspaceDir: string) {
    this.historyPath = path.join(workspaceDir, HISTORY_FILENAME);
  }

  /**
   * Append a completed task record.
   */
  async record(entry: TaskHistoryEntry): Promise<void> {
    const history = await this.load();
    history.push(entry);

    // Keep only the most recent entries
    if (history.length > MAX_HISTORY_SIZE) {
      history.splice(0, history.length - MAX_HISTORY_SIZE);
    }

    await this.save(history);
    this.cache = history;

    logger.info({
      taskId: entry.taskId,
      durationMs: entry.durationMs,
      success: entry.success,
    }, 'Task history recorded');
  }

  /**
   * Get summary statistics from recorded task history.
   */
  async getSummary(): Promise<TaskHistorySummary> {
    const history = await this.load();
    const successful = history.filter(e => e.success);
    const total = history.length;

    if (total === 0) {
      return {
        totalTasks: 0,
        successRate: 0,
        avgDurationMs: 0,
        avgToolCalls: 0,
        avgSteps: 0,
      };
    }

    return {
      totalTasks: total,
      successRate: successful.length / total,
      avgDurationMs: successful.length > 0
        ? Math.round(successful.reduce((sum, e) => sum + e.durationMs, 0) / successful.length)
        : 0,
      avgToolCalls: Math.round(history.reduce((sum, e) => sum + e.toolCallCount, 0) / total),
      avgSteps: Math.round(history.reduce((sum, e) => sum + e.stepCount, 0) / total),
    };
  }

  /**
   * Format the summary as a human-readable string for the agent.
   */
  async getSummaryText(): Promise<string> {
    const summary = await this.getSummary();
    if (summary.totalTasks === 0) {
      return 'No past task records available.';
    }

    const avgDurationMin = (summary.avgDurationMs / 60000).toFixed(1);
    return [
      `Past task statistics (${summary.totalTasks} tasks):`,
      `- Success rate: ${(summary.successRate * 100).toFixed(0)}%`,
      `- Average duration: ${avgDurationMin} minutes`,
      `- Average tool calls: ${summary.avgToolCalls}`,
      `- Average steps: ${summary.avgSteps}`,
    ].join('\n');
  }

  /**
   * Get recent task entries (most recent first).
   */
  async getRecent(count: number = 10): Promise<TaskHistoryEntry[]> {
    const history = await this.load();
    return history.slice(-count).reverse();
  }

  /**
   * Load history from disk (with in-memory cache).
   */
  private async load(): Promise<TaskHistoryEntry[]> {
    if (this.cache) {return this.cache;}

    try {
      const data = await fs.readFile(this.historyPath, 'utf-8');
      const parsed: TaskHistoryEntry[] = JSON.parse(data);
      this.cache = parsed;
      return parsed;
    } catch {
      this.cache = [];
      return [];
    }
  }

  /**
   * Save history to disk.
   */
  private async save(history: TaskHistoryEntry[]): Promise<void> {
    await fs.writeFile(this.historyPath, JSON.stringify(history, null, 2), 'utf-8');
  }
}
