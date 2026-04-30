/**
 * TaskRecordManager - Task execution record management.
 *
 * Manages the `.claude/task-records.md` file that stores task execution
 * history for the ETA estimation system (Issue #1234).
 *
 * Records are stored in free-form Markdown format:
 * ```markdown
 * ### 2024-03-10 14:30 重构登录模块
 * - **类型**: refactoring
 * - **Task ID**: om_abc123
 * - **迭代次数**: 3
 * - **实际时间**: 45分钟
 * - **复盘**: 低估了密码验证逻辑的复杂度
 * ```
 *
 * Design principle (Issue #1234): Use unstructured Markdown storage,
 * NOT structured data interfaces. Records include full reasoning process
 * for easy review and improvement.
 *
 * @module task/task-record
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskRecordManager');

/**
 * Task record entry representing a completed task execution.
 */
export interface TaskRecordEntry {
  /** Task title (extracted from Task.md) */
  title: string;
  /** Task type classification */
  type: 'bugfix' | 'feature' | 'refactoring' | 'docs' | 'test' | 'other';
  /** Task ID (messageId) */
  taskId: string;
  /** Number of executor-evaluator iterations */
  iterations: number;
  /** Approximate actual execution time */
  actualTime: string;
  /** Brief lesson learned / review comment */
  review: string;
  /** Record timestamp */
  timestamp?: Date;
}

/**
 * Task record manager for `.claude/task-records.md`.
 *
 * Issue #1234 Phase 1: Provides programmatic access to task records
 * for future ETA estimation phases.
 */
export class TaskRecordManager {
  private readonly recordFilePath: string;

  /**
   * Create a TaskRecordManager.
   *
   * @param workspaceDir - Workspace directory containing `.claude/`
   */
  constructor(workspaceDir: string) {
    this.recordFilePath = path.join(workspaceDir, '.claude', 'task-records.md');
  }

  /**
   * Get the path to the task records file.
   */
  getRecordFilePath(): string {
    return this.recordFilePath;
  }

  /**
   * Check if the task records file exists.
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.recordFilePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure the record file and parent directory exist.
   * Creates the file with template content if it doesn't exist.
   */
  async ensureFile(): Promise<void> {
    const dir = path.dirname(this.recordFilePath);

    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      logger.error({ err: error, dir }, 'Failed to create .claude directory');
      throw error;
    }

    if (!await this.exists()) {
      await fs.writeFile(this.recordFilePath, this.getTemplateContent(), 'utf-8');
      logger.info({ path: this.recordFilePath }, 'Task records file created');
    }
  }

  /**
   * Append a task record to the records file.
   *
   * Issue #1234: Records are appended in Markdown format for human readability
   * and LLM-based analysis.
   *
   * @param entry - Task record entry to append
   */
  async appendRecord(entry: TaskRecordEntry): Promise<void> {
    await this.ensureFile();

    const timestamp = entry.timestamp ?? new Date();
    const dateStr = timestamp.toISOString().replace('T', ' ').slice(0, 16);

    const record = `

### ${dateStr} ${entry.title}

- **类型**: ${entry.type}
- **Task ID**: ${entry.taskId}
- **迭代次数**: ${entry.iterations}
- **实际时间**: ${entry.actualTime}
- **复盘**: ${entry.review}
`;

    try {
      await fs.appendFile(this.recordFilePath, record, 'utf-8');
      logger.info({ taskId: entry.taskId, type: entry.type }, 'Task record appended');
    } catch (error) {
      logger.error({ err: error, taskId: entry.taskId }, 'Failed to append task record');
      throw error;
    }
  }

  /**
   * Read all task records from the file.
   *
   * @returns Raw Markdown content of the records file
   */
  async readRecords(): Promise<string> {
    try {
      return await fs.readFile(this.recordFilePath, 'utf-8');
    } catch (error) {
      logger.error({ err: error }, 'Failed to read task records');
      throw error;
    }
  }

  /**
   * Parse task records into structured entries.
   *
   * Extracts records from the Markdown format for programmatic access.
   *
   * @returns Array of parsed task record entries
   */
  async parseRecords(): Promise<TaskRecordEntry[]> {
    const content = await this.readRecords();
    const records: TaskRecordEntry[] = [];

    // Match record blocks: ### YYYY-MM-DD HH:mm title\n...### or EOF
    // Use .* instead of .+ to handle blank lines between title and body
    const recordRegex = /### (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) (.+)\n((?:(?!### ).*\n)*)/g;
    let match;

    while ((match = recordRegex.exec(content)) !== null) {
      const [, timestampStr, rawTitle, body] = match;
      const title = rawTitle.trim();

      const typeMatch = body.match(/\*\*类型\*\*:\s*(.+)/);
      const taskIdMatch = body.match(/\*\*Task ID\*\*:\s*(.+)/);
      const iterationsMatch = body.match(/\*\*迭代次数\*\*:\s*(\d+)/);
      const timeMatch = body.match(/\*\*实际时间\*\*:\s*(.+)/);
      const reviewMatch = body.match(/\*\*复盘\*\*:\s*(.+)/);

      if (taskIdMatch) {
        records.push({
          title,
          type: this.parseType(typeMatch?.[1]?.trim()),
          taskId: taskIdMatch[1].trim(),
          iterations: iterationsMatch ? parseInt(iterationsMatch[1], 10) : 0,
          actualTime: timeMatch?.[1]?.trim() ?? 'unknown',
          review: reviewMatch?.[1]?.trim() ?? '',
          timestamp: new Date(timestampStr),
        });
      }
    }

    return records;
  }

  /**
   * Search records by type.
   *
   * @param type - Task type to filter by
   * @returns Matching task records
   */
  async searchByType(type: TaskRecordEntry['type']): Promise<TaskRecordEntry[]> {
    const records = await this.parseRecords();
    return records.filter(r => r.type === type);
  }

  /**
   * Search records by keyword in title or review.
   *
   * @param keyword - Keyword to search for
   * @returns Matching task records
   */
  async searchByKeyword(keyword: string): Promise<TaskRecordEntry[]> {
    const lowerKeyword = keyword.toLowerCase();
    const records = await this.parseRecords();
    return records.filter(r =>
      r.title.toLowerCase().includes(lowerKeyword) ||
      r.review.toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * Get aggregate statistics from records.
   */
  async getStats(): Promise<{
    totalRecords: number;
    byType: Record<string, number>;
    averageIterations: number;
  }> {
    const records = await this.parseRecords();
    const byType: Record<string, number> = {};

    for (const record of records) {
      byType[record.type] = (byType[record.type] ?? 0) + 1;
    }

    return {
      totalRecords: records.length,
      byType,
      averageIterations: records.length > 0
        ? records.reduce((sum, r) => sum + r.iterations, 0) / records.length
        : 0,
    };
  }

  /**
   * Parse task type from string, normalizing to known types.
   */
  private parseType(raw?: string): TaskRecordEntry['type'] {
    if (!raw) {return 'other';}
    const normalized = raw.toLowerCase();
    const knownTypes: TaskRecordEntry['type'][] = ['bugfix', 'feature', 'refactoring', 'docs', 'test', 'other'];
    return knownTypes.includes(normalized as TaskRecordEntry['type'])
      ? (normalized as TaskRecordEntry['type'])
      : 'other';
  }

  /**
   * Get the initial template content for task-records.md.
   */
  private getTemplateContent(): string {
    return `# 任务执行记录

> 本文件记录所有通过 deep-task 系统执行的任务，用于 ETA 预估系统的学习基础。
>
> 格式说明：
> - **类型**: feature / bugfix / refactoring / docs / test / other
> - **估计时间**: 任务开始前的预估（如有）
> - **实际时间**: 从任务创建到完成的实际耗时
> - **迭代次数**: executor-evaluator 循环的次数
> - **复盘**: 简要总结经验教训

---

## 记录格式

\`\`\`markdown
### {YYYY-MM-DD HH:mm} {任务标题}

- **类型**: {类型}
- **Task ID**: {taskId}
- **迭代次数**: {N}
- **实际时间**: {X分钟/小时}
- **复盘**: {经验教训}
\`\`\`

---

<!-- 任务记录将自动追加在下方 -->
`;
  }
}
