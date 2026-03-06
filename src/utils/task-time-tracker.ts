/**
 * Task Time Tracker - Records and analyzes task execution times.
 *
 * This module supports Issue #857 by:
 * - Recording actual task execution times
 * - Storing task complexity assessments
 * - Providing historical data for better time estimation
 *
 * The goal is to enable self-improvement of time estimates
 * through accumulated experience.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('TaskTimeTracker', {});

/**
 * Task complexity level.
 */
export type ComplexityLevel = 'simple' | 'moderate' | 'complex';

/**
 * Record of a completed task with timing information.
 */
export interface TaskTimeRecord {
  /** Unique identifier */
  id: string;
  /** Brief task description or category */
  taskType: string;
  /** Assessed complexity level */
  complexity: ComplexityLevel;
  /** Estimated time in seconds */
  estimatedSeconds: number;
  /** Actual time in seconds */
  actualSeconds: number;
  /** Creation timestamp */
  createdAt: string;
  /** Task outcome */
  outcome: 'success' | 'partial' | 'failed';
  /** Optional notes about what affected the time */
  notes?: string;
}

/**
 * Aggregated statistics for a task type and complexity.
 */
export interface TaskTimeStats {
  /** Task type */
  taskType: string;
  /** Complexity level */
  complexity: ComplexityLevel;
  /** Number of records */
  count: number;
  /** Average actual time in seconds */
  avgActualSeconds: number;
  /** Average estimation accuracy (actual/estimated) */
  avgAccuracy: number;
  /** Last updated */
  updatedAt: string;
}

/**
 * Tracker for task execution times.
 */
export class TaskTimeTracker {
  private readonly dataFile: string;
  private records: TaskTimeRecord[] = [];
  private stats: Map<string, TaskTimeStats> = new Map();
  private loaded = false;

  constructor(baseDir?: string) {
    const workspaceDir = baseDir || Config.getWorkspaceDir();
    const dataDir = path.join(workspaceDir, 'task-time-records');
    this.dataFile = path.join(dataDir, 'records.json');
  }

  /**
   * Ensure data directory exists and load records.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
      const content = await fs.readFile(this.dataFile, 'utf-8');
      const data = JSON.parse(content);
      this.records = data.records || [];
      this.stats = new Map(
        (data.stats || []).map((s: TaskTimeStats) => [`${s.taskType}:${s.complexity}`, s])
      );
    } catch {
      // File doesn't exist or is invalid, start fresh
      this.records = [];
      this.stats = new Map();
    }

    this.loaded = true;
  }

  /**
   * Save records and stats to disk.
   */
  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
    const data = {
      records: this.records.slice(-100), // Keep last 100 records
      stats: Array.from(this.stats.values()),
    };
    await fs.writeFile(this.dataFile, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Record a completed task.
   *
   * @param taskType - Brief task description/category
   * @param complexity - Assessed complexity level
   * @param estimatedSeconds - Estimated time
   * @param actualSeconds - Actual time taken
   * @param outcome - Task outcome
   * @param notes - Optional notes
   * @returns The created record
   */
  async recordTask(
    taskType: string,
    complexity: ComplexityLevel,
    estimatedSeconds: number,
    actualSeconds: number,
    outcome: 'success' | 'partial' | 'failed' = 'success',
    notes?: string
  ): Promise<TaskTimeRecord> {
    await this.ensureLoaded();

    const record: TaskTimeRecord = {
      id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      taskType,
      complexity,
      estimatedSeconds,
      actualSeconds,
      createdAt: new Date().toISOString(),
      outcome,
      notes,
    };

    this.records.push(record);
    this.updateStats(record);
    await this.save();

    logger.info(
      { taskType, complexity, estimated: estimatedSeconds, actual: actualSeconds },
      'Task time recorded'
    );

    return record;
  }

  /**
   * Update statistics after recording a task.
   */
  private updateStats(record: TaskTimeRecord): void {
    const key = `${record.taskType}:${record.complexity}`;
    const existing = this.stats.get(key);

    if (existing) {
      // Update existing stats with moving average
      const newCount = existing.count + 1;
      existing.avgActualSeconds =
        (existing.avgActualSeconds * existing.count + record.actualSeconds) / newCount;
      const accuracy = record.actualSeconds / Math.max(record.estimatedSeconds, 1);
      existing.avgAccuracy = (existing.avgAccuracy * existing.count + accuracy) / newCount;
      existing.count = newCount;
      existing.updatedAt = new Date().toISOString();
    } else {
      // Create new stats entry
      this.stats.set(key, {
        taskType: record.taskType,
        complexity: record.complexity,
        count: 1,
        avgActualSeconds: record.actualSeconds,
        avgAccuracy: record.actualSeconds / Math.max(record.estimatedSeconds, 1),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Get time estimate guidance based on historical data.
   *
   * @returns Guidance string for time estimation
   */
  async getEstimationGuidance(): Promise<string> {
    await this.ensureLoaded();

    if (this.stats.size === 0) {
      // No historical data, return default guidance
      return this.getDefaultGuidance();
    }

    // Build guidance from stats
    const lines: string[] = ['### Historical Time Reference (from your past tasks)'];
    const groupedByComplexity: Record<ComplexityLevel, TaskTimeStats[]> = {
      simple: [],
      moderate: [],
      complex: [],
    };

    for (const stat of this.stats.values()) {
      groupedByComplexity[stat.complexity].push(stat);
    }

    for (const [complexity, statList] of Object.entries(groupedByComplexity)) {
      if (statList.length > 0) {
        const avgTime = Math.round(
          statList.reduce((sum, s) => sum + s.avgActualSeconds, 0) / statList.length
        );
        lines.push(`- **${complexity.charAt(0).toUpperCase() + complexity.slice(1)}** tasks: avg ~${this.formatTime(avgTime)}`);
      }
    }

    lines.push('');
    lines.push('Use these as reference points. Adjust based on specific task characteristics.');

    return lines.join('\n');
  }

  /**
   * Get default guidance when no historical data exists.
   */
  private getDefaultGuidance(): string {
    return `### Time Estimation Reference (defaults)
- **Simple** tasks (quick questions, lookups): ~30 seconds
- **Moderate** tasks (code review, analysis): ~2-5 minutes
- **Complex** tasks (multi-file changes, refactoring): ~10-30 minutes

Note: These are rough estimates. Your actual times may vary.`;
  }

  /**
   * Format seconds into human-readable time.
   */
  private formatTime(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}s`;
    } else if (seconds < 3600) {
      const mins = Math.round(seconds / 60);
      return `${mins}min`;
    } else {
      const hours = Math.round(seconds / 3600);
      return `${hours}h`;
    }
  }

  /**
   * Get recent records for analysis.
   *
   * @param limit - Maximum number of records to return
   * @returns Recent task records
   */
  async getRecentRecords(limit: number = 20): Promise<TaskTimeRecord[]> {
    await this.ensureLoaded();
    return this.records.slice(-limit);
  }

  /**
   * Get estimation accuracy summary.
   *
   * @returns Summary of estimation accuracy by complexity
   */
  async getAccuracySummary(): Promise<Record<ComplexityLevel, { count: number; avgAccuracy: number }>> {
    await this.ensureLoaded();

    const summary: Record<ComplexityLevel, { count: number; totalAccuracy: number; avgAccuracy: number }> = {
      simple: { count: 0, totalAccuracy: 0, avgAccuracy: 1 },
      moderate: { count: 0, totalAccuracy: 0, avgAccuracy: 1 },
      complex: { count: 0, totalAccuracy: 0, avgAccuracy: 1 },
    };

    for (const stat of this.stats.values()) {
      const entry = summary[stat.complexity];
      entry.count += stat.count;
      entry.totalAccuracy += stat.avgAccuracy * stat.count;
    }

    for (const [, value] of Object.entries(summary)) {
      if (value.count > 0) {
        value.avgAccuracy = value.totalAccuracy / value.count;
      }
    }

    return {
      simple: { count: summary.simple.count, avgAccuracy: summary.simple.avgAccuracy },
      moderate: { count: summary.moderate.count, avgAccuracy: summary.moderate.avgAccuracy },
      complex: { count: summary.complex.count, avgAccuracy: summary.complex.avgAccuracy },
    };
  }
}

// Singleton instance
let taskTimeTrackerInstance: TaskTimeTracker | undefined;

/**
 * Get the global TaskTimeTracker instance.
 */
export function getTaskTimeTracker(): TaskTimeTracker {
  if (!taskTimeTrackerInstance) {
    taskTimeTrackerInstance = new TaskTimeTracker();
  }
  return taskTimeTrackerInstance;
}

/**
 * Reset the global TaskTimeTracker (for testing).
 */
export function resetTaskTimeTracker(): void {
  taskTimeTrackerInstance = undefined;
}
