/**
 * Task Record Manager - Reads and writes Markdown task execution records.
 *
 * Implements Phase 1 of Issue #1234: Task ETA estimation system.
 * Uses non-structured Markdown free storage in `.claude/task-records.md`.
 *
 * Features:
 * - Append task records in Markdown format
 * - Parse and search existing records
 * - Filter by type, date, keywords
 *
 * @module eta/task-records
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { TaskRecord, TaskRecordManagerOptions, ParsedTaskRecord, TaskType } from './types.js';

const logger = createLogger('TaskRecords');

/**
 * Manages Markdown-based task execution records for ETA estimation.
 *
 * Record format (stored in `.claude/task-records.md`):
 * ```markdown
 * ## YYYY-MM-DD {Task Title}
 *
 * - **类型**: {taskType}
 * - **估计时间**: {estimatedTime}
 * - **估计依据**: {estimationBasis}
 * - **实际时间**: {actualTime}
 * - **复盘**: {review}
 * ```
 */
export class TaskRecordManager {
  private readonly recordsPath: string;
  private readonly rulesPath: string;

  constructor(options: TaskRecordManagerOptions = {}) {
    const baseDir = options.baseDir ?? process.cwd();
    const claudeDir = path.join(baseDir, '.claude');
    this.recordsPath = options.recordsPath ?? path.join(claudeDir, 'task-records.md');
    this.rulesPath = options.rulesPath ?? path.join(claudeDir, 'eta-rules.md');
  }

  // --------------------------------------------------------------------------
  // Write Operations
  // --------------------------------------------------------------------------

  /**
   * Append a task record to the Markdown file.
   * Creates the file and parent directories if they don't exist.
   */
  async appendRecord(record: TaskRecord): Promise<void> {
    await this.ensureDirectory();

    const entry = this.formatRecord(record);
    const header = await this.getFileHeader();

    try {
      const content = `${header + entry  }\n`;
      await fs.appendFile(this.recordsPath, content, 'utf-8');
      logger.debug({ title: record.title, type: record.type }, 'Task record appended');
    } catch (error) {
      logger.error({ error, path: this.recordsPath }, 'Failed to append task record');
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Read Operations
  // --------------------------------------------------------------------------

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

  /**
   * Read the raw Markdown content of the records file.
   */
  async readRaw(): Promise<string> {
    try {
      return await fs.readFile(this.recordsPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  /**
   * Parse all task records from the Markdown file.
   */
  async listRecords(): Promise<ParsedTaskRecord[]> {
    const content = await this.readRaw();
    if (!content) {return [];}
    return this.parseRecords(content);
  }

  /**
   * Search records by type.
   */
  async listByType(type: TaskType): Promise<ParsedTaskRecord[]> {
    const records = await this.listRecords();
    return records.filter(r => r.type === type);
  }

  /**
   * Search records by date range (inclusive).
   */
  async listByDateRange(from: string, to: string): Promise<ParsedTaskRecord[]> {
    const records = await this.listRecords();
    return records.filter(r => r.date >= from && r.date <= to);
  }

  /**
   * Search records by keyword in title, estimationBasis, or review.
   */
  async search(keyword: string): Promise<ParsedTaskRecord[]> {
    const lowerKeyword = keyword.toLowerCase();
    const records = await this.listRecords();
    return records.filter(r =>
      r.title.toLowerCase().includes(lowerKeyword) ||
      r.estimationBasis.toLowerCase().includes(lowerKeyword) ||
      r.review.toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * Get the most recent N records.
   */
  async recent(count: number = 10): Promise<ParsedTaskRecord[]> {
    const records = await this.listRecords();
    return records.slice(-count);
  }

  // --------------------------------------------------------------------------
  // ETA Rules
  // --------------------------------------------------------------------------

  /**
   * Get the path to the ETA rules file.
   */
  getRulesPath(): string {
    return this.rulesPath;
  }

  /**
   * Get the path to the task records file.
   */
  getRecordsPath(): string {
    return this.recordsPath;
  }

  /**
   * Initialize the ETA rules file with a template if it doesn't exist.
   */
  async initializeRulesTemplate(): Promise<void> {
    await this.ensureDirectory();

    try {
      await fs.access(this.rulesPath);
      // File already exists, don't overwrite
      return;
    } catch {
      // File doesn't exist, create template
    }

    const template = `# ETA 估计规则

## 任务类型基准时间

| 类型 | 基准时间 | 备注 |
|------|---------|------|
| bugfix | 15-30分钟 | 取决于复现难度 |
| feature-small | 30-60分钟 | 单一功能点 |
| feature-medium | 2-4小时 | 需要多个组件配合 |
| refactoring | 视范围而定 | 需要评估影响面 |
| test | 20-45分钟 | 取决于测试复杂度 |
| docs | 15-30分钟 | 文档更新 |
| research | 1-2小时 | 调研和分析 |
| chore | 10-20分钟 | 常规维护 |

## 经验规则

1. **涉及认证/安全的任务** → 基准时间 × 1.5
2. **需要修改核心模块** → 基准时间 × 2
3. **有现成参考代码** → 基准时间 × 0.7
4. **涉及第三方 API 集成** → 基准时间 × 1.5 + 调试时间

## 历史偏差分析

- 低估场景: 涉及异步逻辑、状态管理
- 高估场景: 简单的 CRUD 操作

## 最近更新

- 初始化模板
`;

    await fs.writeFile(this.rulesPath, template, 'utf-8');
    logger.debug({ path: this.rulesPath }, 'ETA rules template created');
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  /**
   * Ensure the parent directory of the records file exists.
   */
  private async ensureDirectory(): Promise<void> {
    const dir = path.dirname(this.recordsPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      logger.error({ error, dir }, 'Failed to create directory');
      throw error;
    }
  }

  /**
   * Get the file header. If the file exists, return empty string (append mode).
   * If the file doesn't exist, return the title header.
   */
  private async getFileHeader(): Promise<string> {
    const exists = await this.exists();
    if (exists) {
      return '\n';
    }
    return `# 任务记录

`;
  }

  /**
   * Format a TaskRecord as a Markdown section.
   */
  private formatRecord(record: TaskRecord): string {
    return `## ${record.date} ${record.title}

- **类型**: ${record.type}
- **估计时间**: ${record.estimatedTime}
- **估计依据**: ${record.estimationBasis}
- **实际时间**: ${record.actualTime}
- **复盘**: ${record.review}`;
  }

  /**
   * Parse Markdown content into an array of ParsedTaskRecords.
   */
  private parseRecords(content: string): ParsedTaskRecord[] {
    const records: ParsedTaskRecord[] = [];
    const lines = content.split('\n');

    let currentRecord: Partial<ParsedTaskRecord> | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match ## YYYY-MM-DD Title
      const headerMatch = line.match(/^## (\d{4}-\d{2}-\d{2}) (.+)$/);
      if (headerMatch) {
        // Save previous record if any
        if (currentRecord && this.isValidRecord(currentRecord)) {
          records.push(currentRecord as ParsedTaskRecord);
        }

        currentRecord = {
          date: headerMatch[1],
          title: headerMatch[2].trim(),
          lineNumber: i + 1,
        };
        continue;
      }

      if (!currentRecord) {continue;}

      // Parse key-value lines: - **key**: value
      const kvMatch = line.match(/^- \*\*([^*]+)\*\*: (.+)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();

        switch (key) {
          case '类型':
            currentRecord.type = value as TaskType;
            break;
          case '估计时间':
            currentRecord.estimatedTime = value;
            break;
          case '估计依据':
            currentRecord.estimationBasis = value;
            break;
          case '实际时间':
            currentRecord.actualTime = value;
            break;
          case '复盘':
            currentRecord.review = value;
            break;
        }
      }
    }

    // Don't forget the last record
    if (currentRecord && this.isValidRecord(currentRecord)) {
      records.push(currentRecord as ParsedTaskRecord);
    }

    return records;
  }

  /**
   * Check if a partial record has all required fields.
   */
  private isValidRecord(record: Partial<ParsedTaskRecord>): record is ParsedTaskRecord {
    return !!(
      record.date &&
      record.title &&
      record.type &&
      record.estimatedTime &&
      record.estimationBasis &&
      record.actualTime &&
      record.review &&
      record.lineNumber
    );
  }
}
