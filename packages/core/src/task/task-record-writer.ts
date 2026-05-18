/**
 * TaskRecordWriter — Appends unstructured Markdown task records to `.claude/task-records.md`.
 *
 * Issue #1234 Phase 1: Task record format redesign.
 * Key principle: use free-form Markdown, NOT structured data.
 *
 * File location: `{workspace}/.claude/task-records.md`
 *
 * Record format:
 * ```markdown
 * ## YYYY-MM-DD {Task Title}
 *
 * - **类型**: {bugfix | feature | refactoring | research | test | docs | chore}
 * - **估计时间**: {estimate}
 * - **估计依据**: {reasoning}
 * - **实际时间**: {actual}
 * - **复盘**: {review}
 * ```
 *
 * @module task/task-record-writer
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskRecordWriter');

/** Path to task records file relative to workspace */
const TASK_RECORDS_RELATIVE = path.join('.claude', 'task-records.md');

/**
 * Task record data — all fields are strings to keep it unstructured.
 * The caller (typically the LLM via prompt) decides what to fill in.
 */
export interface TaskRecord {
  /** Short task title */
  title: string;
  /** Task type: bugfix, feature, refactoring, research, test, docs, chore */
  type: string;
  /** Estimated time (e.g. "30分钟", "1 hour") — optional */
  estimatedTime?: string;
  /** Reasoning for the estimate — optional */
  estimationBasis?: string;
  /** Actual time taken (e.g. "45分钟") — auto-filled if possible */
  actualTime?: string;
  /** Review / lessons learned — optional */
  review?: string;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Returns "N分钟" or "N小时M分钟" format.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}秒`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}分钟`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`;
}

/**
 * Format a TaskRecord into Markdown.
 */
export function formatRecord(record: TaskRecord): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const lines: string[] = [
    '',
    `## ${date} ${record.title}`,
    '',
    `- **类型**: ${record.type}`,
    `- **估计时间**: ${record.estimatedTime || '未估计'}`,
  ];

  if (record.estimationBasis) {
    lines.push(`- **估计依据**: ${record.estimationBasis}`);
  }

  lines.push(`- **实际时间**: ${record.actualTime || '未记录'}`);

  if (record.review) {
    lines.push(`- **复盘**: ${record.review}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * TaskRecordWriter — appends Markdown task records to `.claude/task-records.md`.
 *
 * Usage:
 * ```typescript
 * const writer = new TaskRecordWriter(workspaceDir);
 * await writer.appendRecord({
 *   title: 'Fix login bug',
 *   type: 'bugfix',
 *   estimatedTime: '30分钟',
 *   actualTime: formatDuration(completionMs),
 * });
 * ```
 */
export class TaskRecordWriter {
  private readonly recordsPath: string;
  private readonly claudeDir: string;

  constructor(workspaceDir: string) {
    this.claudeDir = path.join(workspaceDir, '.claude');
    this.recordsPath = path.join(workspaceDir, TASK_RECORDS_RELATIVE);
  }

  /**
   * Get the path to the task records file.
   */
  getRecordsPath(): string {
    return this.recordsPath;
  }

  /**
   * Append a task record to `.claude/task-records.md`.
   * Creates the file with a header if it doesn't exist.
   *
   * @param record - Task record data
   */
  async appendRecord(record: TaskRecord): Promise<void> {
    try {
      // Ensure .claude directory exists
      await fs.mkdir(this.claudeDir, { recursive: true });

      const entry = formatRecord(record);

      // Check if file exists
      let existing = '';
      try {
        existing = await fs.readFile(this.recordsPath, 'utf-8');
      } catch {
        // File doesn't exist — create with header
        existing = '# Task Records\n';
      }

      await fs.writeFile(this.recordsPath, existing + entry, 'utf-8');
      logger.info({ title: record.title }, 'Task record appended');
    } catch (error) {
      logger.error({ err: error }, 'Failed to append task record');
    }
  }

  /**
   * Read all task records as raw Markdown content.
   * Returns empty string if file doesn't exist.
   */
  async readRecords(): Promise<string> {
    try {
      return await fs.readFile(this.recordsPath, 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Search task records for a keyword.
   * Returns all record sections containing the keyword.
   *
   * @param keyword - Search term
   * @returns Array of matching record sections
   */
  async searchRecords(keyword: string): Promise<string[]> {
    const content = await this.readRecords();
    if (!content) {return [];}

    // Split by ## headings (each record section)
    const sections = content.split(/\n(?=## )/);
    return sections.filter(
      section => section.toLowerCase().includes(keyword.toLowerCase())
    );
  }
}
