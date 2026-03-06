/**
 * Task History Storage - Records task execution history for ETA prediction.
 *
 * Issue #857: Complex Task Auto-Start Task Agent
 *
 * Stores historical task data to improve time estimates.
 * Uses file-based storage for persistence across restarts.
 *
 * @module agents/task-history
 */

import { createLogger } from '../utils/logger.js';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';

/**
 * Get the data directory for task history storage.
 * Uses workspace/data if available, otherwise current directory.
 */
function getDataDir(): string {
  // Use data directory under workspace
  const workspaceDir = process.env.WORKSPACE_DIR || process.cwd();
  return resolve(workspaceDir, 'data', 'task-history');
}

const logger = createLogger('TaskHistory');

/**
 * Single task execution record.
 */
export interface TaskRecord {
  /** Unique task ID */
  taskId: string;
  /** Chat ID where task was executed */
  chatId: string;
  /** Original user message */
  userMessage: string;
  /** Task type classification */
  taskType: string;
  /** Complexity score (1-10) */
  complexityScore: number;
  /** Estimated completion time in seconds */
  estimatedSeconds: number;
  /** Actual completion time in seconds */
  actualSeconds: number;
  /** Whether task completed successfully */
  success: boolean;
  /** Timestamp when task started */
  startedAt: number;
  /** Timestamp when task completed */
  completedAt: number;
  /** Key factors identified during complexity analysis */
  keyFactors: string[];
}

/**
 * Statistics for a task type.
 */
export interface TaskTypeStats {
  /** Task type name */
  taskType: string;
  /** Number of samples */
  sampleCount: number;
  /** Average actual duration in seconds */
  avgDuration: number;
  /** Average estimation error ratio (actual/estimated) */
  avgErrorRatio: number;
  /** Last updated timestamp */
  lastUpdated: number;
}

/**
 * Task history storage class.
 */
export class TaskHistoryStorage {
  private readonly dataDir: string;
  private readonly historyFile: string;
  private readonly statsFile: string;
  private history: TaskRecord[] = [];
  private stats: Map<string, TaskTypeStats> = new Map();
  private initialized = false;
  private savePending = false;

  /** Maximum history records to keep */
  private readonly MAX_HISTORY = 1000;

  /** Minimum samples needed for reliable stats */
  private readonly MIN_SAMPLES = 3;

  constructor() {
    this.dataDir = getDataDir();
    this.historyFile = join(this.dataDir, 'history.json');
    this.statsFile = join(this.dataDir, 'stats.json');
  }

  /**
   * Initialize storage - load existing data from disk.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Ensure directory exists
      await fs.mkdir(this.dataDir, { recursive: true });

      // Load history
      try {
        const historyData = await fs.readFile(this.historyFile, 'utf-8');
        this.history = JSON.parse(historyData);
        logger.info({ recordCount: this.history.length }, 'Loaded task history');
      } catch {
        // File doesn't exist, start fresh
        this.history = [];
        logger.info('No existing task history found, starting fresh');
      }

      // Load stats
      try {
        const statsData = await fs.readFile(this.statsFile, 'utf-8');
        const statsArray: TaskTypeStats[] = JSON.parse(statsData);
        this.stats = new Map(statsArray.map(s => [s.taskType, s]));
        logger.info({ statsCount: this.stats.size }, 'Loaded task stats');
      } catch {
        // File doesn't exist, start fresh
        this.stats = new Map();
        logger.info('No existing task stats found, starting fresh');
      }

      this.initialized = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize task history storage');
      // Continue with empty data
      this.initialized = true;
    }
  }

  /**
   * Record a new task execution.
   */
  async recordTask(record: TaskRecord): Promise<void> {
    await this.ensureInitialized();

    // Add to history
    this.history.push(record);

    // Trim old records if over limit
    if (this.history.length > this.MAX_HISTORY) {
      this.history = this.history.slice(-this.MAX_HISTORY);
    }

    // Update stats
    this.updateStats(record);

    // Save to disk (debounced)
    this.scheduleSave();

    logger.debug({ taskId: record.taskId, taskType: record.taskType }, 'Recorded task execution');
  }

  /**
   * Get historical data for similar tasks.
   */
  async getSimilarTasks(taskType: string, limit = 10): Promise<TaskRecord[]> {
    await this.ensureInitialized();

    return this.history
      .filter(r => r.taskType === taskType)
      .slice(-limit);
  }

  /**
   * Get statistics for a task type.
   */
  async getTaskTypeStats(taskType: string): Promise<TaskTypeStats | undefined> {
    await this.ensureInitialized();

    const stats = this.stats.get(taskType);
    if (stats && stats.sampleCount >= this.MIN_SAMPLES) {
      return stats;
    }
    return undefined;
  }

  /**
   * Get formatted historical data for prompt context.
   */
  async getHistoricalContext(taskType: string): Promise<string> {
    await this.ensureInitialized();

    const stats = await this.getTaskTypeStats(taskType);
    const recentTasks = await this.getSimilarTasks(taskType, 5);

    if (!stats && recentTasks.length === 0) {
      return 'No historical data available for this task type.';
    }

    const lines: string[] = [];

    if (stats) {
      lines.push(`Task Type Statistics (${stats.sampleCount} samples):`);
      lines.push(`- Average Duration: ${Math.round(stats.avgDuration)}s`);
      lines.push(`- Estimation Accuracy: ${Math.round((1 - Math.abs(1 - stats.avgErrorRatio)) * 100)}%`);
    }

    if (recentTasks.length > 0) {
      lines.push('\nRecent Similar Tasks:');
      for (const task of recentTasks.slice(-3)) {
        const status = task.success ? '✓' : '✗';
        lines.push(`- ${status} "${task.userMessage.slice(0, 50)}..." (${task.actualSeconds}s, estimated ${task.estimatedSeconds}s)`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get all task types with sufficient data.
   */
  async getReliableTaskTypes(): Promise<string[]> {
    await this.ensureInitialized();

    const reliableTypes: string[] = [];
    for (const [taskType, stats] of this.stats) {
      if (stats.sampleCount >= this.MIN_SAMPLES) {
        reliableTypes.push(taskType);
      }
    }
    return reliableTypes;
  }

  /**
   * Clear all history data.
   */
  async clear(): Promise<void> {
    this.history = [];
    this.stats.clear();

    try {
      await fs.unlink(this.historyFile).catch(() => {});
      await fs.unlink(this.statsFile).catch(() => {});
      logger.info('Cleared task history');
    } catch (error) {
      logger.error({ err: error }, 'Failed to clear task history files');
    }
  }

  /**
   * Get storage statistics.
   */
  getStats(): { historyCount: number; statsCount: number } {
    return {
      historyCount: this.history.length,
      statsCount: this.stats.size,
    };
  }

  /**
   * Update statistics for a task type.
   */
  private updateStats(record: TaskRecord): void {
    const existing = this.stats.get(record.taskType);

    if (existing) {
      // Incremental average calculation
      const newCount = existing.sampleCount + 1;
      const avgDuration = existing.avgDuration + (record.actualSeconds - existing.avgDuration) / newCount;
      const errorRatio = record.actualSeconds / Math.max(record.estimatedSeconds, 1);
      const avgErrorRatio = existing.avgErrorRatio + (errorRatio - existing.avgErrorRatio) / newCount;

      this.stats.set(record.taskType, {
        taskType: record.taskType,
        sampleCount: newCount,
        avgDuration,
        avgErrorRatio,
        lastUpdated: Date.now(),
      });
    } else {
      this.stats.set(record.taskType, {
        taskType: record.taskType,
        sampleCount: 1,
        avgDuration: record.actualSeconds,
        avgErrorRatio: record.actualSeconds / Math.max(record.estimatedSeconds, 1),
        lastUpdated: Date.now(),
      });
    }
  }

  /**
   * Schedule a save operation (debounced).
   */
  private scheduleSave(): void {
    if (this.savePending) {
      return;
    }

    this.savePending = true;
    setTimeout(() => {
      this.save().catch(err => {
        logger.error({ err }, 'Failed to save task history');
      }).finally(() => {
        this.savePending = false;
      });
    }, 1000);
  }

  /**
   * Save data to disk.
   */
  private async save(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.writeFile(this.historyFile, JSON.stringify(this.history, null, 2));
      await fs.writeFile(this.statsFile, JSON.stringify([...this.stats.values()], null, 2));
      logger.debug('Saved task history to disk');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save task history');
      throw error;
    }
  }

  /**
   * Ensure storage is initialized.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

/**
 * Global task history storage instance.
 */
export const taskHistoryStorage = new TaskHistoryStorage();
