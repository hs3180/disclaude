/**
 * Task Record Manager - Manages task execution records for ETA estimation.
 *
 * Records are stored as free-form Markdown in `.claude/task-records.md`.
 * Each record captures estimated vs actual time, estimation basis,
 * and retrospective notes to improve future estimates.
 *
 * Storage format (Markdown):
 * ```markdown
 * # 任务记录
 *
 * ## 2024-03-10 重构登录模块
 * - **类型**: refactoring
 * - **估计时间**: 30分钟
 * - **估计依据**: 类似之前的表单重构
 * - **实际时间**: 45分钟
 * - **复盘**: 低估了密码验证逻辑的复杂度
 * ```
 *
 * @module task/task-record-manager
 * @see https://github.com/hs3180/disclaude/issues/1234
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { TaskRecord } from './types.js';

const logger = createLogger('TaskRecordManager');

/** Default header for a new task-records.md file */
const DEFAULT_HEADER = `# 任务记录

> 此文件由 TaskRecordManager 自动维护，记录任务执行信息用于 ETA 估算。
> 格式为自由 Markdown，可手动编辑补充。

`;

/**
 * Manages task execution records stored as Markdown.
 *
 * Provides methods to append, read, and search task records.
 * Records are persisted to `.claude/task-records.md` in the workspace.
 */
export class TaskRecordManager {
  private readonly recordsFilePath: string;
  private initialized = false;

  /**
   * Create a TaskRecordManager.
   *
   * @param workspaceDir - Workspace directory (records stored in `.claude/` subdirectory)
   */
  constructor(workspaceDir: string) {
    this.recordsFilePath = path.join(workspaceDir, '.claude', 'task-records.md');
  }

  /**
   * Ensure the records file exists with proper header.
   * Called lazily before first write operation.
   */
  private async ensureFile(): Promise<void> {
    if (this.initialized) {return;}

    const dir = path.dirname(this.recordsFilePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    try {
      await fs.access(this.recordsFilePath);
    } catch {
      // File doesn't exist, create with default header
      try {
        await fs.writeFile(this.recordsFilePath, DEFAULT_HEADER, 'utf-8');
        logger.info({ path: this.recordsFilePath }, 'Task records file created');
      } catch (error) {
        logger.error({ err: error, path: this.recordsFilePath }, 'Failed to create task records file');
        throw error;
      }
    }

    this.initialized = true;
  }

  /**
   * Format a TaskRecord as a Markdown section.
   */
  private formatRecord(record: TaskRecord): string {
    const date = record.date || new Date().toISOString().split('T')[0];
    const lines = [
      `\n## ${date} ${record.title}`,
      '',
      `- **类型**: ${record.type}`,
      `- **估计时间**: ${record.estimatedTime}`,
      `- **估计依据**: ${record.estimationBasis}`,
    ];

    if (record.actualTime) {
      lines.push(`- **实际时间**: ${record.actualTime}`);
    }

    if (record.retrospective) {
      lines.push(`- **复盘**: ${record.retrospective}`);
    }

    if (record.taskId) {
      lines.push(`- **任务 ID**: ${record.taskId}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Append a new task record to the records file.
   *
   * @param record - Task record to append
   */
  async appendRecord(record: TaskRecord): Promise<void> {
    await this.ensureFile();

    const markdown = this.formatRecord(record);

    try {
      await fs.appendFile(this.recordsFilePath, markdown, 'utf-8');
      logger.info({
        title: record.title,
        type: record.type,
        estimatedTime: record.estimatedTime,
      }, 'Task record appended');
    } catch (error) {
      logger.error({ err: error, record: record.title }, 'Failed to append task record');
      throw error;
    }
  }

  /**
   * Update an existing record's actual time and retrospective.
   *
   * Searches for a record by title and date, then updates the
   * actual time and retrospective fields if found.
   *
   * @param title - Record title to search for
   * @param updates - Fields to update (actualTime, retrospective)
   * @returns true if record was found and updated, false otherwise
   */
  async updateRecord(
    title: string,
    updates: { actualTime?: string; retrospective?: string }
  ): Promise<boolean> {
    await this.ensureFile();

    try {
      const content = await fs.readFile(this.recordsFilePath, 'utf-8');
      const lines = content.split('\n');
      let found = false;
      let inTargetRecord = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Detect record header (## date title)
        if (line.startsWith('## ') && line.includes(title)) {
          inTargetRecord = true;
          found = true;
          continue;
        }

        // If we hit another record header, stop
        if (line.startsWith('## ') && inTargetRecord) {
          break;
        }

        if (inTargetRecord) {
          if (updates.actualTime && line.startsWith('- **实际时间**:')) {
            lines[i] = `- **实际时间**: ${updates.actualTime}`;
          }
          if (updates.retrospective && line.startsWith('- **复盘**:')) {
            lines[i] = `- **复盘**: ${updates.retrospective}`;
          }
        }
      }

      if (!found) {return false;}

      // Add new fields if they don't exist yet
      if (found) {
        const newContent = this.addMissingFields(lines.join('\n'), title, updates);
        await fs.writeFile(this.recordsFilePath, newContent, 'utf-8');
        logger.info({ title, updates }, 'Task record updated');
      }

      return true;
    } catch (error) {
      logger.error({ err: error, title }, 'Failed to update task record');
      throw error;
    }
  }

  /**
   * Add missing fields to a record section.
   *
   * If the record doesn't have actualTime or retrospective fields yet,
   * this method inserts them after the last existing field in that record.
   */
  private addMissingFields(
    content: string,
    title: string,
    updates: { actualTime?: string; retrospective?: string }
  ): string {
    const lines = content.split('\n');
    let inTargetRecord = false;
    let lastFieldIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('## ') && line.includes(title)) {
        inTargetRecord = true;
        continue;
      }

      if (line.startsWith('## ') && inTargetRecord) {
        break;
      }

      if (inTargetRecord && line.startsWith('- **')) {
        lastFieldIndex = i;
      }
    }

    if (lastFieldIndex === -1) {return content;}

    const insertions: string[] = [];
    const existingContent = lines.slice(
      lines.findIndex(l => l.startsWith('## ') && l.includes(title)),
      lastFieldIndex + 1
    ).join('\n');

    if (updates.actualTime && !existingContent.includes('- **实际时间**:')) {
      insertions.push(`- **实际时间**: ${updates.actualTime}`);
    }
    if (updates.retrospective && !existingContent.includes('- **复盘**:')) {
      insertions.push(`- **复盘**: ${updates.retrospective}`);
    }

    if (insertions.length === 0) {return content;}

    // Insert after the last field line
    lines.splice(lastFieldIndex + 1, 0, ...insertions);
    return lines.join('\n');
  }

  /**
   * Read all task records from the file.
   *
   * @returns Full content of the task-records.md file
   */
  async getRecords(): Promise<string> {
    await this.ensureFile();

    try {
      return await fs.readFile(this.recordsFilePath, 'utf-8');
    } catch (error) {
      logger.error({ err: error }, 'Failed to read task records');
      throw error;
    }
  }

  /**
   * Search task records for entries matching a query string.
   *
   * Performs a simple text search across all records.
   * Returns the matching record sections (including the `##` header).
   *
   * @param query - Search query string
   * @returns Array of matching record sections (Markdown)
   */
  async searchRecords(query: string): Promise<string[]> {
    const content = await this.getRecords();
    const results: string[] = [];

    // Split into record sections by `## ` headers
    const sections = content.split(/^## /m);

    for (const section of sections) {
      if (!section.trim()) {continue;}

      const fullSection = section.startsWith('## ') ? section : `## ${section}`;

      if (fullSection.toLowerCase().includes(query.toLowerCase())) {
        results.push(fullSection.trim());
      }
    }

    return results;
  }

  /**
   * Parse individual records from the file content.
   *
   * Extracts structured data from Markdown records.
   * Note: This is a best-effort parser - it handles the standard format
   * but may miss custom fields or non-standard formatting.
   *
   * @returns Array of parsed task records
   */
  async parseRecords(): Promise<ParsedTaskRecord[]> {
    const content = await this.getRecords();
    const records: ParsedTaskRecord[] = [];

    // Split into record sections
    const sections = content.split(/^## /m);

    for (const section of sections) {
      if (!section.trim() || !section.includes('- **类型**:')) {continue;}

      const record = this.parseRecordSection(section);
      if (record) {
        records.push(record);
      }
    }

    return records;
  }

  /**
   * Parse a single record section into structured data.
   */
  private parseRecordSection(section: string): ParsedTaskRecord | null {
    const lines = section.split('\n');
    const headerLine = lines[0]?.trim() || '';

    // Extract date and title from header: "2024-03-10 重构登录模块"
    const headerMatch = headerLine.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
    if (!headerMatch) {return null;}

    const [, date, title] = headerMatch;

    // Extract fields from list items
    const fields: Record<string, string> = {};
    for (const line of lines) {
      const fieldMatch = line.match(/^-\s+\*\*(.+?)\*\*:\s*(.+)$/);
      if (fieldMatch) {
        fields[fieldMatch[1]] = fieldMatch[2].trim();
      }
    }

    return {
      date,
      title,
      type: fields['类型'] || 'unknown',
      estimatedTime: fields['估计时间'] || '',
      estimationBasis: fields['估计依据'] || '',
      actualTime: fields['实际时间'],
      retrospective: fields['复盘'],
      taskId: fields['任务 ID'],
    };
  }

  /**
   * Get the file path for the records file.
   *
   * Useful for debugging or for passing to other tools.
   */
  getRecordsFilePath(): string {
    return this.recordsFilePath;
  }

  /**
   * Reset the initialization state (for testing).
   */
  resetInitialization(): void {
    this.initialized = false;
  }
}

/**
 * Parsed representation of a task record from Markdown.
 */
export interface ParsedTaskRecord {
  date: string;
  title: string;
  type: string;
  estimatedTime: string;
  estimationBasis: string;
  actualTime?: string;
  retrospective?: string;
  taskId?: string;
}
