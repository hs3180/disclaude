/**
 * TaskRecordManager - Markdown-based task execution records.
 *
 * Implements Phase 1 of Issue #1234: Task ETA estimation system.
 *
 * Stores task execution records in a single `.claude/task-records.md` file
 * using free-form Markdown format. Each record captures:
 * - Task type (bugfix, feature, refactoring, etc.)
 * - Estimated time and estimation basis
 * - Actual execution time
 * - Review / retrospective notes
 *
 * Design Principles:
 * - Markdown as data: unstructured, human-readable, LLM-friendly
 * - Append-only: new records are appended to the end of the file
 * - Portable: works across projects via `.claude/task-records.md`
 *
 * @module task/task-records
 */

import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskRecordManager');

/**
 * Task type classification.
 */
export type TaskType = 'bugfix' | 'feature' | 'refactoring' | 'research' | 'test' | 'docs' | 'chore';

/**
 * A single task execution record.
 */
export interface TaskRecord {
  /** Brief description of the task */
  title: string;
  /** Task classification */
  type: TaskType;
  /** Estimated duration (human-readable string, e.g. "30分钟", "1小时") */
  estimatedTime: string;
  /** Reasoning behind the estimate */
  estimationBasis: string;
  /** Actual duration (human-readable string) */
  actualTime: string;
  /** Retrospective review of the estimation */
  review: string;
  /** Date string in YYYY-MM-DD format */
  date: string;
}

/**
 * Parsed task record with additional metadata from parsing.
 */
export interface ParsedTaskRecord extends TaskRecord {
  /** Raw markdown content of the section */
  rawSection: string;
}

/**
 * Options for TaskRecordManager.
 */
export interface TaskRecordManagerOptions {
  /** Base directory containing `.claude/` folder */
  baseDir: string;
  /** Filename for task records (default: 'task-records.md') */
  filename?: string;
}

/**
 * TaskRecordManager manages a Markdown file of task execution records.
 *
 * File location: `{baseDir}/.claude/task-records.md`
 *
 * Each record is a `##` section following this format:
 * ```markdown
 * ## YYYY-MM-DD Task Title
 *
 * - **类型**: bugfix
 * - **估计时间**: 30分钟
 * - **估计依据**: Similar to previous fix
 * - **实际时间**: 45分钟
 * - **复盘**: Underestimated complexity
 * ```
 */
export class TaskRecordManager {
  private readonly filePath: string;

  constructor(options: TaskRecordManagerOptions) {
    const claudeDir = path.join(options.baseDir, '.claude');
    this.filePath = path.join(claudeDir, options.filename ?? 'task-records.md');
  }

  /**
   * Get the file path for task records.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Append a task record to the file.
   * Creates the file with a header if it doesn't exist.
   *
   * @param record - Task record to append
   */
  async appendRecord(record: TaskRecord): Promise<void> {
    await this.ensureFile();
    const section = this.formatRecord(record);
    try {
      await fs.appendFile(this.filePath, section, 'utf-8');
      logger.debug({ title: record.title, date: record.date }, 'Task record appended');
    } catch (error) {
      logger.error({ err: error }, 'Failed to append task record');
      throw error;
    }
  }

  /**
   * Append a task record synchronously.
   * Use when process may terminate before async write completes.
   *
   * @param record - Task record to append
   */
  appendRecordSync(record: TaskRecord): void {
    this.ensureFileSync();
    const section = this.formatRecord(record);
    try {
      syncFs.appendFileSync(this.filePath, section, 'utf-8');
    } catch (error) {
      logger.error({ err: error }, 'Failed to append task record (sync)');
      throw error;
    }
  }

  /**
   * Read all task records from the file.
   *
   * @returns Array of parsed task records (newest first)
   */
  async readRecords(): Promise<ParsedTaskRecord[]> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      return this.parseRecords(content);
    } catch (error) {
      // File doesn't exist yet — return empty
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Search records by keyword in any field.
   *
   * @param query - Search query (case-insensitive)
   * @returns Matching records
   */
  async searchRecords(query: string): Promise<ParsedTaskRecord[]> {
    const records = await this.readRecords();
    const lowerQuery = query.toLowerCase();
    return records.filter(r =>
      r.title.toLowerCase().includes(lowerQuery) ||
      r.type.toLowerCase().includes(lowerQuery) ||
      r.estimatedTime.toLowerCase().includes(lowerQuery) ||
      r.estimationBasis.toLowerCase().includes(lowerQuery) ||
      r.actualTime.toLowerCase().includes(lowerQuery) ||
      r.review.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Get records filtered by task type.
   *
   * @param type - Task type to filter by
   * @returns Matching records
   */
  async getRecordsByType(type: TaskType): Promise<ParsedTaskRecord[]> {
    const records = await this.readRecords();
    return records.filter(r => r.type === type);
  }

  /**
   * Check if the task records file exists.
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Format a task record as a Markdown section.
   */
  private formatRecord(record: TaskRecord): string {
    return `\n## ${record.date} ${record.title}\n\n` +
      `- **类型**: ${record.type}\n` +
      `- **估计时间**: ${record.estimatedTime}\n` +
      `- **估计依据**: ${record.estimationBasis}\n` +
      `- **实际时间**: ${record.actualTime}\n` +
      `- **复盘**: ${record.review}\n`;
  }

  /**
   * Parse all task records from file content.
   */
  private parseRecords(content: string): ParsedTaskRecord[] {
    const records: ParsedTaskRecord[] = [];

    // Split on ## headings (level-2 sections)
    const sections = content.split(/\n(?=## )/);

    for (const section of sections) {
      const parsed = this.parseSection(section);
      if (parsed) {
        records.push(parsed);
      }
    }

    // Return newest first
    return records.reverse();
  }

  /**
   * Parse a single ## section into a TaskRecord.
   */
  private parseSection(section: string): ParsedTaskRecord | null {
    // Match: ## YYYY-MM-DD Title
    const headerMatch = section.match(/^## (\d{4}-\d{2}-\d{2}) (.+)/);
    if (!headerMatch) {return null;}

    const [, date, rawTitle] = headerMatch;
    const title = rawTitle.trim();

    const type = this.extractField(section, '类型');
    const estimatedTime = this.extractField(section, '估计时间');
    const estimationBasis = this.extractField(section, '估计依据');
    const actualTime = this.extractField(section, '实际时间');
    const review = this.extractField(section, '复盘');

    // Validate required fields
    if (!type || !estimatedTime || !actualTime) {return null;}

    return {
      title,
      type: type as TaskType,
      estimatedTime,
      estimationBasis: estimationBasis ?? '',
      actualTime,
      review: review ?? '',
      date,
      rawSection: section.trim(),
    };
  }

  /**
   * Extract a field value from a Markdown section.
   * Matches patterns like: - **字段名**: value
   */
  private extractField(section: string, fieldName: string): string | null {
    const regex = new RegExp(`- \\*\\*${fieldName}\\*\\*: (.+)`, 'u');
    const match = section.match(regex);
    return match ? match[1].trim() : null;
  }

  /**
   * Ensure the file and parent directories exist.
   */
  private async ensureFile(): Promise<void> {
    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    try {
      await fs.access(this.filePath);
    } catch {
      // File doesn't exist — create with header
      await fs.writeFile(this.filePath, '# 任务记录\n', 'utf-8');
    }
  }

  /**
   * Ensure the file and parent directories exist (synchronous).
   */
  private ensureFileSync(): void {
    const dir = path.dirname(this.filePath);
    if (!syncFs.existsSync(dir)) {
      syncFs.mkdirSync(dir, { recursive: true });
    }
    if (!syncFs.existsSync(this.filePath)) {
      syncFs.writeFileSync(this.filePath, '# 任务记录\n', 'utf-8');
    }
  }
}
