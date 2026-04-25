/**
 * ETA Recorder - Task execution record management.
 *
 * Issue #1234: Provides utilities for reading and writing task execution
 * records in unstructured Markdown format.
 *
 * Design Principles (from PR #1237 feedback):
 * - Task records are stored as free-form Markdown, NOT structured data
 * - Records include estimated time, reasoning, actual time, and retrospective
 * - Files are human-readable and evolve naturally
 *
 * Storage:
 * - Task records: `.claude/task-records.md` in the workspace directory
 * - ETA rules: `.claude/eta-rules.md` in the workspace directory
 *
 * @module task/eta-recorder
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('EtaRecorder');

/**
 * Task record entry representing a parsed task record.
 * Note: This is for internal use only — the actual storage is free-form Markdown.
 */
export interface TaskRecordEntry {
  /** Date string of the task */
  date: string;
  /** Task title/description */
  title: string;
  /** Task type (e.g., feature, bugfix, refactoring) */
  type: string;
  /** Estimated time string (e.g., "30分钟") */
  estimatedTime: string;
  /** Estimation reasoning */
  estimationBasis: string;
  /** Actual time string (e.g., "45分钟") */
  actualTime: string;
  /** Retrospective notes */
  retrospective: string;
}

/**
 * ETA Recorder for managing task execution records.
 */
export class EtaRecorder {
  private readonly taskRecordsPath: string;
  private readonly etaRulesPath: string;

  /**
   * Create an EtaRecorder.
   *
   * @param workspaceDir - The workspace directory where .claude/ is located
   */
  constructor(workspaceDir: string) {
    const claudeDir = path.join(workspaceDir, '.claude');
    this.taskRecordsPath = path.join(claudeDir, 'task-records.md');
    this.etaRulesPath = path.join(claudeDir, 'eta-rules.md');
  }

  /**
   * Get the path to the task records file.
   */
  getTaskRecordsPath(): string {
    return this.taskRecordsPath;
  }

  /**
   * Get the path to the ETA rules file.
   */
  getEtaRulesPath(): string {
    return this.etaRulesPath;
  }

  /**
   * Ensure the .claude directory exists.
   */
  async ensureClaudeDir(): Promise<void> {
    const claudeDir = path.dirname(this.taskRecordsPath);
    try {
      await fs.mkdir(claudeDir, { recursive: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create .claude directory');
      throw error;
    }
  }

  /**
   * Check if the task records file exists.
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
   * Check if the ETA rules file exists.
   */
  async hasEtaRules(): Promise<boolean> {
    try {
      await fs.access(this.etaRulesPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the task records file content.
   *
   * @returns Raw Markdown content of task records, or null if file doesn't exist
   */
  async readTaskRecords(): Promise<string | null> {
    try {
      const content = await fs.readFile(this.taskRecordsPath, 'utf-8');
      return content;
    } catch (error) {
      logger.debug({ err: error }, 'Task records file not found or unreadable');
      return null;
    }
  }

  /**
   * Read the ETA rules file content.
   *
   * @returns Raw Markdown content of ETA rules, or null if file doesn't exist
   */
  async readEtaRules(): Promise<string | null> {
    try {
      const content = await fs.readFile(this.etaRulesPath, 'utf-8');
      return content;
    } catch (error) {
      logger.debug({ err: error }, 'ETA rules file not found or unreadable');
      return null;
    }
  }

  /**
   * Initialize the task records file with a header if it doesn't exist.
   */
  async initializeTaskRecords(): Promise<void> {
    await this.ensureClaudeDir();

    if (await this.hasTaskRecords()) {
      logger.debug('Task records file already exists');
      return;
    }

    const header = `# 任务记录

本文件记录任务执行信息，用于 ETA 预估系统的学习。

每条记录包含：
- 任务类型和描述
- 估计时间和估计依据
- 实际执行时间
- 复盘反思

---

`;

    try {
      await fs.writeFile(this.taskRecordsPath, header, 'utf-8');
      logger.info({ path: this.taskRecordsPath }, 'Task records file initialized');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize task records file');
      throw error;
    }
  }

  /**
   * Initialize the ETA rules file with a template if it doesn't exist.
   */
  async initializeEtaRules(): Promise<void> {
    await this.ensureClaudeDir();

    if (await this.hasEtaRules()) {
      logger.debug('ETA rules file already exists');
      return;
    }

    const template = `# ETA 估计规则

本文件维护任务时间估计的经验规则，随任务执行不断进化。

## 任务类型基准时间

| 类型 | 基准时间 | 备注 |
|------|---------|------|
| bugfix | 15-30分钟 | 取决于复现难度 |
| feature-small | 30-60分钟 | 单一功能点 |
| feature-medium | 2-4小时 | 需要多个组件配合 |
| refactoring | 视范围而定 | 需要评估影响面 |
| test | 20-45分钟 | 取决于测试复杂度 |

## 经验规则

1. **涉及认证/安全的任务** → 基准时间 × 1.5
2. **需要修改核心模块** → 基准时间 × 2
3. **有现成参考代码** → 基准时间 × 0.7
4. **涉及第三方 API 集成** → 基准时间 × 1.5 + 调试时间

## 历史偏差分析

- 低估场景: 涉及异步逻辑、状态管理
- 高估场景: 简单的 CRUD 操作

---

*此文件由 Agent 自动维护，基于历史任务经验不断更新*
`;

    try {
      await fs.writeFile(this.etaRulesPath, template, 'utf-8');
      logger.info({ path: this.etaRulesPath }, 'ETA rules file initialized');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize ETA rules file');
      throw error;
    }
  }

  /**
   * Append a task record entry to the task records file.
   *
   * The record is written in free-form Markdown format as specified
   * in Issue #1234 (PR #1237 feedback: use unstructured Markdown).
   *
   * @param entry - Task record entry to append
   */
  async appendTaskRecord(entry: TaskRecordEntry): Promise<void> {
    await this.initializeTaskRecords();

    const record = `
## ${entry.date} ${entry.title}

- **类型**: ${entry.type}
- **估计时间**: ${entry.estimatedTime}
- **估计依据**: ${entry.estimationBasis}
- **实际时间**: ${entry.actualTime}
- **复盘**: ${entry.retrospective}

---

`;

    try {
      await fs.appendFile(this.taskRecordsPath, record, 'utf-8');
      logger.info({ title: entry.title }, 'Task record appended');
    } catch (error) {
      logger.error({ err: error }, 'Failed to append task record');
      throw error;
    }
  }

  /**
   * Get recent task records for context.
   *
   * Returns the last N task record sections from the file.
   *
   * @param count - Number of recent records to return
   * @returns Recent task record content, or null if no records exist
   */
  async getRecentRecords(count: number = 5): Promise<string | null> {
    const content = await this.readTaskRecords();
    if (content === null) {
      return null;
    }

    // Split by "## " headers (task record entries)
    const sections = content.split(/\n(?=## \d{4}-\d{2}-\d{2})/);

    // Take the last N sections
    const recentSections = sections.slice(-count);

    if (recentSections.length === 0) {
      return null;
    }

    return recentSections.join('\n');
  }
}

/**
 * Build a task record Markdown entry string.
 * Used for the guidance template — the agent uses this format
 * when writing records.
 *
 * @param entry - Task record entry
 * @returns Formatted Markdown string
 */
export function formatTaskRecord(entry: TaskRecordEntry): string {
  return `## ${entry.date} ${entry.title}

- **类型**: ${entry.type}
- **估计时间**: ${entry.estimatedTime}
- **估计依据**: ${entry.estimationBasis}
- **实际时间**: ${entry.actualTime}
- **复盘**: ${entry.retrospective}

---`;
}
