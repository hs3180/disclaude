/**
 * Task status MCP tools implementation.
 *
 * Provides MCP tools for reading task status from the workspace tasks directory.
 * These tools enable any Agent (including independent reporting Agents) to
 * query task progress and status information.
 *
 * Status detection is file-based:
 * - **pending**: task.md exists, no final_result.md, no running.lock
 * - **running**: running.lock exists
 * - **completed**: final_result.md exists
 * - **failed**: failed.md exists
 *
 * Related: Issue #857 - Complex task auto-start with ETA and progress reporting.
 *
 * @module mcp-server/tools/task-status
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { createLogger } from '@disclaude/core';
import { getWorkspaceDir } from './credentials.js';
import type { TaskStatusResult, ListTasksResult, TaskInfo } from './types.js';

const logger = createLogger('TaskStatus');

/** Possible task statuses */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'unknown';

/**
 * Determine task status by checking file markers in the task directory.
 *
 * Detection order matters:
 * 1. final_result.md → completed
 * 2. failed.md → failed
 * 3. running.lock → running
 * 4. task.md exists → pending
 * 5. otherwise → unknown
 */
export function detectTaskStatus(taskDir: string): TaskStatus {
  // completed: final_result.md exists
  if (fsSync.existsSync(path.join(taskDir, 'final_result.md'))) {
    return 'completed';
  }
  // failed: failed.md exists
  if (fsSync.existsSync(path.join(taskDir, 'failed.md'))) {
    return 'failed';
  }
  // running: running.lock exists
  if (fsSync.existsSync(path.join(taskDir, 'running.lock'))) {
    return 'running';
  }
  // pending: task.md exists (task created but not yet started)
  if (fsSync.existsSync(path.join(taskDir, 'task.md'))) {
    return 'pending';
  }
  return 'unknown';
}

/**
 * Extract the title from a task.md file.
 * Looks for the first H1 heading (# Title) or falls back to directory name.
 */
async function extractTaskTitle(taskDir: string, taskId: string): Promise<string> {
  const taskMdPath = path.join(taskDir, 'task.md');
  try {
    const content = await fs.readFile(taskMdPath, 'utf-8');
    // Match first H1 heading: # Task: Some Title
    const match = content.match(/^#\s+Task:\s+(.+)$/m);
    if (match) {
      return match[1].trim();
    }
    // Fallback: first line starting with #
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      return headingMatch[1].trim();
    }
  } catch {
    // File doesn't exist or can't be read
  }
  return taskId;
}

/**
 * Extract metadata from task.md (Task ID, Created time, Chat ID).
 */
async function extractTaskMetadata(taskDir: string): Promise<{
  taskId?: string;
  created?: string;
  chatId?: string;
}> {
  const taskMdPath = path.join(taskDir, 'task.md');
  try {
    const content = await fs.readFile(taskMdPath, 'utf-8');
    const taskIdMatch = content.match(/\*\*Task ID\*\*:\s*(.+)/);
    const createdMatch = content.match(/\*\*Created\*\*:\s*(.+)/);
    const chatIdMatch = content.match(/\*\*Chat ID\*\*:\s*(.+)/);
    return {
      taskId: taskIdMatch?.[1]?.trim(),
      created: createdMatch?.[1]?.trim(),
      chatId: chatIdMatch?.[1]?.trim(),
    };
  } catch {
    return {};
  }
}

/**
 * Count iteration directories (iter-1, iter-2, etc.) in a task directory.
 */
async function countIterations(taskDir: string): Promise<number> {
  const iterationsDir = path.join(taskDir, 'iterations');
  try {
    const entries = await fs.readdir(iterationsDir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && /^iter-\d+$/.test(e.name)).length;
  } catch {
    return 0;
  }
}

/**
 * Get file modification time as ISO string.
 */
async function getFileMtime(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtime.toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Get the last activity timestamp for a task.
 * Checks task.md, running.lock, final_result.md, and latest iteration file.
 */
async function getLastActivity(taskDir: string): Promise<string | undefined> {
  const filesToCheck = [
    path.join(taskDir, 'final_result.md'),
    path.join(taskDir, 'failed.md'),
    path.join(taskDir, 'running.lock'),
    path.join(taskDir, 'task.md'),
  ];

  let latestTime: string | undefined;

  for (const filePath of filesToCheck) {
    const mtime = await getFileMtime(filePath);
    if (mtime && (!latestTime || mtime > latestTime)) {
      latestTime = mtime;
    }
  }

  // Also check latest iteration
  const iterationsDir = path.join(taskDir, 'iterations');
  try {
    const entries = await fs.readdir(iterationsDir, { withFileTypes: true });
    const iterDirs = entries
      .filter(e => e.isDirectory() && /^iter-\d+$/.test(e.name))
      .sort((a, b) => {
        const numA = parseInt(a.name.split('-')[1], 10);
        const numB = parseInt(b.name.split('-')[1], 10);
        return numB - numA; // descending
      });

    if (iterDirs.length > 0) {
      const latestIterDir = path.join(iterationsDir, iterDirs[0].name);
      // Check evaluation.md and execution.md in the latest iteration
      for (const file of ['evaluation.md', 'execution.md']) {
        const mtime = await getFileMtime(path.join(latestIterDir, file));
        if (mtime && (!latestTime || mtime > latestTime)) {
          latestTime = mtime;
        }
      }
    }
  } catch {
    // iterations dir doesn't exist
  }

  return latestTime;
}

/**
 * Build a TaskInfo object from a task directory.
 */
async function buildTaskInfo(
  taskDir: string,
  taskId: string
): Promise<TaskInfo> {
  const status = detectTaskStatus(taskDir);
  const [title, metadata, iterations, lastActivity] = await Promise.all([
    extractTaskTitle(taskDir, taskId),
    extractTaskMetadata(taskDir),
    countIterations(taskDir),
    getLastActivity(taskDir),
  ]);

  return {
    taskId,
    title,
    status,
    iterations,
    created: metadata.created,
    chatId: metadata.chatId,
    lastActivity,
  };
}

/**
 * List all tasks in the workspace with their status.
 *
 * @returns List of task info objects
 */
export async function list_tasks(): Promise<ListTasksResult> {
  const workspaceDir = getWorkspaceDir();
  const tasksDir = path.join(workspaceDir, 'tasks');

  try {
    await fs.access(tasksDir);
  } catch {
    return {
      success: true,
      tasks: [],
      message: 'No tasks directory found',
    };
  }

  try {
    const entries = await fs.readdir(tasksDir, { withFileTypes: true });
    const taskDirs = entries.filter(e => e.isDirectory());

    if (taskDirs.length === 0) {
      return {
        success: true,
        tasks: [],
        message: 'No tasks found',
      };
    }

    const tasks: TaskInfo[] = [];
    for (const entry of taskDirs) {
      const taskDir = path.join(tasksDir, entry.name);
      const taskInfo = await buildTaskInfo(taskDir, entry.name);
      tasks.push(taskInfo);
    }

    // Sort by lastActivity descending (most recent first)
    tasks.sort((a, b) => {
      if (a.lastActivity && b.lastActivity) {
        return b.lastActivity.localeCompare(a.lastActivity);
      }
      if (a.lastActivity) return -1;
      if (b.lastActivity) return 1;
      return 0;
    });

    logger.info({ count: tasks.length }, 'Listed tasks');

    return {
      success: true,
      tasks,
      message: `Found ${tasks.length} task(s)`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, 'Failed to list tasks');
    return {
      success: false,
      tasks: [],
      message: `Failed to list tasks: ${message}`,
    };
  }
}

/**
 * Get detailed status of a specific task.
 *
 * @param taskId - Task identifier (directory name in tasks/)
 * @returns Detailed task status information
 */
export async function get_task_status(taskId: string): Promise<TaskStatusResult> {
  if (!taskId || typeof taskId !== 'string') {
    return {
      success: false,
      message: 'Invalid taskId: must be a non-empty string',
    };
  }

  const workspaceDir = getWorkspaceDir();
  const tasksDir = path.join(workspaceDir, 'tasks');

  // Sanitize taskId to prevent directory traversal
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const taskDir = path.join(tasksDir, sanitized);

  // Verify the task directory exists
  try {
    await fs.access(taskDir);
  } catch {
    return {
      success: false,
      message: `Task not found: ${taskId}`,
    };
  }

  try {
    const taskInfo = await buildTaskInfo(taskDir, sanitized);

    // Read the full task.md content for detailed view
    let taskContent: string | undefined;
    try {
      taskContent = await fs.readFile(path.join(taskDir, 'task.md'), 'utf-8');
    } catch {
      // task.md doesn't exist
    }

    // Read final_result.md if task is completed
    let finalResult: string | undefined;
    if (taskInfo.status === 'completed') {
      try {
        finalResult = await fs.readFile(path.join(taskDir, 'final_result.md'), 'utf-8');
      } catch {
        // final_result.md doesn't exist
      }
    }

    // Read failed.md if task is failed
    let failureReason: string | undefined;
    if (taskInfo.status === 'failed') {
      try {
        failureReason = await fs.readFile(path.join(taskDir, 'failed.md'), 'utf-8');
      } catch {
        // failed.md doesn't exist
      }
    }

    // Read latest evaluation if available
    let latestEvaluation: string | undefined;
    const iterations = taskInfo.iterations;
    if (iterations > 0) {
      try {
        latestEvaluation = await fs.readFile(
          path.join(taskDir, 'iterations', `iter-${iterations}`, 'evaluation.md'),
          'utf-8'
        );
      } catch {
        // evaluation.md doesn't exist for latest iteration
      }
    }

    logger.info({ taskId: sanitized, status: taskInfo.status }, 'Got task status');

    return {
      success: true,
      message: `Task status: ${taskInfo.status}`,
      task: taskInfo,
      taskContent,
      finalResult,
      failureReason,
      latestEvaluation,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, taskId: sanitized }, 'Failed to get task status');
    return {
      success: false,
      message: `Failed to get task status: ${message}`,
    };
  }
}
