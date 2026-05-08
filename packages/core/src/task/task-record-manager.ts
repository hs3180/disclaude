/**
 * TaskRecordManager - Programmatic access to task execution records.
 *
 * Issue #1234 Phase 1: Task record format and retrieval.
 *
 * This module provides programmatic access to the task records stored in
 * `.claude/task-records.md`. The agent is prompted via guidance to record
 * task execution info manually, and this module provides:
 *
 * 1. **Append**: Add new task records programmatically
 * 2. **Read**: Parse all records from the Markdown file
 * 3. **Search**: Find similar past tasks by type or keywords
 *
 * Design Principles:
 * - Non-structured Markdown storage (as per Issue #1234)
 * - Append-only: records are never modified after creation
 * - Human-readable: the file can be read and edited directly
 * - Parseable: structured enough for programmatic retrieval
 *
 * File format:
 * ```markdown
 * # Task Records
 *
 * ## YYYY-MM-DD {Brief Task Description}
 *
 * - **Type**: {bugfix | feature | refactoring | research | test | docs | chore}
 * - **Estimated Time**: {estimate}
 * - **Estimation Basis**: {reasoning}
 * - **Actual Time**: {actual duration}
 * - **Review**: {retrospective notes}
 * ```
 *
 * @module task/task-record-manager
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { TaskRecord, TaskRecordType } from './types.js';

const logger = createLogger('TaskRecordManager');

/**
 * Task record manager for programmatic access to execution history.
 *
 * Stores and retrieves task execution records in `.claude/task-records.md`
 * to support ETA estimation learning.
 */
export class TaskRecordManager {
  private readonly recordsPath: string;

  /**
   * Create a TaskRecordManager.
   *
   * @param workspaceDir - Workspace directory where `.claude/` is located
   */
  constructor(workspaceDir: string) {
    this.recordsPath = path.join(workspaceDir, '.claude', 'task-records.md');
  }

  /**
   * Get the path to the task-records.md file.
   *
   * @returns Absolute path to task-records.md
   */
  getRecordsPath(): string {
    return this.recordsPath;
  }

  /**
   * Check if the task-records.md file exists.
   *
   * @returns True if the file exists
   */
  async recordsExist(): Promise<boolean> {
    try {
      await fs.access(this.recordsPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Append a new task record to the file.
   *
   * Creates the file with a header if it doesn't exist.
   * Appends the record as a new `##` section.
   *
   * @param record - Task execution record to append
   */
  async appendRecord(record: TaskRecord): Promise<void> {
    // Ensure .claude directory exists
    const claudeDir = path.dirname(this.recordsPath);
    await fs.mkdir(claudeDir, { recursive: true });

    const entry = this.formatRecord(record);

    try {
      if (await this.recordsExist()) {
        // Append to existing file
        const existing = await fs.readFile(this.recordsPath, 'utf-8');
        await fs.writeFile(this.recordsPath, `${existing.trimEnd()  }\n\n${  entry  }\n`, 'utf-8');
      } else {
        // Create new file with header
        const header = '# Task Records\n';
        await fs.writeFile(this.recordsPath, `${header  }\n${  entry  }\n`, 'utf-8');
      }
      logger.debug({ title: record.title, type: record.type }, 'Task record appended');
    } catch (error) {
      logger.error({ err: error, record }, 'Failed to append task record');
      throw error;
    }
  }

  /**
   * Read all task records from the file.
   *
   * Parses the Markdown file and extracts structured task records.
   *
   * @returns Array of task records, ordered by date (newest first)
   */
  async readRecords(): Promise<TaskRecord[]> {
    if (!(await this.recordsExist())) {
      return [];
    }

    try {
      const content = await fs.readFile(this.recordsPath, 'utf-8');
      return this.parseRecords(content);
    } catch (error) {
      logger.error({ err: error }, 'Failed to read task records');
      return [];
    }
  }

  /**
   * Get records filtered by task type.
   *
   * @param type - Task type to filter by
   * @returns Array of matching task records
   */
  async getRecordsByType(type: TaskRecordType): Promise<TaskRecord[]> {
    const records = await this.readRecords();
    return records.filter(r => r.type === type);
  }

  /**
   * Search records by keyword in title, estimation basis, or review.
   *
   * Performs case-insensitive substring matching.
   *
   * @param query - Search query
   * @returns Array of matching task records
   */
  async searchRecords(query: string): Promise<TaskRecord[]> {
    const records = await this.readRecords();
    const lowerQuery = query.toLowerCase();
    return records.filter(r =>
      r.title.toLowerCase().includes(lowerQuery) ||
      r.estimationBasis.toLowerCase().includes(lowerQuery) ||
      r.review.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Get recent records (limited by count).
   *
   * @param count - Maximum number of records to return (default: 10)
   * @returns Array of most recent task records
   */
  async getRecentRecords(count: number = 10): Promise<TaskRecord[]> {
    const records = await this.readRecords();
    return records.slice(0, count);
  }

  /**
   * Format a task record as Markdown for appending.
   *
   * @param record - Task record to format
   * @returns Formatted Markdown string
   */
  formatRecord(record: TaskRecord): string {
    return [
      `## ${record.date} ${record.title}`,
      '',
      `- **Type**: ${record.type}`,
      `- **Estimated Time**: ${record.estimatedTime}`,
      `- **Estimation Basis**: ${record.estimationBasis}`,
      `- **Actual Time**: ${record.actualTime}`,
      `- **Review**: ${record.review}`,
    ].join('\n');
  }

  /**
   * Parse task records from Markdown content.
   *
   * Extracts structured records from the Markdown format.
   * Records are returned in reverse order (newest first).
   *
   * @param content - Markdown content to parse
   * @returns Array of parsed task records
   */
  parseRecords(content: string): TaskRecord[] {
    const records: TaskRecord[] = [];

    // Split by ## headers (task record entries)
    // Pattern: ## YYYY-MM-DD Title
    const sections = content.split(/\n(?=## \d{4}-\d{2}-\d{2} )/);

    for (const section of sections) {
      const record = this.parseRecordSection(section);
      if (record) {
        records.push(record);
      }
    }

    // Return newest first (records are appended chronologically)
    return records.reverse();
  }

  /**
   * Parse a single record section.
   *
   * @param section - Markdown section starting with ## header
   * @returns Parsed task record, or null if parsing fails
   */
  private parseRecordSection(section: string): TaskRecord | null {
    // Extract date and title from ## header
    const headerMatch = section.match(/^## (\d{4}-\d{2}-\d{2}) (.+)/);
    if (!headerMatch) {
      return null;
    }

    const [, date, rawTitle] = headerMatch;
    const title = rawTitle.trim();

    // Extract type
    const typeMatch = section.match(/\*\*Type\*\*:\s*(\w+)/);
    if (!typeMatch) {
      return null;
    }

    const type = typeMatch[1] as TaskRecordType;
    const validTypes: TaskRecordType[] = ['bugfix', 'feature', 'refactoring', 'research', 'test', 'docs', 'chore'];
    if (!validTypes.includes(type)) {
      return null;
    }

    // Extract other fields
    const estimatedTime = this.extractField(section, 'Estimated Time') ?? 'unknown';
    const estimationBasis = this.extractField(section, 'Estimation Basis') ?? '';
    const actualTime = this.extractField(section, 'Actual Time') ?? 'unknown';
    const review = this.extractField(section, 'Review') ?? '';

    return {
      date,
      title,
      type,
      estimatedTime,
      estimationBasis,
      actualTime,
      review,
    };
  }

  /**
   * Extract a field value from a Markdown section.
   *
   * Pattern: `- **FieldName**: value`
   *
   * @param section - Markdown section
   * @param fieldName - Name of the field to extract
   * @returns Field value, or null if not found
   */
  private extractField(section: string, fieldName: string): string | null {
    const regex = new RegExp(`\\*\\*${fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*:\\s*(.+)`, 'i');
    const match = section.match(regex);
    return match ? match[1].trim() : null;
  }
}
