/**
 * TaskRecordManager - Markdown-based task record storage for ETA estimation.
 *
 * Issue #1234 Phase 1: Task record format, storage, and retrieval.
 *
 * Stores task execution records in a single Markdown file (`task-records.md`)
 * within the workspace directory. Each record captures:
 * - Task type and title
 * - Estimated vs actual duration
 * - Estimation reasoning
 * - Post-completion review notes
 *
 * Design Principles:
 * - Markdown as Data: Human-readable, git-friendly, LLM-parseable
 * - Append-only: New records are appended to the end of the file
 * - Non-structured storage: Free-form Markdown, no rigid schema enforcement
 * - Retrievable: Supports reading and searching records
 *
 * Storage Format:
 * ```markdown
 * # 任务记录
 *
 * ## 2024-03-10 重构登录模块
 *
 * - **类型**: refactoring
 * - **估计时间**: 30分钟
 * - **估计依据**: 类似之前的表单重构，当时花了25分钟
 * - **实际时间**: 45分钟
 * - **复盘**: 低估了密码验证逻辑的复杂度，下次遇到类似模块应预留更多时间
 *
 * ## 2024-03-09 添加用户导出功能
 *
 * - **类型**: feature
 * - **实际时间**: 55分钟
 * - **复盘**: 估计较准确
 * ```
 *
 * @module task/task-record-manager
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { TaskRecord, TaskType } from './types.js';

const logger = createLogger('TaskRecordManager');

/**
 * Configuration for TaskRecordManager.
 */
export interface TaskRecordManagerConfig {
  /** Workspace directory where task-records.md is stored */
  workspaceDir: string;
  /** Optional filename override (default: 'task-records.md') */
  filename?: string;
}

/**
 * Parsed task record entry from Markdown.
 * Extends TaskRecord with the position info for future edits.
 */
export interface ParsedTaskRecord extends TaskRecord {
  /** Date string parsed from the Markdown heading */
  date: string;
}

/**
 * TaskRecordManager - Manages task execution records for ETA estimation.
 *
 * Provides methods to:
 * - Append new task records to the Markdown file
 * - Read all records from the file
 * - Search records by type, date range, or keyword
 *
 * Usage:
 * ```typescript
 * const manager = new TaskRecordManager({ workspaceDir: '/path/to/workspace' });
 *
 * // Append a new record
 * await manager.appendRecord({
 *   title: '重构登录模块',
 *   type: 'refactoring',
 *   startedAt: '2024-03-10T09:00:00Z',
 *   completedAt: '2024-03-10T09:45:00Z',
 *   estimatedMinutes: 30,
 *   estimationBasis: '类似之前的表单重构',
 *   actualMinutes: 45,
 *   review: '低估了密码验证逻辑的复杂度',
 * });
 *
 * // Read all records
 * const records = await manager.readRecords();
 *
 * // Search by type
 * const bugfixes = await manager.searchRecords({ type: 'bugfix' });
 * ```
 */
export class TaskRecordManager {
  private readonly recordsPath: string;

  constructor(config: TaskRecordManagerConfig) {
    const filename = config.filename ?? 'task-records.md';
    this.recordsPath = path.join(config.workspaceDir, filename);
  }

  /**
   * Get the file path for the task records file.
   */
  getRecordsPath(): string {
    return this.recordsPath;
  }

  /**
   * Ensure the records file exists, creating it with a header if needed.
   */
  async ensureFile(): Promise<void> {
    try {
      await fs.access(this.recordsPath);
    } catch {
      // File doesn't exist, create with header
      await fs.mkdir(path.dirname(this.recordsPath), { recursive: true });
      await fs.writeFile(this.recordsPath, '# 任务记录\n\n', 'utf-8');
      logger.debug({ path: this.recordsPath }, 'Created task records file');
    }
  }

  /**
   * Append a new task record to the Markdown file.
   *
   * Creates the file if it doesn't exist. The record is appended
   * in the specified Markdown format.
   *
   * @param record - Task record to append
   */
  async appendRecord(record: TaskRecord): Promise<void> {
    await this.ensureFile();

    const entry = this.formatRecordEntry(record);

    try {
      // Append to file (add newline before entry for separation)
      await fs.appendFile(this.recordsPath, `${entry}\n`, 'utf-8');
      logger.info({ title: record.title, type: record.type }, 'Task record appended');
    } catch (error) {
      logger.error({ err: error }, 'Failed to append task record');
      throw error;
    }
  }

  /**
   * Read all task records from the Markdown file.
   *
   * Parses the Markdown file and extracts structured TaskRecord entries.
   * Returns an empty array if the file doesn't exist.
   *
   * @returns Array of parsed task records, newest first
   */
  async readRecords(): Promise<ParsedTaskRecord[]> {
    try {
      const content = await fs.readFile(this.recordsPath, 'utf-8');
      return this.parseRecords(content);
    } catch (_error) {
      // File doesn't exist yet
      logger.debug({ path: this.recordsPath }, 'No task records file found');
      return [];
    }
  }

  /**
   * Search task records by criteria.
   *
   * Supports filtering by:
   * - type: Task type (e.g., 'bugfix', 'feature-small')
   * - keyword: Case-insensitive search in title, estimationBasis, and review
   * - dateFrom / dateTo: Filter by date range (ISO date strings)
   *
   * @param criteria - Search criteria
   * @returns Matching task records
   */
  async searchRecords(criteria: {
    type?: TaskType;
    keyword?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<ParsedTaskRecord[]> {
    const records = await this.readRecords();

    return records.filter(record => {
      // Filter by type
      if (criteria.type && record.type !== criteria.type) {
        return false;
      }

      // Filter by keyword (case-insensitive search in title, basis, review)
      if (criteria.keyword) {
        const kw = criteria.keyword.toLowerCase();
        const searchable = `${record.title} ${record.estimationBasis} ${record.review}`.toLowerCase();
        if (!searchable.includes(kw)) {
          return false;
        }
      }

      // Filter by date range
      if (criteria.dateFrom) {
        const from = new Date(criteria.dateFrom);
        const recordDate = new Date(record.startedAt);
        if (recordDate < from) {
          return false;
        }
      }

      if (criteria.dateTo) {
        const to = new Date(criteria.dateTo);
        const recordDate = new Date(record.startedAt);
        if (recordDate > to) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Get statistics about task records.
   *
   * Returns summary statistics including:
   * - Total number of records
   * - Average actual duration by type
   * - Estimation accuracy (for records with estimates)
   *
   * @returns Task record statistics
   */
  async getStats(): Promise<{
    totalRecords: number;
    averageByType: Record<string, { count: number; avgMinutes: number }>;
    estimationAccuracy: { count: number; avgRatio: number } | null;
  }> {
    const records = await this.readRecords();

    // Average by type
    const byType: Record<string, number[]> = {};
    for (const record of records) {
      if (!byType[record.type]) {
        byType[record.type] = [];
      }
      byType[record.type].push(record.actualMinutes);
    }

    const averageByType: Record<string, { count: number; avgMinutes: number }> = {};
    for (const [type, durations] of Object.entries(byType)) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      averageByType[type] = { count: durations.length, avgMinutes: Math.round(avg) };
    }

    // Estimation accuracy (actual / estimated)
    const estimatedRecords = records.filter(r => r.estimatedMinutes !== null && r.estimatedMinutes > 0);
    let estimationAccuracy: { count: number; avgRatio: number } | null = null;
    if (estimatedRecords.length > 0) {
      const ratios = estimatedRecords.map(r => r.actualMinutes / (r.estimatedMinutes ?? 1));
      const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      estimationAccuracy = { count: estimatedRecords.length, avgRatio: Math.round(avgRatio * 100) / 100 };
    }

    return {
      totalRecords: records.length,
      averageByType,
      estimationAccuracy,
    };
  }

  /**
   * Format a task record as a Markdown entry.
   *
   * @param record - Task record to format
   * @returns Markdown string for the entry
   */
  private formatRecordEntry(record: TaskRecord): string {
    const date = record.startedAt.split('T')[0] ?? new Date().toISOString().split('T')[0];
    const lines: string[] = [
      `## ${date} ${record.title}`,
      '',
      `- **类型**: ${record.type}`,
    ];

    if (record.estimatedMinutes !== null) {
      lines.push(`- **估计时间**: ${record.estimatedMinutes}分钟`);
      if (record.estimationBasis) {
        lines.push(`- **估计依据**: ${record.estimationBasis}`);
      }
    }

    lines.push(`- **实际时间**: ${record.actualMinutes}分钟`);

    if (record.review) {
      lines.push(`- **复盘**: ${record.review}`);
    }

    if (record.tags && record.tags.length > 0) {
      lines.push(`- **标签**: ${record.tags.join(', ')}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Parse task records from Markdown content.
   *
   * Extracts structured TaskRecord entries from the Markdown file content.
   * Each entry is identified by a `## {date} {title}` heading.
   *
   * @param content - Markdown file content
   * @returns Array of parsed task records, newest first (as they appear in the file)
   */
  parseRecords(content: string): ParsedTaskRecord[] {
    const records: ParsedTaskRecord[] = [];

    // Split by heading pattern: ## {date} {title}
    const headingPattern = /^## (\d{4}-\d{2}-\d{2}) (.+)$/gm;
    const matches: Array<{ date: string; title: string; index: number }> = [];

    let match;
    while ((match = headingPattern.exec(content)) !== null) {
      matches.push({ date: match[1], title: match[2], index: match.index });
    }

    // Parse each entry
    for (let i = 0; i < matches.length; i++) {
      const startIdx = matches[i].index;
      const endIdx = i + 1 < matches.length ? matches[i + 1].index : content.length;
      const entryContent = content.substring(startIdx, endIdx);

      const record = this.parseSingleEntry(entryContent, matches[i].date, matches[i].title);
      if (record) {
        records.push(record);
      }
    }

    // Return newest first (reverse order, since new entries are appended)
    return records.reverse();
  }

  /**
   * Parse a single task record entry from Markdown.
   *
   * @param entry - Single entry Markdown content
   * @param date - Date parsed from heading
   * @param title - Title parsed from heading
   * @returns Parsed task record or null if parsing fails
   */
  private parseSingleEntry(entry: string, date: string, title: string): ParsedTaskRecord | null {
    try {
      // Extract list item values
      const getValue = (label: string): string | null => {
        const regex = new RegExp(`- \\*\\*${label}\\*\\*: (.+)`, 'i');
        const m = entry.match(regex);
        return m ? m[1].trim() : null;
      };

      const type = getValue('类型') as TaskType | null ?? 'other';
      const estimatedMinutesStr = getValue('估计时间');
      const estimationBasis = getValue('估计依据') ?? '';
      const actualMinutesStr = getValue('实际时间');
      const review = getValue('复盘') ?? '';
      const tagsStr = getValue('标签');

      // Parse estimated time (remove "分钟" suffix if present)
      const estimatedMinutes = estimatedMinutesStr
        ? parseInt(estimatedMinutesStr.replace(/[^\d]/g, ''), 10) || null
        : null;

      // Parse actual time
      const actualMinutes = actualMinutesStr
        ? parseInt(actualMinutesStr.replace(/[^\d]/g, ''), 10) || 0
        : 0;

      // Parse tags
      const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()) : undefined;

      // Construct startedAt/completedAt from the date
      // We use the date as startedAt and calculate completedAt from actualMinutes
      const startedAt = `${date}T00:00:00Z`;
      const completedAtDate = new Date(startedAt);
      completedAtDate.setMinutes(completedAtDate.getMinutes() + actualMinutes);

      return {
        date,
        title,
        type,
        startedAt,
        completedAt: completedAtDate.toISOString(),
        estimatedMinutes,
        estimationBasis,
        actualMinutes,
        review,
        tags,
      };
    } catch (error) {
      logger.warn({ date, title, err: error }, 'Failed to parse task record entry');
      return null;
    }
  }
}
