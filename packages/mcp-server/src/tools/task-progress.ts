/**
 * Task progress MCP tool for reading deep task status.
 *
 * This tool allows agents (including the independent Reporter Agent)
 * to read the current progress of running deep tasks.
 *
 * Part of Issue #857: Deep task progress reporting with independent Reporter Agent.
 *
 * @module mcp-server/tools/task-progress
 */

import { createLogger } from '@disclaude/core';
import { getWorkspaceDir } from './credentials.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const logger = createLogger('TaskProgress');

/**
 * Result structure for task progress queries.
 */
export interface TaskProgressResult {
  success: boolean;
  message: string;
  tasks?: TaskProgressInfo[];
  task?: TaskProgressInfo;
}

/**
 * Simplified task progress info returned by MCP tool.
 */
export interface TaskProgressInfo {
  taskId: string;
  chatId: string;
  title: string;
  status: string;
  phase: string;
  currentStep: string | null;
  completedStepsCount: number;
  plannedSteps: string[];
  elapsed: string | null;
  metrics: {
    filesModified: number;
    testsRun: number;
    testsPassed: number;
    toolsInvoked: number;
  };
  currentIteration: number;
  error: string | null;
}

/**
 * Read a task-context.json file and return simplified progress info.
 */
function toProgressInfo(ctx: Record<string, unknown>): TaskProgressInfo {
  const startedAt = ctx.startedAt as string | null;
  const completedAt = ctx.completedAt as string | null;

  let elapsed: string | null = null;
  if (startedAt) {
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    const ms = end - new Date(startedAt).getTime();
    elapsed = formatMs(ms);
  }

  const metrics = ctx.metrics as Record<string, number> | undefined;

  return {
    taskId: ctx.taskId as string,
    chatId: ctx.chatId as string,
    title: ctx.title as string,
    status: ctx.status as string,
    phase: ctx.phase as string,
    currentStep: ctx.currentStep as string | null,
    completedStepsCount: (ctx.completedSteps as unknown[])?.length ?? 0,
    plannedSteps: (ctx.plannedSteps as string[]) ?? [],
    elapsed,
    metrics: {
      filesModified: metrics?.filesModified ?? 0,
      testsRun: metrics?.testsRun ?? 0,
      testsPassed: metrics?.testsPassed ?? 0,
      toolsInvoked: metrics?.toolsInvoked ?? 0,
    },
    currentIteration: ctx.currentIteration as number,
    error: ctx.error as string | null,
  };
}

/**
 * Format milliseconds as human-readable string.
 */
function formatMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {return `${hours}h ${minutes % 60}m`;}
  if (minutes > 0) {return `${minutes}m ${seconds % 60}s`;}
  return `${seconds}s`;
}

/**
 * Get the tasks directory path.
 */
function getTasksDir(): string {
  return path.join(getWorkspaceDir(), 'tasks');
}

/**
 * Read a single task context from disk.
 */
async function readTaskContext(taskId: string): Promise<Record<string, unknown> | null> {
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const contextPath = path.join(getTasksDir(), sanitized, 'task-context.json');

  try {
    const data = await fs.readFile(contextPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Read all task contexts from disk.
 */
async function readAllTaskContexts(): Promise<Record<string, unknown>[]> {
  const tasksDir = getTasksDir();
  const contexts: Record<string, unknown>[] = [];

  try {
    const entries = await fs.readdir(tasksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      const contextPath = path.join(tasksDir, entry.name, 'task-context.json');
      try {
        const data = await fs.readFile(contextPath, 'utf-8');
        contexts.push(JSON.parse(data));
      } catch {
        // Skip tasks without context
      }
    }
  } catch {
    // Tasks directory doesn't exist
  }

  return contexts;
}

/**
 * Get current task status by task ID.
 *
 * Returns the full progress information for a specific deep task,
 * including current step, completed steps, elapsed time, and metrics.
 *
 * @param params.taskId - The task ID to query
 */
export async function get_task_status(params: {
  taskId: string;
}): Promise<TaskProgressResult> {
  const { taskId } = params;

  logger.info({ taskId }, 'get_task_status called');

  try {
    if (!taskId) {
      return { success: false, message: 'taskId is required' };
    }

    const ctx = await readTaskContext(taskId);
    if (!ctx) {
      return {
        success: false,
        message: `No task context found for task ID: ${taskId}`,
      };
    }

    const info = toProgressInfo(ctx);
    return {
      success: true,
      message: `Task "${info.title}" — ${info.status} (${info.phase})`,
      task: info,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, taskId }, 'get_task_status failed');
    return { success: false, message: `Failed to get task status: ${msg}` };
  }
}

/**
 * List all active (pending/running) deep tasks.
 *
 * Returns a summary of all tasks currently in progress,
 * useful for the Reporter Agent to find tasks to report on.
 */
export async function list_active_tasks(): Promise<TaskProgressResult> {
  logger.info('list_active_tasks called');

  try {
    const allContexts = await readAllTaskContexts();
    const active = allContexts.filter(
      ctx => ctx.status === 'pending' || ctx.status === 'running'
    );

    if (active.length === 0) {
      return {
        success: true,
        message: 'No active tasks found',
        tasks: [],
      };
    }

    const tasks = active.map(toProgressInfo);
    return {
      success: true,
      message: `${tasks.length} active task(s) found`,
      tasks,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error }, 'list_active_tasks failed');
    return { success: false, message: `Failed to list active tasks: ${msg}` };
  }
}
