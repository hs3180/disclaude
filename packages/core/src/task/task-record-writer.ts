/**
 * Task Record Writer - Appends task execution records as unstructured Markdown.
 *
 * Records are accumulated in `.claude/task-records.md` as a project knowledge log.
 * Each record captures what task was executed, when it started/ended,
 * how long it took, and whether it succeeded.
 *
 * Design Principle (Issue #1234):
 * - Use unstructured Markdown for free-form storage, NOT structured data
 * - Records include complete reasoning context for future review
 * - The file grows organically as tasks are executed
 *
 * @module task/task-record-writer
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskRecordWriter');

/**
 * Result of a task execution record.
 */
export type TaskExecutionResult = 'success' | 'failure' | 'error';

/**
 * Append a task execution record to `.claude/task-records.md`.
 *
 * The record is written as free-form Markdown, not structured data.
 * If the file doesn't exist, it's created with a header.
 * If it exists, the record is appended at the end.
 *
 * @param workspaceDir - Project workspace directory
 * @param record - Task execution record fields (plain strings, not structured interfaces)
 */
export async function recordTaskExecution(
  workspaceDir: string,
  record: {
    /** Task name or brief description */
    taskName: string;
    /** When the task started (ISO timestamp or readable string) */
    startedAt: string;
    /** When the task ended (ISO timestamp or readable string) */
    endedAt: string;
    /** Duration in human-readable form (e.g. "3m 42s", "1h 15m") */
    duration: string;
    /** Execution result */
    result: TaskExecutionResult;
    /** Optional notes about what was done or why it failed */
    notes?: string;
  }
): Promise<void> {
  const recordsDir = path.join(workspaceDir, '.claude');
  const recordsPath = path.join(recordsDir, 'task-records.md');

  const resultEmoji = record.result === 'success' ? '✅' : record.result === 'failure' ? '❌' : '⚠️';

  const entry = `
## ${record.startedAt} ${record.taskName}

- **结果**: ${resultEmoji} ${record.result}
- **开始**: ${record.startedAt}
- **结束**: ${record.endedAt}
- **耗时**: ${record.duration}
${record.notes ? `- **备注**: ${record.notes}` : ''}
`;

  try {
    // Ensure .claude directory exists
    await fs.mkdir(recordsDir, { recursive: true });

    // Check if file exists
    let existingContent = '';
    try {
      existingContent = await fs.readFile(recordsPath, 'utf-8');
    } catch {
      // File doesn't exist yet, will create with header
    }

    const header = `# 任务执行记录

> 此文件由系统自动维护，记录每次任务执行的情况。
> 用于积累历史数据，支持未来的任务时间预估。

---

`;

    const content = existingContent
      ? existingContent + entry
      : header + entry;

    await fs.writeFile(recordsPath, content, 'utf-8');
    logger.info({ taskName: record.taskName, result: record.result, path: recordsPath }, 'Task execution recorded');
  } catch (error) {
    // Recording failure should never break task execution
    logger.error({ err: error, taskName: record.taskName }, 'Failed to write task record');
  }
}

/**
 * Format a duration from milliseconds to human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Human-readable duration (e.g. "3m 42s", "1h 15m 30s")
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60000) % 60;
  const hours = Math.floor(ms / 3600000);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
