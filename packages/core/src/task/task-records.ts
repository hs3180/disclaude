/**
 * Task Records - Markdown-based task execution record system.
 *
 * Provides unstructured Markdown storage for task execution history,
 * enabling ETA learning through free-form records with reasoning.
 *
 * ## Design Philosophy
 *
 * ⚠️ IMPORTANT: Uses unstructured Markdown free storage, NOT structured data.
 * - Task records are stored as Markdown in `.claude/task-records.md`
 * - Estimation rules are maintained in `eta-rules.md`
 * - Records include full estimation reasoning for review and improvement
 *
 * ## File Format (.claude/task-records.md)
 *
 * ```markdown
 * # Task Records
 *
 * ## 2024-03-10 Refactor Login Module
 *
 * - **类型**: refactoring
 * - **估计时间**: 30分钟
 * - **估计依据**: 类似之前的表单重构，当时花了25分钟
 * - **实际时间**: 45分钟
 * - **复盘**: 低估了密码验证逻辑的复杂度
 *
 * ## 2024-03-09 Add User Export Feature
 *
 * - **类型**: feature
 * - **实际时间**: 55分钟
 * - **复盘**: 估计较准确
 * ```
 *
 * @module task/task-records
 * @see Issue #1234 - Phase 1: Task Record Format
 */

import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskRecords');

/**
 * Task record data for creating a new record entry.
 * All fields are optional to support free-form recording at different stages.
 */
export interface TaskRecordInput {
  /** Task title (used as section heading) */
  title: string;
  /** Task type: bugfix, feature, refactoring, docs, etc. */
  type?: string;
  /** Estimated completion time (human-readable string, e.g., "30分钟") */
  estimatedTime?: string;
  /** Reasoning for the estimate (free-form text) */
  estimationReasoning?: string;
  /** Actual completion time (human-readable string, e.g., "45分钟") */
  actualTime?: string;
  /** Post-completion review / lessons learned (free-form text) */
  review?: string;
  /** Task ID for cross-referencing with task.md files */
  taskId?: string;
  /** Additional free-form notes */
  notes?: string;
}

/**
 * Parsed task record from the Markdown file.
 */
export interface ParsedTaskRecord {
  /** Date string from the section heading (e.g., "2024-03-10") */
  date: string;
  /** Title from the section heading */
  title: string;
  /** Raw Markdown content of the record */
  rawContent: string;
  /** Parsed key-value fields from the record */
  fields: Record<string, string>;
}

/**
 * Search options for filtering task records.
 */
export interface TaskRecordSearchOptions {
  /** Filter by task type */
  type?: string;
  /** Full-text search in record content */
  query?: string;
  /** Maximum number of records to return */
  limit?: number;
  /** Only return records after this date (ISO string) */
  since?: string;
}

/**
 * TaskRecordKeeper - Manages Markdown-based task execution records.
 *
 * Uses unstructured Markdown for storage, aligned with the design philosophy
 * of keeping records human-readable, evolvable, and easy to review.
 */
export class TaskRecordKeeper {
  private readonly recordsDir: string;
  private readonly recordsPath: string;

  /**
   * Create a TaskRecordKeeper.
   *
   * @param workspaceDir - Workspace directory (records stored in .claude/ subdir)
   */
  constructor(workspaceDir: string) {
    this.recordsDir = path.join(workspaceDir, '.claude');
    this.recordsPath = path.join(this.recordsDir, 'task-records.md');
  }

  /**
   * Get the path to the task records file.
   */
  getRecordsPath(): string {
    return this.recordsPath;
  }

  /**
   * Get the path to the eta-rules file.
   */
  getEtaRulesPath(): string {
    return path.join(this.recordsDir, 'eta-rules.md');
  }

  /**
   * Ensure the .claude directory exists.
   */
  private async ensureRecordsDir(): Promise<void> {
    try {
      await fs.mkdir(this.recordsDir, { recursive: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create .claude directory');
      throw error;
    }
  }

  /**
   * Initialize the task records file with a header if it doesn't exist.
   */
  async initialize(): Promise<void> {
    await this.ensureRecordsDir();

    try {
      await fs.access(this.recordsPath);
      // File already exists
    } catch {
      // File doesn't exist, create with header
      const header = `# Task Records

> 任务执行记录。每次任务完成后自动追加。
> 用于 ETA 预估学习（Issue #1234）。

---

`;
      await fs.writeFile(this.recordsPath, header, 'utf-8');
      logger.info({ path: this.recordsPath }, 'Task records file initialized');
    }
  }

  /**
   * Initialize the eta-rules.md template if it doesn't exist.
   */
  async initializeEtaRules(): Promise<void> {
    await this.ensureRecordsDir();

    const etaRulesPath = this.getEtaRulesPath();

    try {
      await fs.access(etaRulesPath);
      // File already exists
    } catch {
      const template = `# ETA 估计规则

> 基于历史任务经验积累的估计规则。随经验自动进化。
> 用于 ETA 预估学习（Issue #1234）。

---

## 任务类型基准时间

| 类型 | 基准时间 | 备注 |
|------|---------|------|
| bugfix | 15-30分钟 | 取决于复现难度 |
| feature-small | 30-60分钟 | 单一功能点 |
| feature-medium | 2-4小时 | 需要多个组件配合 |
| refactoring | 视范围而定 | 需要评估影响面 |

## 经验规则

_暂无经验规则。随着任务记录积累，将自动提取并更新。_

## 历史偏差分析

_暂无数据。需要至少 5 条任务记录后进行分析。_

## 最近更新

- ${new Date().toISOString().split('T')[0]}: 初始化 ETA 规则模板
`;
      await fs.writeFile(etaRulesPath, template, 'utf-8');
      logger.info({ path: etaRulesPath }, 'ETA rules template initialized');
    }
  }

  /**
   * Append a task record to the records file.
   *
   * Creates the file with header if it doesn't exist.
   * The record is appended as unstructured Markdown.
   *
   * @param record - Task record data to append
   */
  async appendRecord(record: TaskRecordInput): Promise<void> {
    await this.initialize();

    const [date] = new Date().toISOString().split('T');
    const content = this.formatRecord(date, record);

    try {
      await fs.appendFile(this.recordsPath, content, 'utf-8');
      logger.info({ title: record.title, date }, 'Task record appended');
    } catch (error) {
      logger.error({ err: error, title: record.title }, 'Failed to append task record');
      throw error;
    }
  }

  /**
   * Append a task record synchronously.
   * Use for critical situations where async might not complete.
   *
   * @param record - Task record data to append
   */
  appendRecordSync(record: TaskRecordInput): void {
    // Ensure directory exists
    if (!syncFs.existsSync(this.recordsDir)) {
      try {
        syncFs.mkdirSync(this.recordsDir, { recursive: true });
      } catch (error) {
        logger.error({ err: error }, 'Failed to create .claude directory (sync)');
        throw error;
      }
    }

    // Create file with header if doesn't exist
    if (!syncFs.existsSync(this.recordsPath)) {
      const header = `# Task Records

> 任务执行记录。每次任务完成后自动追加。
> 用于 ETA 预估学习（Issue #1234）。

---

`;
      try {
        syncFs.writeFileSync(this.recordsPath, header, 'utf-8');
      } catch (error) {
        logger.error({ err: error }, 'Failed to initialize task records file (sync)');
        throw error;
      }
    }

    const [date] = new Date().toISOString().split('T');
    const content = this.formatRecord(date, record);

    try {
      syncFs.appendFileSync(this.recordsPath, content, 'utf-8');
      logger.info({ title: record.title, date }, 'Task record appended (sync)');
    } catch (error) {
      logger.error({ err: error, title: record.title }, 'Failed to append task record (sync)');
      throw error;
    }
  }

  /**
   * Format a task record as Markdown.
   *
   * @param date - Date string for the record heading
   * @param record - Task record data
   * @returns Formatted Markdown string
   */
  private formatRecord(date: string, record: TaskRecordInput): string {
    const lines: string[] = [];

    lines.push(`## ${date} ${record.title}`);
    lines.push('');

    if (record.taskId) {
      lines.push(`- **Task ID**: ${record.taskId}`);
    }
    if (record.type) {
      lines.push(`- **类型**: ${record.type}`);
    }
    if (record.estimatedTime) {
      lines.push(`- **估计时间**: ${record.estimatedTime}`);
    }
    if (record.estimationReasoning) {
      lines.push(`- **估计依据**: ${record.estimationReasoning}`);
    }
    if (record.actualTime) {
      lines.push(`- **实际时间**: ${record.actualTime}`);
    }
    if (record.review) {
      lines.push(`- **复盘**: ${record.review}`);
    }
    if (record.notes) {
      lines.push(`- **备注**: ${record.notes}`);
    }

    lines.push('');
    lines.push('---');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Read all task records from the file.
   *
   * @returns Array of parsed task records
   */
  async readRecords(): Promise<ParsedTaskRecord[]> {
    try {
      const content = await fs.readFile(this.recordsPath, 'utf-8');
      return this.parseRecords(content);
    } catch (_error) {
      // File doesn't exist yet
      logger.debug('Task records file not found, returning empty array');
      return [];
    }
  }

  /**
   * Search task records with optional filters.
   *
   * @param options - Search/filter options
   * @returns Filtered array of task records
   */
  async searchRecords(options: TaskRecordSearchOptions): Promise<ParsedTaskRecord[]> {
    let records = await this.readRecords();

    // Filter by type
    if (options.type) {
      const targetType = options.type.toLowerCase();
      records = records.filter(
        r => r.fields['类型']?.toLowerCase() === targetType
          || r.fields['type']?.toLowerCase() === targetType
      );
    }

    // Filter by date
    if (options.since) {
      const sinceDate = options.since;
      records = records.filter(r => r.date >= sinceDate);
    }

    // Full-text search
    if (options.query) {
      const queryLower = options.query.toLowerCase();
      records = records.filter(
        r => r.rawContent.toLowerCase().includes(queryLower)
          || r.title.toLowerCase().includes(queryLower)
      );
    }

    // Limit results
    if (options.limit && options.limit > 0) {
      records = records.slice(0, options.limit);
    }

    return records;
  }

  /**
   * Check if the task records file exists.
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
   * Parse Markdown content into structured task records.
   *
   * Extracts records delimited by `##` headings (after the main `#` heading).
   * Each record's key-value pairs are parsed from the `- **key**: value` format.
   *
   * @param content - Raw Markdown content
   * @returns Array of parsed task records
   */
  parseRecords(content: string): ParsedTaskRecord[] {
    const records: ParsedTaskRecord[] = [];

    // Split by ## headings (level 2), skip the first part (title/headers)
    const sections = content.split(/\n(?=## )/);

    for (const section of sections) {
      // Match heading: "## YYYY-MM-DD Title"
      const headingMatch = section.match(/^## (\d{4}-\d{2}-\d{2})\s+(.+)/);
      if (!headingMatch) {
        continue;
      }

      const [, date, titleRaw] = headingMatch;
      const title = titleRaw.trim();
      const rawContent = section.trim();

      // Parse key-value fields from "- **key**: value" format
      const fields: Record<string, string> = {};
      const fieldRegex = /^- \*\*(.+?)\*\*:\s*(.+)$/gm;
      let match;
      while ((match = fieldRegex.exec(section)) !== null) {
        fields[match[1]] = match[2].trim();
      }

      records.push({ date, title, rawContent, fields });
    }

    return records;
  }

  /**
   * Record task completion from existing task files.
   *
   * Reads the task.md for metadata, calculates duration from timestamps,
   * and appends a record to task-records.md.
   *
   * @param taskId - Task identifier (message ID)
   * @param taskFileManager - TaskFileManager instance for reading task data
   * @param options - Optional record overrides
   */
  async recordTaskCompletion(
    taskId: string,
    taskFileManager: {
      readTaskSpec: (taskId: string) => Promise<string>;
      getTaskStats: (taskId: string) => Promise<{ totalIterations: number }>;
    },
    options?: {
      type?: string;
      estimatedTime?: string;
      estimationReasoning?: string;
      review?: string;
    }
  ): Promise<void> {
    let title = `Task ${taskId}`;
    let actualTime = '';

    try {
      // Read task spec for title
      const spec = await taskFileManager.readTaskSpec(taskId);
      const titleMatch = spec.match(/^#\s+(?:Task:\s*)?(.+)$/m);
      if (titleMatch) {
        title = titleMatch[1].trim();
      }

      // Extract creation timestamp from task spec
      const createdMatch = spec.match(/\*\*Created\*\*:\s*(.+)/);
      if (createdMatch) {
        const created = new Date(createdMatch[1].trim());
        const now = new Date();
        const durationMs = now.getTime() - created.getTime();
        actualTime = this.formatDuration(durationMs);
      }

      // Get iteration count
      const stats = await taskFileManager.getTaskStats(taskId);

      await this.appendRecord({
        title,
        taskId,
        type: options?.type,
        estimatedTime: options?.estimatedTime,
        estimationReasoning: options?.estimationReasoning,
        actualTime,
        review: options?.review,
        notes: stats.totalIterations > 1
          ? `经历 ${stats.totalIterations} 轮迭代完成`
          : undefined,
      });
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to record task completion');
      // Still try to append a basic record
      await this.appendRecord({
        title,
        taskId,
        type: options?.type,
        actualTime: actualTime || 'unknown',
        review: options?.review || '记录时出错，部分数据缺失',
      });
    }
  }

  /**
   * Format a duration in milliseconds to a human-readable string.
   *
   * @param ms - Duration in milliseconds
   * @returns Human-readable duration string
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      const remainingMinutes = minutes % 60;
      return remainingMinutes > 0
        ? `${hours}小时${remainingMinutes}分钟`
        : `${hours}小时`;
    }
    if (minutes > 0) {
      return `${minutes}分钟`;
    }
    return `${seconds}秒`;
  }
}
