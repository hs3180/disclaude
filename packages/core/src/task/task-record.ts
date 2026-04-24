/**
 * TaskRecordService - Markdown-based task execution record system.
 *
 * Implements Phase 1 of Issue #1234: Task ETA Estimation System.
 *
 * Records task execution data in non-structured Markdown format,
 * following the owner's explicit requirement to avoid structured storage.
 *
 * Storage:
 * - `.claude/task-records.md` — Append-only log of all task executions
 * - Each record includes: task type, estimated time, reasoning, actual time, review
 *
 * Design Principles (from issue feedback):
 * - Use non-structured Markdown for task records
 * - Record estimation reasoning process
 * - Include estimated vs actual time for learning
 * - Records are append-only (never modify existing entries)
 *
 * @module task/task-record
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskRecordService');

/**
 * Task record data for creating a new entry.
 */
export interface TaskRecordInput {
  /** Task title / brief description */
  title: string;
  /** Task type classification (e.g., 'bugfix', 'feature', 'refactoring') */
  type: string;
  /** Estimated duration in minutes */
  estimatedMinutes: number;
  /** Reasoning behind the estimate */
  estimationBasis: string;
  /** Actual duration in minutes (optional at creation, can be updated later) */
  actualMinutes?: number;
  /** Post-completion review / reflection */
  review?: string;
  /** ISO timestamp of when the task started */
  startedAt?: string;
  /** ISO timestamp of when the task completed */
  completedAt?: string;
}

/**
 * Parsed task record from Markdown.
 */
export interface TaskRecord {
  /** Original Markdown section header */
  title: string;
  /** Task type */
  type: string;
  /** Estimated duration in minutes */
  estimatedMinutes: number;
  /** Reasoning behind the estimate */
  estimationBasis: string;
  /** Actual duration in minutes (if recorded) */
  actualMinutes?: number;
  /** Post-completion review */
  review?: string;
  /** When the task started */
  startedAt?: string;
  /** When the task completed */
  completedAt?: string;
  /** Date string from the section header (e.g., "2026-04-24") */
  date: string;
}

/**
 * TaskRecordService - Manages Markdown-based task execution records.
 *
 * Usage:
 * ```typescript
 * const service = new TaskRecordService(workspaceDir);
 *
 * // Record a completed task
 * await service.appendRecord({
 *   title: 'Refactor login module',
 *   type: 'refactoring',
 *   estimatedMinutes: 30,
 *   estimationBasis: 'Similar to form refactoring, took 25 min',
 *   actualMinutes: 45,
 *   review: 'Underestimated password validation complexity',
 * });
 *
 * // Search for similar tasks
 * const similar = await service.findSimilarRecords('login');
 * ```
 */
export class TaskRecordService {
  private readonly recordsPath: string;
  private readonly claudeDir: string;

  constructor(workspaceDir: string) {
    this.claudeDir = path.join(workspaceDir, '.claude');
    this.recordsPath = path.join(this.claudeDir, 'task-records.md');
  }

  /**
   * Get the path to the task records file.
   */
  getRecordsPath(): string {
    return this.recordsPath;
  }

  /**
   * Ensure the .claude directory exists.
   */
  private async ensureClaudeDir(): Promise<void> {
    try {
      await fs.mkdir(this.claudeDir, { recursive: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create .claude directory');
      throw error;
    }
  }

  /**
   * Initialize the task records file with a header if it doesn't exist.
   */
  async initialize(): Promise<void> {
    await this.ensureClaudeDir();

    try {
      await fs.access(this.recordsPath);
      // File already exists
    } catch {
      // File doesn't exist, create with header
      const header = `# Task Records

> Auto-generated task execution log for ETA estimation.
> Records are append-only. Do not modify existing entries.

---

`;
      await fs.writeFile(this.recordsPath, header, 'utf-8');
      logger.info({ path: this.recordsPath }, 'Task records file initialized');
    }
  }

  /**
   * Append a new task record.
   *
   * Creates a Markdown section in the format:
   * ```markdown
   * ## 2026-04-24 Refactor Login Module
   *
   * - **Type**: refactoring
   * - **Estimated Time**: 30 minutes
   * - **Estimation Basis**: Similar to form refactoring, took 25 minutes
   * - **Actual Time**: 45 minutes
   * - **Review**: Underestimated password validation complexity
   *
   * ---
   * ```
   *
   * @param record - Task record data
   */
  async appendRecord(record: TaskRecordInput): Promise<void> {
    await this.initialize();

    const date = record.startedAt
      ? record.startedAt.substring(0, 10)
      : new Date().toISOString().substring(0, 10);

    const section = this.formatRecordSection(record, date);

    try {
      await fs.appendFile(this.recordsPath, section, 'utf-8');
      logger.info({ title: record.title }, 'Task record appended');
    } catch (error) {
      logger.error({ err: error, title: record.title }, 'Failed to append task record');
      throw error;
    }
  }

  /**
   * Format a task record as a Markdown section.
   */
  private formatRecordSection(record: TaskRecordInput, date: string): string {
    const lines: string[] = [];

    lines.push(`## ${date} ${record.title}`);
    lines.push('');
    lines.push(`- **Type**: ${record.type}`);
    lines.push(`- **Estimated Time**: ${record.estimatedMinutes} minutes`);
    lines.push(`- **Estimation Basis**: ${record.estimationBasis}`);

    if (record.actualMinutes !== undefined) {
      lines.push(`- **Actual Time**: ${record.actualMinutes} minutes`);
    }

    if (record.review) {
      lines.push(`- **Review**: ${record.review}`);
    }

    if (record.startedAt) {
      lines.push(`- **Started At**: ${record.startedAt}`);
    }

    if (record.completedAt) {
      lines.push(`- **Completed At**: ${record.completedAt}`);
    }

    lines.push('');
    lines.push('---');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Read all task records from the Markdown file.
   *
   * Parses the Markdown sections into structured TaskRecord objects.
   *
   * @returns Array of parsed task records (newest first due to append order)
   */
  async readRecords(): Promise<TaskRecord[]> {
    try {
      await fs.access(this.recordsPath);
    } catch {
      return [];
    }

    const content = await fs.readFile(this.recordsPath, 'utf-8');
    return this.parseRecords(content);
  }

  /**
   * Parse task records from Markdown content.
   *
   * Splits on `## ` section headers and extracts key-value pairs.
   */
  parseRecords(content: string): TaskRecord[] {
    const records: TaskRecord[] = [];

    // Split on section headers (## YYYY-MM-DD Title)
    const sections = content.split(/\n(?=## \d{4}-\d{2}-\d{2} )/);

    for (const section of sections) {
      const headerMatch = section.match(/^## (\d{4}-\d{2}-\d{2}) (.+)/);
      if (!headerMatch) {continue;}

      const [, date, rawTitle] = headerMatch;
      const title = rawTitle.trim();

      const record: TaskRecord = {
        date,
        title,
        type: this.extractField(section, 'Type') || 'unknown',
        estimatedMinutes: this.extractNumberField(section, 'Estimated Time') ?? 0,
        estimationBasis: this.extractField(section, 'Estimation Basis') || '',
        actualMinutes: this.extractNumberField(section, 'Actual Time'),
        review: this.extractField(section, 'Review'),
        startedAt: this.extractField(section, 'Started At'),
        completedAt: this.extractField(section, 'Completed At'),
      };

      records.push(record);
    }

    // Reverse to get newest first
    return records.reverse();
  }

  /**
   * Extract a string field value from a Markdown section.
   */
  private extractField(section: string, fieldName: string): string | undefined {
    const regex = new RegExp(`- \\*\\*${fieldName}\\*\\*: (.+)`);
    const match = section.match(regex);
    return match?.[1]?.trim();
  }

  /**
   * Extract a numeric field value from a Markdown section.
   */
  private extractNumberField(section: string, fieldName: string): number | undefined {
    const value = this.extractField(section, fieldName);
    if (!value) {return undefined;}
    const numMatch = value.match(/(\d+)/);
    return numMatch ? parseInt(numMatch[1], 10) : undefined;
  }

  /**
   * Find records matching keywords.
   *
   * Searches title, type, estimation basis, and review fields.
   *
   * @param keywords - Space-separated keywords to search for
   * @param limit - Maximum number of results (default: 10)
   * @returns Matching records, newest first
   */
  async findSimilarRecords(keywords: string, limit: number = 10): Promise<TaskRecord[]> {
    const records = await this.readRecords();
    const terms = keywords.toLowerCase().split(/\s+/).filter(Boolean);

    if (terms.length === 0) {return records.slice(0, limit);}

    const scored = records.map(record => {
      const searchable = [
        record.title,
        record.type,
        record.estimationBasis,
        record.review ?? '',
      ]
        .join(' ')
        .toLowerCase();

      const score = terms.reduce(
        (sum, term) => sum + (searchable.includes(term) ? 1 : 0),
        0
      );

      return { record, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.record);
  }

  /**
   * Get summary statistics of all task records.
   */
  async getStats(): Promise<{
    totalRecords: number;
    byType: Record<string, number>;
    averageEstimateMinutes: number;
    averageActualMinutes: number;
    averageAccuracy: number;
  }> {
    const records = await this.readRecords();

    const byType: Record<string, number> = {};
    let totalEstimate = 0;
    let totalActual = 0;
    let actualCount = 0;
    let accuracySum = 0;
    let accuracyCount = 0;

    for (const record of records) {
      byType[record.type] = (byType[record.type] ?? 0) + 1;
      totalEstimate += record.estimatedMinutes;

      if (record.actualMinutes !== undefined) {
        totalActual += record.actualMinutes;
        actualCount++;

        if (record.estimatedMinutes > 0) {
          const accuracy = record.actualMinutes / record.estimatedMinutes;
          accuracySum += accuracy;
          accuracyCount++;
        }
      }
    }

    return {
      totalRecords: records.length,
      byType,
      averageEstimateMinutes: records.length > 0 ? Math.round(totalEstimate / records.length) : 0,
      averageActualMinutes: actualCount > 0 ? Math.round(totalActual / actualCount) : 0,
      averageAccuracy: accuracyCount > 0 ? Math.round((accuracySum / accuracyCount) * 100) / 100 : 0,
    };
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
   * Get the number of records.
   */
  async getRecordCount(): Promise<number> {
    const records = await this.readRecords();
    return records.length;
  }

  /**
   * Read the raw Markdown content of the records file.
   */
  async readRawContent(): Promise<string> {
    try {
      return await fs.readFile(this.recordsPath, 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Update the most recent record with actual time and review.
   *
   * Finds the most recent record without actual time and updates it.
   * This is useful for completing tasks that were recorded without actual time.
   *
   * @param actualMinutes - Actual time taken in minutes
   * @param review - Optional review/reflection
   */
  async completeLatestPending(actualMinutes: number, review?: string): Promise<boolean> {
    const content = await this.readRawContent();
    if (!content) {return false;}

    // Find all section positions (## YYYY-MM-DD ...)
    const sectionRegex = /## \d{4}-\d{2}-\d{2} .+/g;
    const sections: { start: number; end: number; hasActualTime: boolean }[] = [];

    let match: RegExpExecArray | null;
    while ((match = sectionRegex.exec(content)) !== null) {
      const start = match.index;
      // Find the end: either the next section start or end of content
      const nextSection = content.indexOf('\n## ', start + 1);
      const end = nextSection === -1 ? content.length : nextSection;
      const sectionContent = content.substring(start, end);
      const hasActualTime = sectionContent.includes('**Actual Time**:');
      sections.push({ start, end, hasActualTime });
    }

    // Find the last section without actual time
    for (let i = sections.length - 1; i >= 0; i--) {
      if (sections[i].hasActualTime) {continue;}

      const { start, end } = sections[i];
      const sectionContent = content.substring(start, end);

      // Insert Actual Time before the last --- separator
      const lastDash = sectionContent.lastIndexOf('---');
      if (lastDash === -1) {continue;}

      const additionalLines: string[] = [];
      additionalLines.push(`- **Actual Time**: ${actualMinutes} minutes`);
      if (review) {
        additionalLines.push(`- **Review**: ${review}`);
      }
      additionalLines.push('');

      const newSection =
        `${sectionContent.substring(0, lastDash).trimEnd() 
        }\n${ 
        additionalLines.join('\n') 
        }${sectionContent.substring(lastDash)}`;

      const newContent = content.substring(0, start) + newSection + content.substring(end);
      await fs.writeFile(this.recordsPath, newContent, 'utf-8');
      logger.info({ actualMinutes }, 'Latest pending record completed');
      return true;
    }

    return false;
  }
}
