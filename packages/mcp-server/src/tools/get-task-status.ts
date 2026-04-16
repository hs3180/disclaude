/**
 * get_task_status MCP tool - Reads task context for progress reporting.
 *
 * Issue #857: Provides a way for the Reporter Agent to read the current
 * task execution status from the shared TaskContext.
 *
 * This tool reads the `context.json` file in the task directory and returns
 * a structured summary that can be used to generate progress cards.
 *
 * @module mcp-server/tools/get-task-status
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getWorkspaceDir } from './credentials.js';
import { createLogger } from '@disclaude/core';

const logger = createLogger('GetTaskStatus');

/**
 * Result type for get_task_status tool.
 */
export interface GetTaskStatusResult {
  success: boolean;
  message: string;
  taskStatus?: {
    taskId: string;
    status: string;
    description: string;
    currentActivity?: string;
    steps: Array<{
      name: string;
      status: string;
    }>;
    completedSteps: number;
    totalSteps: number;
    iterationsCompleted: number;
    filesModified: string[];
    startedAt?: string;
    completedAt?: string;
    elapsedMs?: number | null;
    error?: string;
  };
}

/**
 * Format elapsed time in human-readable form.
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) {return `${ms}ms`;}
  if (ms < 60_000) {return `${(ms / 1000).toFixed(1)}s`;}
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * get_task_status tool handler.
 *
 * Reads the TaskContext for a given task ID and returns a progress summary.
 *
 * @param params - Tool parameters
 * @param params.taskId - The task ID to query (typically messageId)
 */
export async function get_task_status(params: {
  taskId: string;
}): Promise<GetTaskStatusResult> {
  const { taskId } = params;
  const workspaceDir = getWorkspaceDir();
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const contextPath = path.join(workspaceDir, 'tasks', sanitized, 'context.json');

  try {
    const raw = await fs.readFile(contextPath, 'utf-8');
    const data = JSON.parse(raw);

    const completedSteps = data.steps?.filter(
      (s: { status: string }) => s.status === 'completed'
    ).length || 0;
    const totalSteps = data.steps?.length || 0;

    let elapsedMs: number | null = null;
    if (data.startedAt) {
      const end = data.completedAt ? new Date(data.completedAt) : new Date();
      const start = new Date(data.startedAt);
      elapsedMs = end.getTime() - start.getTime();
    }

    const statusIcon: Record<string, string> = {
      pending: '⏳',
      running: '🔄',
      completed: '✅',
      failed: '❌',
    };

    const icon = statusIcon[data.status] || '❓';
    const elapsed = elapsedMs !== null ? formatElapsed(elapsedMs) : 'N/A';

    const stepSummary = data.steps?.map(
      (s: { name: string; status: string }) => {
        const stepIcon: Record<string, string> = {
          pending: '⬜',
          running: '🔄',
          completed: '✅',
          failed: '❌',
          skipped: '⏭️',
        };
        return `${stepIcon[s.status] || '❓'} ${s.name}`;
      }
    ).join('\n') || 'No steps defined';

    const message = [
      `${icon} Task: ${data.description}`,
      `Status: ${data.status} | Progress: ${completedSteps}/${totalSteps} steps | Elapsed: ${elapsed}`,
      data.currentActivity ? `Current: ${data.currentActivity}` : '',
      data.error ? `Error: ${data.error}` : '',
      `Iterations: ${data.iterationsCompleted || 0} | Files: ${(data.filesModified || []).length}`,
      '',
      'Steps:',
      stepSummary,
    ].filter(Boolean).join('\n');

    return {
      success: true,
      message,
      taskStatus: {
        taskId: data.taskId,
        status: data.status,
        description: data.description,
        currentActivity: data.currentActivity,
        steps: data.steps?.map((s: { name: string; status: string }) => ({
          name: s.name,
          status: s.status,
        })) || [],
        completedSteps,
        totalSteps,
        iterationsCompleted: data.iterationsCompleted || 0,
        filesModified: data.filesModified || [],
        startedAt: data.startedAt,
        completedAt: data.completedAt,
        elapsedMs,
        error: data.error,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        success: false,
        message: `No task context found for task ID: ${taskId}`,
      };
    }
    logger.error({ err: error, taskId }, 'Failed to read task status');
    return {
      success: false,
      message: `Failed to read task status: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
