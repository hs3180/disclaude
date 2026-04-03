/**
 * get_task_status tool implementation.
 *
 * Reads task directory structure and returns structured task status information.
 * Used by the Reporter Agent (task-progress skill) to monitor task progress.
 *
 * Issue #857: Provides task context for independent Reporter Agent.
 *
 * @module mcp-server/tools/get-task-status
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '@disclaude/core';
import { getWorkspaceDir } from './credentials.js';

const logger = createLogger('GetTaskStatus');

/**
 * Task status as determined by file presence.
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'not_found';

/**
 * Structured task status information.
 */
export interface TaskStatusInfo {
  /** Task ID (directory name) */
  taskId: string;
  /** Current status */
  status: TaskStatus;
  /** Task title extracted from task.md */
  title?: string;
  /** Number of completed iterations */
  iterations: number;
  /** ISO timestamp of when the task was created */
  createdAt?: string;
  /** ISO timestamp of the last progress update */
  lastProgressUpdate?: string;
  /** Current progress summary (from progress.md or last execution.md) */
  progressSummary?: string;
  /** Whether final_result.md exists */
  hasFinalResult: boolean;
  /** Whether running.lock exists */
  isRunning: boolean;
  /** Whether failed.md exists */
  isFailed: boolean;
  /** Error message from failed.md (if task failed) */
  errorMessage?: string;
  /** Max iterations from task.md frontmatter (default 10) */
  maxIterations: number;
  /** Files in the task directory */
  files: string[];
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns an object with frontmatter fields, or empty object if none.
 */
function parseFrontmatter(content: string): Record<string, string | number | boolean> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const frontmatter: Record<string, string | number | boolean> = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (!key) continue;

    // Parse value types
    if (value === 'true') frontmatter[key] = true;
    else if (value === 'false') frontmatter[key] = false;
    else if (!isNaN(Number(value)) && value !== '') frontmatter[key] = Number(value);
    else frontmatter[key] = value.replace(/^["']|["']$/g, '');
  }
  return frontmatter;
}

/**
 * Extract title from task.md content (first H1 heading).
 */
function extractTitle(content: string): string | undefined {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

/**
 * Get status of a specific task by task ID.
 *
 * @param params.taskId - Task identifier (typically message ID)
 * @returns Structured task status information
 */
export async function get_task_status(params: {
  taskId: string;
}): Promise<{ success: boolean; data?: TaskStatusInfo; error?: string }> {
  const { taskId } = params;

  if (!taskId) {
    return { success: false, error: 'taskId is required' };
  }

  try {
    const workspaceDir = getWorkspaceDir();
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const taskDir = path.join(workspaceDir, 'tasks', sanitized);

    // Check task directory exists
    try {
      await fs.access(taskDir);
    } catch {
      return { success: false, error: `Task not found: ${taskId}` };
    }

    // List files in task directory
    let files: string[];
    try {
      const entries = await fs.readdir(taskDir);
      files = entries;
    } catch {
      files = [];
    }

    // Check status files
    const hasFinalResult = files.includes('final_result.md');
    const isRunning = files.includes('running.lock');
    const isFailed = files.includes('failed.md');

    // Determine status
    let status: TaskStatus;
    if (hasFinalResult) {
      status = 'completed';
    } else if (isFailed) {
      status = 'failed';
    } else if (isRunning) {
      status = 'running';
    } else {
      status = 'pending';
    }

    // Read task.md for metadata
    let title: string | undefined;
    let createdAt: string | undefined;
    let maxIterations = 10;

    try {
      const taskContent = await fs.readFile(path.join(taskDir, 'task.md'), 'utf-8');
      const frontmatter = parseFrontmatter(taskContent);
      title = extractTitle(taskContent);
      createdAt = frontmatter['createdAt'] as string | undefined;
      if (typeof frontmatter['maxIterations'] === 'number') {
        maxIterations = frontmatter['maxIterations'];
      }
    } catch {
      // task.md might not exist or be unreadable
    }

    // Count iterations
    let iterations = 0;
    try {
      const iterDir = path.join(taskDir, 'iterations');
      const entries = await fs.readdir(iterDir, { withFileTypes: true });
      iterations = entries
        .filter(e => e.isDirectory() && e.name.startsWith('iter-'))
        .length;
    } catch {
      // iterations directory might not exist
    }

    // Read progress information
    let lastProgressUpdate: string | undefined;
    let progressSummary: string | undefined;

    // Try progress.md first
    try {
      const progressPath = path.join(taskDir, 'progress.md');
      const progressStat = await fs.stat(progressPath);
      lastProgressUpdate = progressStat.mtime.toISOString();

      const progressContent = await fs.readFile(progressPath, 'utf-8');
      // Extract first meaningful line as summary (skip headings and metadata)
      const lines = progressContent.split('\n').filter(l =>
        l.trim() && !l.startsWith('#') && !l.startsWith('**Updated**')
      );
      if (lines.length > 0) {
        progressSummary = lines[0].trim().substring(0, 200);
      }
    } catch {
      // progress.md doesn't exist, try last execution.md
    }

    // Fallback: read last execution.md for progress
    if (!progressSummary && iterations > 0) {
      try {
        const lastExecPath = path.join(taskDir, 'iterations', `iter-${iterations}`, 'execution.md');
        const execStat = await fs.stat(lastExecPath);
        if (!lastProgressUpdate || execStat.mtime.getTime() > new Date(lastProgressUpdate).getTime()) {
          lastProgressUpdate = execStat.mtime.toISOString();
        }

        const execContent = await fs.readFile(lastExecPath, 'utf-8');
        // Extract summary section
        const summaryMatch = execContent.match(/## Summary\s*\n([\s\S]*?)(?=\n## |$)/);
        if (summaryMatch) {
          progressSummary = summaryMatch[1].trim().substring(0, 200);
        }
      } catch {
        // execution.md might not exist
      }
    }

    // Read error message if failed
    let errorMessage: string | undefined;
    if (isFailed) {
      try {
        const failedContent = await fs.readFile(path.join(taskDir, 'failed.md'), 'utf-8');
        const lines = failedContent.split('\n').filter(l => l.trim() && !l.startsWith('#'));
        if (lines.length > 0) {
          errorMessage = lines.slice(0, 3).join('\n').substring(0, 300);
        }
      } catch {
        // failed.md might not be readable
      }
    }

    const data: TaskStatusInfo = {
      taskId,
      status,
      title,
      iterations,
      createdAt,
      lastProgressUpdate,
      progressSummary,
      hasFinalResult,
      isRunning,
      isFailed,
      errorMessage,
      maxIterations,
      files,
    };

    logger.debug({ taskId, status, iterations }, 'Task status retrieved');
    return { success: true, data };

  } catch (error) {
    logger.error({ err: error, taskId }, 'Failed to get task status');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

/**
 * List all tasks and their statuses.
 *
 * @returns Array of task status information for all tasks
 */
export async function list_tasks(): Promise<{ success: boolean; data?: TaskStatusInfo[]; error?: string }> {
  try {
    const workspaceDir = getWorkspaceDir();
    const tasksDir = path.join(workspaceDir, 'tasks');

    // Check tasks directory exists
    try {
      await fs.access(tasksDir);
    } catch {
      return { success: true, data: [] };
    }

    const entries = await fs.readdir(tasksDir, { withFileTypes: true });
    const taskDirs = entries.filter(e => e.isDirectory());

    const results: TaskStatusInfo[] = [];
    for (const dir of taskDirs) {
      const result = await get_task_status({ taskId: dir.name });
      if (result.success && result.data) {
        results.push(result.data);
      }
    }

    // Sort: running first, then pending, then completed, then failed
    const statusOrder: Record<TaskStatus, number> = {
      running: 0,
      pending: 1,
      completed: 2,
      failed: 3,
      not_found: 4,
    };
    results.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

    return { success: true, data: results };

  } catch (error) {
    logger.error({ err: error }, 'Failed to list tasks');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

/**
 * Write progress update for a task.
 * Creates or updates progress.md in the task directory.
 *
 * @param params.taskId - Task identifier
 * @param params.summary - Progress summary text
 * @param params.currentStep - Current step description (optional)
 * @param params.totalSteps - Total steps (optional)
 * @param params.nextStep - Next step description (optional)
 */
export async function update_task_progress(params: {
  taskId: string;
  summary: string;
  currentStep?: number;
  totalSteps?: number;
  nextStep?: string;
}): Promise<{ success: boolean; error?: string }> {
  const { taskId, summary, currentStep, totalSteps, nextStep } = params;

  if (!taskId || !summary) {
    return { success: false, error: 'taskId and summary are required' };
  }

  try {
    const workspaceDir = getWorkspaceDir();
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const taskDir = path.join(workspaceDir, 'tasks', sanitized);

    // Ensure task directory exists
    await fs.mkdir(taskDir, { recursive: true });

    const timestamp = new Date().toISOString();
    let content = `# Progress Update\n\n**Updated**: ${timestamp}\n\n## Summary\n\n${summary}\n`;

    if (currentStep !== undefined && totalSteps !== undefined) {
      content += `\n## Progress\n\n**Step**: ${currentStep} / ${totalSteps}\n`;
      // Simple progress bar
      const percent = Math.round((currentStep / totalSteps) * 100);
      const filled = Math.round(percent / 5);
      const empty = 20 - filled;
      content += `${'█'.repeat(filled)}${'░'.repeat(empty)} ${percent}%\n`;
    }

    if (nextStep) {
      content += `\n## Next Step\n\n${nextStep}\n`;
    }

    const progressPath = path.join(taskDir, 'progress.md');
    await fs.writeFile(progressPath, content, 'utf-8');

    logger.info({ taskId, summary: summary.substring(0, 50) }, 'Task progress updated');
    return { success: true };

  } catch (error) {
    logger.error({ err: error, taskId }, 'Failed to update task progress');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}
