/**
 * ETA Recorder - Markdown-based task record management for ETA estimation.
 *
 * This module provides simple file I/O for reading and appending Markdown-based
 * task records and ETA rules. All data is stored as free-form Markdown, following
 * the principle that task records should be unstructured and human-readable.
 *
 * File locations:
 * - Task records: {workspaceDir}/.claude/task-records.md
 * - ETA rules: {workspaceDir}/.claude/eta-rules.md
 *
 * Design Principles:
 * - Markdown as Data: Free-form Markdown, no structured serialization
 * - Append-only records: New records prepended (newest first)
 * - Human-readable: Both LLM and humans can read/edit the files
 * - Evolving rules: ETA rules file is meant to be updated over time
 *
 * Issue #1234: Task ETA estimation system (Phase 1)
 *
 * @module task/eta-recorder
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ETARecorder');

/**
 * Task record data for ETA estimation.
 *
 * This interface is used only for function parameters - the actual storage
 * is free-form Markdown, not structured JSON.
 */
export interface TaskRecord {
  /** Brief title of the task */
  title: string;
  /** Task type classification */
  type: TaskType;
  /** Estimated time in minutes */
  estimatedMinutes: number;
  /** Why this estimate was chosen */
  estimationBasis: string;
  /** Actual time spent in minutes */
  actualMinutes: number;
  /** Post-task review and lessons learned */
  review: string;
  /** Key files involved (optional) */
  files?: string[];
  /** Date of the task (defaults to today) */
  date?: string;
}

/**
 * Task type classification for ETA estimation.
 */
export type TaskType =
  | 'bugfix'
  | 'feature-small'
  | 'feature-medium'
  | 'feature-large'
  | 'refactoring'
  | 'test'
  | 'docs'
  | 'research';

/**
 * ETA Recorder configuration.
 */
export interface ETARecorderConfig {
  /** Workspace directory containing .claude/ folder */
  workspaceDir: string;
}

/**
 * Default Markdown template for task-records.md.
 * Used when creating a new file.
 */
const TASK_RECORDS_TEMPLATE = `# Task Records

Historical task execution records used for ETA estimation.
Each entry records estimated vs actual time with reasoning.

<!-- Append new entries at the top (newest first) -->
`;

/**
 * Default Markdown template for eta-rules.md.
 * Used when creating a new file.
 */
const ETA_RULES_TEMPLATE = `# ETA Estimation Rules

Living document of estimation rules. Updated as we learn from experience.
These rules guide ETA predictions for new tasks.

## Task Type Baselines

| Type | Baseline | Notes |
|------|----------|-------|
| bugfix | 15-45 minutes | Depends on reproduction complexity |
| feature-small | 30-60 minutes | Single component, clear scope |
| feature-medium | 2-4 hours | Multiple components, some design decisions |
| feature-large | 1-2 days | New module or significant refactor |
| refactoring | varies | Assess scope and test coverage first |
| test | 20-60 minutes | Depends on module complexity |
| docs | 15-30 minutes | Usually straightforward |
| research | 30-90 minutes | Unpredictable, add buffer |

## Adjustment Factors

1. **Authentication/Security involved** → baseline × 1.5
2. **Modifying core/shared modules** → baseline × 2.0
3. **Existing reference code available** → baseline × 0.7
4. **Third-party API integration** → baseline × 1.5 + debugging time
5. **Async/concurrent logic** → baseline × 1.8
6. **Tests required but none exist** → baseline × 1.3
7. **Cross-cutting changes** → baseline × 1.5

## Known Patterns

### Overestimation Triggers
- Simple CRUD operations
- One-line config changes
- Well-documented API usage

### Underestimation Triggers
- State management complexity
- Edge cases in validation logic
- Environment/configuration issues
- Dependencies not yet available

## Change Log

- ${new Date().toISOString().split('T')[0]}: Initial rules created
`;

/**
 * Markdown-based task record manager for ETA estimation.
 *
 * Provides simple read/append operations for task records and ETA rules.
 * All data is stored as free-form Markdown files.
 */
export class ETARecorder {
  private readonly claudeDir: string;
  private readonly taskRecordsPath: string;
  private readonly etaRulesPath: string;

  constructor(config: ETARecorderConfig) {
    this.claudeDir = path.join(config.workspaceDir, '.claude');
    this.taskRecordsPath = path.join(this.claudeDir, 'task-records.md');
    this.etaRulesPath = path.join(this.claudeDir, 'eta-rules.md');
  }

  /**
   * Get the path to task-records.md.
   */
  getTaskRecordsPath(): string {
    return this.taskRecordsPath;
  }

  /**
   * Get the path to eta-rules.md.
   */
  getETARulesPath(): string {
    return this.etaRulesPath;
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
   * Initialize task-records.md if it doesn't exist.
   *
   * @returns True if file was created, false if it already existed
   */
  async ensureTaskRecords(): Promise<boolean> {
    await this.ensureClaudeDir();

    try {
      await fs.access(this.taskRecordsPath);
      return false;
    } catch {
      await fs.writeFile(this.taskRecordsPath, TASK_RECORDS_TEMPLATE, 'utf-8');
      logger.info({ path: this.taskRecordsPath }, 'Created task-records.md');
      return true;
    }
  }

  /**
   * Initialize eta-rules.md if it doesn't exist.
   *
   * @returns True if file was created, false if it already existed
   */
  async ensureETARules(): Promise<boolean> {
    await this.ensureClaudeDir();

    try {
      await fs.access(this.etaRulesPath);
      return false;
    } catch {
      await fs.writeFile(this.etaRulesPath, ETA_RULES_TEMPLATE, 'utf-8');
      logger.info({ path: this.etaRulesPath }, 'Created eta-rules.md');
      return true;
    }
  }

  /**
   * Read task records Markdown content.
   *
   * @returns Markdown content of task-records.md, or empty string if not found
   */
  async readTaskRecords(): Promise<string> {
    try {
      const content = await fs.readFile(this.taskRecordsPath, 'utf-8');
      return content;
    } catch (error) {
      logger.debug({ err: error }, 'Task records file not found');
      return '';
    }
  }

  /**
   * Read ETA rules Markdown content.
   *
   * @returns Markdown content of eta-rules.md, or empty string if not found
   */
  async readETARules(): Promise<string> {
    try {
      const content = await fs.readFile(this.etaRulesPath, 'utf-8');
      return content;
    } catch (error) {
      logger.debug({ err: error }, 'ETA rules file not found');
      return '';
    }
  }

  /**
   * Append a task record to task-records.md.
   *
   * The record is inserted after the header comment, so newest records
   * appear first in the file.
   *
   * @param record - Task record data
   */
  async appendTaskRecord(record: TaskRecord): Promise<void> {
    await this.ensureTaskRecords();

    const existing = await this.readTaskRecords();
    const date = record.date || new Date().toISOString().split('T')[0];

    const entry = this.formatTaskRecord(record, date);

    // Insert after the header comment block (after the last <!-- --> comment line)
    const insertPoint = existing.indexOf('-->\n');
    let newContent: string;

    if (insertPoint !== -1) {
      const headerEnd = insertPoint + 4; // length of '-->\n'
      newContent = `${existing.slice(0, headerEnd)  }\n${  entry  }${existing.slice(headerEnd)}`;
    } else {
      // No comment found, prepend after first two lines (title + blank)
      const lines = existing.split('\n');
      const headerLines = lines.slice(0, 2).join('\n');
      const rest = lines.slice(2).join('\n');
      newContent = `${headerLines  }\n\n${  entry  }${rest}`;
    }

    try {
      await fs.writeFile(this.taskRecordsPath, newContent, 'utf-8');
      logger.info({ title: record.title, date }, 'Task record appended');
    } catch (error) {
      logger.error({ err: error }, 'Failed to append task record');
      throw error;
    }
  }

  /**
   * Update eta-rules.md with new content.
   *
   * @param content - Full Markdown content to write
   */
  async writeETARules(content: string): Promise<void> {
    await this.ensureETARules();

    try {
      await fs.writeFile(this.etaRulesPath, content, 'utf-8');
      logger.info('ETA rules updated');
    } catch (error) {
      logger.error({ err: error }, 'Failed to write ETA rules');
      throw error;
    }
  }

  /**
   * Search task records for entries matching a keyword.
   *
   * Returns matching record sections as-is from the Markdown file.
   * This is a simple text search, not structured querying.
   *
   * @param keyword - Search keyword
   * @returns Array of matching Markdown sections
   */
  async searchTaskRecords(keyword: string): Promise<string[]> {
    const content = await this.readTaskRecords();
    if (!content) {return [];}

    // Split by ## headers (each record starts with ## )
    const sections = content.split(/\n(?=## )/);
    const keywordLower = keyword.toLowerCase();

    return sections.filter(
      section => section.toLowerCase().includes(keywordLower)
    );
  }

  /**
   * Get recent task records (last N entries).
   *
   * @param count - Number of recent records to return
   * @returns Array of Markdown sections
   */
  async getRecentRecords(count: number = 5): Promise<string[]> {
    const content = await this.readTaskRecords();
    if (!content) {return [];}

    // Split by ## headers
    const sections = content.split(/\n(?=## )/);

    // Skip the first section (title/header) and filter out empty sections
    const records = sections.filter(s => s.trim().startsWith('## ') && s.includes('**Type**:'));

    return records.slice(0, count);
  }

  /**
   * Check if task-records.md exists.
   */
  async hasTaskRecords(): Promise<boolean> {
    try {
      await fs.access(this.taskRecordsPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if eta-rules.md exists.
   */
  async hasETARules(): Promise<boolean> {
    try {
      await fs.access(this.etaRulesPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Format a task record as Markdown.
   *
   * @param record - Task record data
   * @param date - Date string (YYYY-MM-DD)
   * @returns Formatted Markdown section
   */
  private formatTaskRecord(record: TaskRecord, date: string): string {
    const filesLine = record.files?.length
      ? `- **Files**: ${record.files.join(', ')}`
      : '';

    return `## ${date} ${record.title}

- **Type**: ${record.type}
- **Estimated Time**: ${record.estimatedMinutes} minutes
- **Estimation Basis**: ${record.estimationBasis}
- **Actual Time**: ${record.actualMinutes} minutes
- **Review**: ${record.review}
${filesLine}

---`;
  }
}
