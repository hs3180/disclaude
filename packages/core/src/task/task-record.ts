/**
 * TaskRecordManager - Appends task execution records to a Markdown file.
 *
 * Implements Phase 1 of the ETA estimation system (#1234).
 * Records task type, estimated time, estimation basis, actual time,
 * and review notes in a human-readable Markdown format.
 *
 * File location: `{workspaceDir}/.claude/task-records.md`
 *
 * @module task/task-record
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskRecordManager');

/** Supported task types for estimation categorization. */
export type TaskType =
  | 'bugfix'
  | 'feature'
  | 'refactoring'
  | 'research'
  | 'test'
  | 'docs'
  | 'chore';

/** Input data for recording a completed task. */
export interface TaskRecordInput {
  /** Brief description of the task */
  title: string;
  /** Task category */
  type: TaskType;
  /** Estimated duration in minutes */
  estimatedMinutes: number;
  /** Why this estimate was chosen — references similar past tasks or complexity factors */
  estimationBasis: string;
  /** Actual duration in minutes */
  actualMinutes: number;
  /** What went well, what was underestimated, lessons learned */
  review: string;
}

/** A parsed task record entry. */
export interface TaskRecord {
  /** 1-based sequential index */
  index: number;
  /** Date string (YYYY-MM-DD) */
  date: string;
  /** Record input data */
  input: TaskRecordInput;
}

/** Parsed result of reading the full task-records.md file. */
export interface TaskRecordsFile {
  /** All parsed records */
  records: TaskRecord[];
  /** Raw file content */
  raw: string;
}

/**
 * Manages task execution records in a Markdown file.
 *
 * Append-only: new records are always added at the end of the file.
 * The file format uses `##` headings as record delimiters, which makes
 * parsing straightforward and keeps the file human-readable.
 */
export class TaskRecordManager {
  private readonly filePath: string;

  /**
   * @param workspaceDir - Project workspace directory.
   *   Records are stored at `{workspaceDir}/.claude/task-records.md`.
   */
  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, '.claude', 'task-records.md');
  }

  /**
   * Append a task record to the file.
   *
   * Creates the file and parent directories if they don't exist.
   * Prepends a `# Task Records` header when creating a new file.
   */
  async append(record: TaskRecordInput): Promise<void> {
    await this.ensureDir();

    let header = '';
    try {
      await fs.access(this.filePath);
    } catch {
      header = '# Task Records\n\n';
    }

    const entry = this.formatEntry(record);
    const content = header + entry;

    try {
      await fs.appendFile(this.filePath, content, 'utf-8');
      logger.info({ title: record.title }, 'Task record appended');
    } catch (error) {
      logger.error({ err: error }, 'Failed to append task record');
      throw error;
    }
  }

  /**
   * Read and parse all task records from the file.
   *
   * Returns an empty array if the file doesn't exist.
   */
  async readAll(): Promise<TaskRecordsFile> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const records = this.parseRecords(raw);
      return { records, raw };
    } catch (_error) {
      // File doesn't exist yet
      return { records: [], raw: '' };
    }
  }

  /**
   * Get the configured file path.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Format a single task record entry as Markdown.
   */
  private formatEntry(record: TaskRecordInput): string {
    const [date] = new Date().toISOString().split('T');
    return `## ${date} ${record.title}

- **Type**: ${record.type}
- **Estimated Time**: ${record.estimatedMinutes} minutes
- **Estimation Basis**: ${record.estimationBasis}
- **Actual Time**: ${record.actualMinutes} minutes
- **Review**: ${record.review}

`;
  }

  /**
   * Parse task records from raw Markdown content.
   */
  private parseRecords(raw: string): TaskRecord[] {
    const records: TaskRecord[] = [];
    const sections = raw.split(/^## /m).filter(Boolean);

    for (const section of sections) {
      const lines = section.split('\n');
      const firstLine = lines[0] || '';

      // Extract date from heading: "2026-05-14 Fix Login Bug"
      const dateMatch = firstLine.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)/);
      if (!dateMatch) {continue;}

      const [, date, rawTitle] = dateMatch;
      const title = rawTitle.trim();

      const input = this.parseFields(lines.slice(1));
      if (!input) {continue;}

      input.title = title;
      records.push({
        index: records.length + 1,
        date,
        input,
      });
    }

    return records;
  }

  /**
   * Parse key-value fields from the Markdown list items.
   */
  private parseFields(lines: string[]): TaskRecordInput | null {
    let type: TaskType | undefined;
    let estimatedMinutes: number | undefined;
    let estimationBasis = '';
    let actualMinutes: number | undefined;
    let review = '';

    for (const line of lines) {
      const trimmed = line.trim();
      const fieldMatch = trimmed.match(/^- \*\*(.+?)\*\*:\s*(.+)/);
      if (!fieldMatch) {continue;}

      const [, key, value] = fieldMatch;
      switch (key) {
        case 'Type':
          type = value as TaskType;
          break;
        case 'Estimated Time':
          estimatedMinutes = parseInt(value, 10);
          break;
        case 'Estimation Basis':
          estimationBasis = value;
          break;
        case 'Actual Time':
          actualMinutes = parseInt(value, 10);
          break;
        case 'Review':
          review = value;
          break;
      }
    }

    if (!type || estimatedMinutes === undefined || actualMinutes === undefined) {
      return null;
    }

    return {
      title: '',
      type,
      estimatedMinutes,
      estimationBasis,
      actualMinutes,
      review,
    };
  }

  /**
   * Ensure the parent directory exists.
   */
  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      logger.error({ err: error, dir }, 'Failed to create task records directory');
      throw error;
    }
  }
}
