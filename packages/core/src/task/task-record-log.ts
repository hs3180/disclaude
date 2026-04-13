/**
 * Task Record Log — Non-structured Markdown task record system.
 *
 * Stores task execution records as free-form Markdown in `.claude/task-records.md`.
 * Designed for human and LLM readability, NOT structured data storage.
 *
 * Storage format (each task is a Markdown section):
 *
 * ```markdown
 * # 任务记录
 *
 * ## 2024-03-10 重构登录模块
 *
 * - **类型**: refactoring
 * - **估计时间**: 30分钟
 * - **估计依据**: 类似之前的表单重构，当时花了25分钟
 * - **实际时间**: 45分钟
 * - **复盘**: 低估了密码验证逻辑的复杂度，下次遇到类似模块应预留更多时间
 * ```
 *
 * Design principle (from Issue #1234):
 * - ⚠️ Use non-structured Markdown free storage, NOT structured data
 * - Records contain full estimation reasoning for review and improvement
 * - No TypeScript interfaces for storage — just Markdown text
 *
 * @module task/task-record-log
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskRecordLog');

/** Default filename for task records */
const TASK_RECORDS_FILENAME = 'task-records.md';

/** Header for the task records file */
const FILE_HEADER = '# 任务记录\n';

/**
 * Get the file path for task records.
 * @param workspaceDir - Workspace directory
 * @returns Path to `.claude/task-records.md`
 */
export function getTaskRecordsPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.claude', TASK_RECORDS_FILENAME);
}

/**
 * Ensure the `.claude` directory exists and initialize the file header if needed.
 *
 * @param workspaceDir - Workspace directory
 */
async function ensureFile(workspaceDir: string): Promise<void> {
  const claudeDir = path.join(workspaceDir, '.claude');
  const filePath = getTaskRecordsPath(workspaceDir);

  try {
    await fs.mkdir(claudeDir, { recursive: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to create .claude directory');
    throw error;
  }

  try {
    await fs.access(filePath);
    // File exists, no need to create header
  } catch {
    // File doesn't exist, create with header
    try {
      await fs.writeFile(filePath, FILE_HEADER, 'utf-8');
      logger.debug({ filePath }, 'Task records file initialized');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize task records file');
      throw error;
    }
  }
}

/**
 * Append a task record to `.claude/task-records.md`.
 *
 * The record is stored as free-form Markdown. The caller provides raw Markdown
 * text for each field — no structured types are enforced.
 *
 * @param workspaceDir - Workspace directory
 * @param title - Task title (used as section heading)
 * @param markdownBody - Free-form Markdown body for this task record.
 *   Should contain estimation, actual time, and review notes.
 *   Example:
 *   ```
 *   - **类型**: bugfix
 *   - **估计时间**: 20分钟
 *   - **估计依据**: 之前的类似bug修了15分钟
 *   - **实际时间**: 25分钟
 *   - **复盘**: 需要先定位问题根源，比预期多花了些时间
 *   ```
 */
export async function appendTaskRecord(
  workspaceDir: string,
  title: string,
  markdownBody: string
): Promise<void> {
  await ensureFile(workspaceDir);

  const filePath = getTaskRecordsPath(workspaceDir);
  const [timestamp] = new Date().toISOString().split('T'); // YYYY-MM-DD

  const section = `\n## ${timestamp} ${title}\n\n${markdownBody}\n`;

  try {
    await fs.appendFile(filePath, section, 'utf-8');
    logger.info({ filePath, title }, 'Task record appended');
  } catch (error) {
    logger.error({ err: error, title }, 'Failed to append task record');
    throw error;
  }
}

/**
 * Read all task records from `.claude/task-records.md`.
 *
 * Returns the raw Markdown content. Parsing is left to the caller
 * (human or LLM) — no structured extraction is performed.
 *
 * @param workspaceDir - Workspace directory
 * @returns Raw Markdown content of the task records file, or empty string if not found
 */
export async function readTaskRecords(workspaceDir: string): Promise<string> {
  const filePath = getTaskRecordsPath(workspaceDir);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content;
  } catch (_error) {
    // File doesn't exist yet — return empty string
    logger.debug({ filePath }, 'Task records file not found, returning empty');
    return '';
  }
}

/**
 * Search task records by keyword.
 *
 * Returns sections (delimited by `## ` headings) that contain the keyword.
 * The search is case-insensitive and performed on the raw Markdown text.
 *
 * @param workspaceDir - Workspace directory
 * @param keyword - Search keyword (case-insensitive)
 * @returns Array of matching Markdown sections (each starting with `## `)
 */
export async function searchTaskRecords(
  workspaceDir: string,
  keyword: string
): Promise<string[]> {
  const content = await readTaskRecords(workspaceDir);
  if (!content) {
    return [];
  }

  const lowerKeyword = keyword.toLowerCase();
  const sections = content.split(/\n(?=## )/);

  return sections.filter(
    section => section.toLowerCase().includes(lowerKeyword)
  );
}
