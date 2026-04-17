/**
 * Task record manager for ETA prediction system (Issue #1234 Phase 1).
 *
 * Manages unstructured Markdown task records that track task execution
 * information for future ETA estimation. Records are stored in
 * `.claude/task-records.md` within the workspace directory.
 *
 * Design principle: Use free-form Markdown for storage, NOT structured data.
 * Each task record includes estimated time, actual time, task type,
 * estimation basis, and retrospective notes.
 *
 * Directory structure:
 * workspace/
 * └── .claude/
 *     └── task-records.md    # All task records in one Markdown file
 *
 * @module task/task-record
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskRecord');

/**
 * Represents a single task record entry.
 * Used for programmatic access to parsed records.
 */
export interface TaskRecordEntry {
  /** Task title/description */
  title: string;
  /** Date string (e.g. "2024-03-10") */
  date: string;
  /** Task type (e.g. "bugfix", "feature", "refactoring") */
  type: string;
  /** Estimated time string (e.g. "30分钟", "1小时") */
  estimatedTime: string;
  /** Basis for the estimation */
  estimationBasis: string;
  /** Actual execution time string */
  actualTime: string;
  /** Retrospective/reflection notes */
  retrospective: string;
}

/**
 * Options for creating a TaskRecordManager.
 */
export interface TaskRecordManagerOptions {
  /** Workspace directory path */
  workspaceDir: string;
}

/**
 * Task record manager for persisting and retrieving task execution records.
 *
 * Records are stored as free-form Markdown in a single file,
 * following the design principle of unstructured storage.
 *
 * @example
 * ```typescript
 * const manager = new TaskRecordManager({ workspaceDir: '/path/to/workspace' });
 *
 * // Append a new task record
 * await manager.appendRecord({
 *   title: '重构登录模块',
 *   type: 'refactoring',
 *   estimatedTime: '30分钟',
 *   estimationBasis: '类似之前的表单重构，当时花了25分钟',
 *   actualTime: '45分钟',
 *   retrospective: '低估了密码验证逻辑的复杂度',
 * });
 *
 * // Read all records
 * const content = await manager.readRecords();
 *
 * // Search records by keyword
 * const matches = await manager.searchRecords('登录');
 * ```
 */
export class TaskRecordManager {
  private readonly recordsDir: string;
  private readonly recordsPath: string;

  constructor(options: TaskRecordManagerOptions) {
    this.recordsDir = path.join(options.workspaceDir, '.claude');
    this.recordsPath = path.join(this.recordsDir, 'task-records.md');
  }

  /**
   * Ensure the `.claude` directory and records file exist.
   * Creates both if they don't exist.
   */
  async ensureInitialized(): Promise<void> {
    try {
      await fs.mkdir(this.recordsDir, { recursive: true });
    } catch (error) {
      logger.error({ error, dir: this.recordsDir }, 'Failed to create .claude directory');
      throw error;
    }

    try {
      await fs.access(this.recordsPath);
    } catch {
      // File doesn't exist, create with header
      await fs.writeFile(this.recordsPath, this.formatFileHeader(), 'utf-8');
      logger.info({ path: this.recordsPath }, 'Created task-records.md');
    }
  }

  /**
   * Get the absolute path to the task records file.
   */
  getRecordsPath(): string {
    return this.recordsPath;
  }

  /**
   * Read the entire task records file content.
   *
   * @returns The raw Markdown content of the records file
   */
  async readRecords(): Promise<string> {
    try {
      return await fs.readFile(this.recordsPath, 'utf-8');
    } catch (error) {
      logger.error({ error, path: this.recordsPath }, 'Failed to read task records');
      throw error;
    }
  }

  /**
   * Append a new task record to the records file.
   *
   * The record is appended in Markdown format with all relevant fields.
   * The file is created with a header if it doesn't exist.
   *
   * @param entry - The task record entry to append
   */
  async appendRecord(entry: Omit<TaskRecordEntry, 'date'> & { date?: string }): Promise<void> {
    await this.ensureInitialized();

    const date = entry.date || new Date().toISOString().split('T')[0];
    const record = this.formatRecord({ ...entry, date });

    try {
      const existing = await fs.readFile(this.recordsPath, 'utf-8');
      await fs.writeFile(this.recordsPath, `${existing  }\n${  record}`, 'utf-8');
      logger.info({ title: entry.title }, 'Task record appended');
    } catch (error) {
      logger.error({ error, path: this.recordsPath }, 'Failed to append task record');
      throw error;
    }
  }

  /**
   * Search records by keyword.
   *
   * Returns all record sections that contain the keyword (case-insensitive).
   * Each result is the full Markdown section for a matching record.
   *
   * @param keyword - The keyword to search for
   * @returns Array of matching Markdown sections
   */
  async searchRecords(keyword: string): Promise<string[]> {
    const content = await this.readRecords();
    const lowerKeyword = keyword.toLowerCase();

    // Split content by record sections (## YYYY-MM-DD pattern)
    const sections = content.split(/\n(?=## \d{4}-\d{2}-\d{2})/);

    return sections.filter(section =>
      section.toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * Parse all records from the file into structured entries.
   *
   * This is a best-effort parser that extracts fields from the Markdown
   * format. If a record cannot be fully parsed, partial data is returned.
   *
   * @returns Array of parsed task record entries
   */
  async parseRecords(): Promise<TaskRecordEntry[]> {
    const content = await this.readRecords();
    const records: TaskRecordEntry[] = [];

    // Split by record sections (## YYYY-MM-DD ...)
    const sectionRegex = /## (\d{4}-\d{2}-\d{2})\s+([^\n]+)\n([\s\S]*?)(?=\n## \d{4}-\d{2}-\d{2}|\n*$)/g;
    let match: RegExpExecArray | null;

    while ((match = sectionRegex.exec(content)) !== null) {
      const [, date, headingText, sectionBody] = match;

      const entry: TaskRecordEntry = {
        date,
        title: headingText.trim(),
        type: this.extractField(sectionBody, '类型') || 'unknown',
        estimatedTime: this.extractField(sectionBody, '估计时间') || '',
        estimationBasis: this.extractField(sectionBody, '估计依据') || '',
        actualTime: this.extractField(sectionBody, '实际时间') || '',
        retrospective: this.extractField(sectionBody, '复盘') || '',
      };

      records.push(entry);
    }

    return records;
  }

  /**
   * Check if the records file exists.
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.recordsPath);
      return true;
    } catch {
      return false;
    }
  }

  // ===== Private helpers =====

  /**
   * Format the file header for a new task-records.md.
   */
  private formatFileHeader(): string {
    return `# 任务记录

> 本文件记录每个任务的执行信息，用于 ETA 预估系统的学习和参考。
> 由 TaskRecordManager 自动维护。

`;
  }

  /**
   * Format a single task record as Markdown.
   */
  private formatRecord(entry: TaskRecordEntry): string {
    return `## ${entry.date} ${entry.title}

- **类型**: ${entry.type}
- **估计时间**: ${entry.estimatedTime}
- **估计依据**: ${entry.estimationBasis}
- **实际时间**: ${entry.actualTime}
- **复盘**: ${entry.retrospective}
`;
  }

  /**
   * Extract a field value from a Markdown section.
   * Looks for patterns like `**字段名**: value` or `- **字段名**: value`.
   */
  private extractField(section: string, fieldName: string): string {
    // Match both "**Field**: value" and "- **Field**: value" patterns
    const regex = new RegExp(`-?\\s*\\*\\*${fieldName}\\*\\*:\\s*(.+)`, 'i');
    const match = regex.exec(section);
    return match ? match[1].trim() : '';
  }
}
