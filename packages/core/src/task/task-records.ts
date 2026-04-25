/**
 * TaskRecords — Markdown-based task execution record system.
 *
 * Provides non-structured Markdown storage for task execution history,
 * enabling ETA estimation through historical pattern analysis.
 *
 * Design Principles (from Issue #1234):
 * - Markdown as the ONLY storage format — no structured data
 * - Records include estimation reasoning, not just numbers
 * - Each record contains: estimated time, actual time, review notes
 * - Storage location: `.claude/task-records.md` (configurable)
 *
 * @module task/task-records
 */

import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskRecords');

/**
 * Task record entry for creating a new record.
 * All fields are strings to maintain the non-structured Markdown philosophy.
 */
export interface TaskRecordEntry {
  /** Task title / short description */
  title: string;
  /** Task type (e.g. bugfix, feature, refactoring, docs) */
  type: string;
  /** Estimated completion time (human-readable, e.g. "30分钟", "2小时") */
  estimatedTime: string;
  /** Reasoning behind the estimation */
  estimationBasis: string;
  /** Actual time spent (human-readable) */
  actualTime: string;
  /** Post-completion review / lessons learned */
  review: string;
}

/**
 * A parsed task record section from the Markdown file.
 */
export interface ParsedTaskRecord {
  /** Date string from the heading (e.g. "2026-04-25") */
  date: string;
  /** Task title */
  title: string;
  /** Raw Markdown content of this record section */
  raw: string;
}

/**
 * Configuration for TaskRecords.
 */
export interface TaskRecordsConfig {
  /** Base directory where the records file lives (default: process.cwd()) */
  baseDir?: string;
  /** Records file name (default: 'task-records.md') */
  fileName?: string;
  /** Subdirectory within baseDir (default: '.claude') */
  subDir?: string;
}

/**
 * TaskRecords — manages a Markdown file of task execution records.
 *
 * Each record follows the format specified in Issue #1234:
 *
 * ```markdown
 * ## 2026-04-25 重构登录模块
 *
 * - **类型**: refactoring
 * - **估计时间**: 30分钟
 * - **估计依据**: 类似之前的表单重构
 * - **实际时间**: 45分钟
 * - **复盘**: 低估了密码验证逻辑的复杂度
 * ```
 *
 * Usage:
 * ```typescript
 * const records = new TaskRecords({ baseDir: '/project' });
 * await records.append({
 *   title: '重构登录模块',
 *   type: 'refactoring',
 *   estimatedTime: '30分钟',
 *   estimationBasis: '类似之前的表单重构，当时花了25分钟',
 *   actualTime: '45分钟',
 *   review: '低估了密码验证逻辑的复杂度',
 * });
 * ```
 */
export class TaskRecords {
  private readonly filePath: string;
  private readonly dirPath: string;

  constructor(config: TaskRecordsConfig = {}) {
    const baseDir = config.baseDir ?? process.cwd();
    const subDir = config.subDir ?? '.claude';
    const fileName = config.fileName ?? 'task-records.md';

    this.dirPath = path.join(baseDir, subDir);
    this.filePath = path.join(this.dirPath, fileName);
  }

  /**
   * Get the records file path.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Ensure the records directory exists.
   */
  private async ensureDir(): Promise<void> {
    try {
      await fs.mkdir(this.dirPath, { recursive: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create records directory');
      throw error;
    }
  }

  /**
   * Ensure the records file exists with a header.
   * If the file doesn't exist, creates it with the standard header.
   */
  async ensureFile(): Promise<void> {
    await this.ensureDir();

    try {
      await fs.access(this.filePath);
    } catch {
      // File doesn't exist — create with header
      const header = '# 任务记录\n\n';
      await fs.writeFile(this.filePath, header, 'utf-8');
      logger.debug({ path: this.filePath }, 'Created task records file');
    }
  }

  /**
   * Append a new task record to the Markdown file.
   *
   * The record is appended in the format specified by Issue #1234,
   * using non-structured Markdown (no JSON, no structured data).
   *
   * @param entry - Task record data
   */
  async append(entry: TaskRecordEntry): Promise<void> {
    await this.ensureFile();

    const now = new Date();
    const [dateStr] = now.toISOString().split('T'); // YYYY-MM-DD
    const timestamp = now.toISOString();

    const record = `\n## ${dateStr} ${entry.title}\n\n`
      + `- **类型**: ${entry.type}\n`
      + `- **估计时间**: ${entry.estimatedTime}\n`
      + `- **估计依据**: ${entry.estimationBasis}\n`
      + `- **实际时间**: ${entry.actualTime}\n`
      + `- **复盘**: ${entry.review}\n\n`
      + `<!-- timestamp: ${timestamp} -->\n`;

    try {
      await fs.appendFile(this.filePath, record, 'utf-8');
      logger.info({ title: entry.title, date: dateStr }, 'Task record appended');
    } catch (err) {
      logger.error({ err }, 'Failed to append task record');
      throw err;
    }
  }

  /**
   * Append a new task record synchronously.
   * Use for critical records that must be written before process exit.
   *
   * @param entry - Task record data
   */
  appendSync(entry: TaskRecordEntry): void {
    // Ensure directory exists
    if (!syncFs.existsSync(this.dirPath)) {
      syncFs.mkdirSync(this.dirPath, { recursive: true });
    }

    // Ensure file exists with header
    if (!syncFs.existsSync(this.filePath)) {
      syncFs.writeFileSync(this.filePath, '# 任务记录\n\n', 'utf-8');
    }

    const now = new Date();
    const [dateStr] = now.toISOString().split('T');
    const timestamp = now.toISOString();

    const record = `\n## ${dateStr} ${entry.title}\n\n`
      + `- **类型**: ${entry.type}\n`
      + `- **估计时间**: ${entry.estimatedTime}\n`
      + `- **估计依据**: ${entry.estimationBasis}\n`
      + `- **实际时间**: ${entry.actualTime}\n`
      + `- **复盘**: ${entry.review}\n\n`
      + `<!-- timestamp: ${timestamp} -->\n`;

    try {
      syncFs.appendFileSync(this.filePath, record, 'utf-8');
      logger.info({ title: entry.title, date: dateStr }, 'Task record appended (sync)');
    } catch (err) {
      logger.error({ err }, 'Failed to append task record (sync)');
      throw err;
    }
  }

  /**
   * Read all records from the Markdown file.
   *
   * @returns Raw Markdown content of the records file, or empty string if file doesn't exist
   */
  async readAll(): Promise<string> {
    try {
      return await fs.readFile(this.filePath, 'utf-8');
    } catch (_error) {
      // File doesn't exist yet
      logger.debug('No task records file found');
      return '';
    }
  }

  /**
   * Parse all task records from the Markdown file.
   *
   * Splits the file by `## YYYY-MM-DD` headings and returns
   * structured record objects with raw Markdown content.
   *
   * @returns Array of parsed task records
   */
  async list(): Promise<ParsedTaskRecord[]> {
    const content = await this.readAll();
    if (!content) {return [];}

    const records: ParsedTaskRecord[] = [];
    // Match ## YYYY-MM-DD title headings
    const headingRegex = /^## (\d{4}-\d{2}-\d{2}) (.+)$/gm;
    const matches: { date: string; title: string; index: number }[] = [];

    let match;
    while ((match = headingRegex.exec(content)) !== null) {
      matches.push({
        date: match[1],
        title: match[2].trim(),
        index: match.index,
      });
    }

    // Extract raw content for each record (from heading to next heading or EOF)
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index;
      const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
      const raw = content.substring(start, end).trim();

      records.push({
        date: matches[i].date,
        title: matches[i].title,
        raw,
      });
    }

    return records;
  }

  /**
   * Search task records by keyword.
   *
   * Performs a case-insensitive text search across all records.
   * Matches against the full Markdown content of each record.
   *
   * @param keyword - Search keyword
   * @returns Matching task records
   */
  async search(keyword: string): Promise<ParsedTaskRecord[]> {
    const records = await this.list();
    const lowerKeyword = keyword.toLowerCase();

    return records.filter(record =>
      record.raw.toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * Get task records filtered by type.
   *
   * Searches for `- **类型**: <type>` in the record content.
   *
   * @param type - Task type to filter by (e.g. 'bugfix', 'feature')
   * @returns Matching task records
   */
  async getByType(type: string): Promise<ParsedTaskRecord[]> {
    const records = await this.list();
    const typePattern = `- **类型**: ${type}`;

    return records.filter(record =>
      record.raw.toLowerCase().includes(typePattern.toLowerCase())
    );
  }

  /**
   * Get recent task records (last N records).
   *
   * @param count - Number of recent records to return (default: 10)
   * @returns Recent task records, newest first
   */
  async getRecent(count: number = 10): Promise<ParsedTaskRecord[]> {
    const records = await this.list();
    // Records are already in chronological order (oldest first)
    return records.slice(-count).reverse();
  }

  /**
   * Check if the records file exists.
   *
   * @returns True if the file exists
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
   * Get count of task records.
   *
   * @returns Number of records in the file
   */
  async count(): Promise<number> {
    const records = await this.list();
    return records.length;
  }
}
