/**
 * ETA Task Records - Markdown-based task execution records for ETA estimation.
 *
 * Issue #1234: Task ETA Estimation System
 *
 * Key Design Principle: Uses UNSTRUCTURED Markdown storage instead of structured data.
 * This allows:
 * - Free-form task records with full reasoning process
 * - Evolution of recording format over time
 * - Easy human review and manual editing
 *
 * @module agents/eta-records
 */

import { createLogger } from '../utils/logger.js';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';

const logger = createLogger('ETARecords');

/**
 * Task record for ETA estimation.
 */
export interface ETATaskRecord {
  /** Date string (YYYY-MM-DD) */
  date: string;
  /** Task title/description */
  title: string;
  /** Task type classification */
  taskType: string;
  /** Estimated time (human readable, e.g., "30分钟") */
  estimatedTime: string;
  /** Estimated time in seconds */
  estimatedSeconds: number;
  /** Reasoning behind the estimate */
  estimationBasis: string;
  /** Actual execution time (human readable) */
  actualTime: string;
  /** Actual time in seconds */
  actualSeconds: number;
  /** Post-task reflection/lessons learned */
  review: string;
  /** Whether task completed successfully */
  success: boolean;
}

/**
 * ETA Task Records Manager.
 *
 * Manages task records in Markdown format for ETA estimation.
 */
export class ETATaskRecords {
  private readonly recordsFile: string;
  private initialized = false;

  constructor(workspaceDir?: string) {
    const workspace = workspaceDir || process.env.WORKSPACE_DIR || process.cwd();
    this.recordsFile = resolve(workspace, '.claude', 'task-records.md');
  }

  /**
   * Initialize the records file if it doesn't exist.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const dir = resolve(this.recordsFile, '..');
      await fs.mkdir(dir, { recursive: true });

      // Check if file exists, if not create with header
      try {
        await fs.access(this.recordsFile);
        logger.debug('Task records file exists');
      } catch {
        // Create new file with header
        const header = `# 任务记录

此文件记录任务执行历史，用于 ETA 预估系统的学习和改进。

## 记录格式

每个任务记录包含：
- 类型：任务分类
- 估计时间：预计完成时间
- 估计依据：推理过程
- 实际时间：真实执行时间
- 复盘：经验教训

---

`;
        await fs.writeFile(this.recordsFile, header, 'utf-8');
        logger.info('Created new task records file');
      }

      this.initialized = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize task records');
      throw error;
    }
  }

  /**
   * Record a completed task.
   *
   * Appends a new task record to the Markdown file.
   */
  async recordTask(record: ETATaskRecord): Promise<void> {
    await this.ensureInitialized();

    const entry = this.formatTaskEntry(record);

    try {
      await fs.appendFile(this.recordsFile, entry, 'utf-8');
      logger.info({ title: record.title, date: record.date }, 'Recorded task execution');
    } catch (error) {
      logger.error({ err: error }, 'Failed to record task');
      throw error;
    }
  }

  /**
   * Read all task records from the Markdown file.
   */
  async readRecords(): Promise<string> {
    await this.ensureInitialized();

    try {
      const content = await fs.readFile(this.recordsFile, 'utf-8');
      return content;
    } catch (error) {
      logger.error({ err: error }, 'Failed to read task records');
      throw error;
    }
  }

  /**
   * Search for similar tasks by keywords.
   *
   * Returns task entries that contain any of the keywords.
   */
  async findSimilarTasks(keywords: string[], limit = 5): Promise<ETATaskRecord[]> {
    await this.ensureInitialized();

    try {
      const content = await fs.readFile(this.recordsFile, 'utf-8');
      const entries = this.parseTaskEntries(content);

      // Score each entry by keyword matches
      const scored = entries.map(entry => {
        const text = `${entry.title} ${entry.taskType} ${entry.estimationBasis} ${entry.review}`.toLowerCase();
        const score = keywords.reduce((acc, kw) => {
          return acc + (text.includes(kw.toLowerCase()) ? 1 : 0);
        }, 0);
        return { entry, score };
      });

      // Filter and sort by score
      return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(s => s.entry);
    } catch (error) {
      logger.error({ err: error }, 'Failed to find similar tasks');
      return [];
    }
  }

  /**
   * Get recent task records.
   */
  async getRecentTasks(limit = 10): Promise<ETATaskRecord[]> {
    await this.ensureInitialized();

    try {
      const content = await fs.readFile(this.recordsFile, 'utf-8');
      const entries = this.parseTaskEntries(content);
      return entries.slice(-limit);
    } catch (error) {
      logger.error({ err: error }, 'Failed to get recent tasks');
      return [];
    }
  }

  /**
   * Get tasks by type.
   */
  async getTasksByType(taskType: string, limit = 10): Promise<ETATaskRecord[]> {
    await this.ensureInitialized();

    try {
      const content = await fs.readFile(this.recordsFile, 'utf-8');
      const entries = this.parseTaskEntries(content);
      return entries
        .filter(e => e.taskType.toLowerCase() === taskType.toLowerCase())
        .slice(-limit);
    } catch (error) {
      logger.error({ err: error }, 'Failed to get tasks by type');
      return [];
    }
  }

  /**
   * Format a task record as Markdown entry.
   */
  private formatTaskEntry(record: ETATaskRecord): string {
    const successIcon = record.success ? '✅' : '❌';
    const accuracyRatio = record.estimatedSeconds > 0
      ? (record.actualSeconds / record.estimatedSeconds).toFixed(2)
      : 'N/A';
    const accuracyEmoji = parseFloat(accuracyRatio) >= 0.8 && parseFloat(accuracyRatio) <= 1.2 ? '🎯' :
                          parseFloat(accuracyRatio) < 1 ? '⏱️' : '⌛';

    return `
## ${record.date} ${record.title}

- **类型**: ${record.taskType}
- **估计时间**: ${record.estimatedTime}
- **估计依据**: ${record.estimationBasis}
- **实际时间**: ${record.actualTime}
- **准确度**: ${accuracyEmoji} ${accuracyRatio}x
- **状态**: ${successIcon}
- **复盘**: ${record.review}

---
`;
  }

  /**
   * Parse task entries from Markdown content.
   */
  private parseTaskEntries(content: string): ETATaskRecord[] {
    const entries: ETATaskRecord[] = [];

    // Split by task headers (## YYYY-MM-DD)
    const taskPattern = /## (\d{4}-\d{2}-\d{2}) (.+?)(?=\n## |\n*$)/gs;
    let match;

    while ((match = taskPattern.exec(content)) !== null) {
      const date = match[1];
      const title = match[2].trim();
      const body = match[0];

      // Extract fields from the body
      const typeMatch = body.match(/\*\*类型\*\*:\s*(.+)/);
      const estimatedMatch = body.match(/\*\*估计时间\*\*:\s*(.+)/);
      const basisMatch = body.match(/\*\*估计依据\*\*:\s*(.+)/);
      const actualMatch = body.match(/\*\*实际时间\*\*:\s*(.+)/);
      const statusMatch = body.match(/\*\*状态\*\*:\s*(.+)/);
      const reviewMatch = body.match(/\*\*复盘\*\*:\s*(.+)/);

      if (typeMatch && estimatedMatch && actualMatch) {
        entries.push({
          date,
          title,
          taskType: typeMatch[1].trim(),
          estimatedTime: estimatedMatch[1].trim(),
          estimatedSeconds: this.parseTimeToSeconds(estimatedMatch[1].trim()),
          estimationBasis: basisMatch?.[1].trim() || '',
          actualTime: actualMatch[1].trim(),
          actualSeconds: this.parseTimeToSeconds(actualMatch[1].trim()),
          review: reviewMatch?.[1].trim() || '',
          success: statusMatch?.[1].includes('✅') ?? true,
        });
      }
    }

    return entries;
  }

  /**
   * Parse human-readable time to seconds.
   */
  private parseTimeToSeconds(timeStr: string): number {
    // Handle formats like "30分钟", "1小时", "1小时30分钟", "45秒"
    let seconds = 0;

    const hourMatch = timeStr.match(/(\d+)\s*小时/);
    const minMatch = timeStr.match(/(\d+)\s*分钟/);
    const secMatch = timeStr.match(/(\d+)\s*秒/);

    if (hourMatch) {
      seconds += parseInt(hourMatch[1], 10) * 3600;
    }
    if (minMatch) {
      seconds += parseInt(minMatch[1], 10) * 60;
    }
    if (secMatch) {
      seconds += parseInt(secMatch[1], 10);
    }

    // If no matches, try to parse as number (assume minutes)
    if (seconds === 0) {
      const numMatch = timeStr.match(/(\d+)/);
      if (numMatch) {
        seconds = parseInt(numMatch[1], 10) * 60;
      }
    }

    return seconds;
  }

  /**
   * Ensure storage is initialized.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Get the file path for debugging.
   */
  getFilePath(): string {
    return this.recordsFile;
  }
}

/**
 * Global ETA task records instance.
 */
export const etaTaskRecords = new ETATaskRecords();
