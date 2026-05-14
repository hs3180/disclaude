/**
 * Task status MCP tool implementations.
 *
 * Provides MCP tools for querying task progress from the filesystem.
 * These tools enable agents to read task status for progress reporting (Issue #857).
 *
 * @module mcp-server/tools/task-status
 */

import { TaskStatusProvider, TaskState, type DialogueTaskStatus, type DialogueTaskSummary } from '@disclaude/core';
import { getWorkspaceDir } from './credentials.js';

function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function toolError(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Format task status as human-readable text for MCP tool output.
 */
function formatTaskStatus(status: DialogueTaskStatus): string {
  const stateEmoji: Record<TaskState, string> = {
    [TaskState.PENDING]: '⏳',
    [TaskState.RUNNING]: '🔄',
    [TaskState.COMPLETED]: '✅',
    [TaskState.FINALIZED]: '🏁',
  };

  const lines: string[] = [
    `**Task**: ${status.title || status.taskId}`,
    `**State**: ${stateEmoji[status.state]} ${status.state}`,
    `**Task ID**: ${status.taskId}`,
    `**Iterations**: ${status.totalIterations}`,
  ];

  if (status.createdAt) {
    lines.push(`**Created**: ${status.createdAt}`);
  }

  if (status.hasFinalResult) {
    lines.push('**Result**: Final result available');
  }

  if (status.hasFinalSummary) {
    lines.push('**Summary**: Final summary available');
  }

  if (status.iterations.length > 0) {
    lines.push('', '---', '', '**Iteration Details**:', '');
    for (const iter of status.iterations) {
      const evalIcon = iter.hasEvaluation ? '✅' : '⬜';
      const execIcon = iter.hasExecution ? '✅' : '⬜';
      lines.push(
        `- **Iter ${iter.iteration}**: evaluation ${evalIcon} | execution ${execIcon} | steps: ${iter.stepCount}`
      );
    }
  }

  return lines.join('\n');
}

/**
 * Get detailed status of a specific task.
 *
 * @param taskId - Task identifier (message ID)
 * @returns Formatted task status
 */
export async function get_task_status({ taskId }: { taskId: string }): Promise<ReturnType<typeof toolSuccess | typeof toolError>> {
  try {
    const workspaceDir = getWorkspaceDir();
    const provider = new TaskStatusProvider(workspaceDir);
    const status = await provider.getTaskStatus(taskId);

    if (!status) {
      return toolError(`Task not found: ${taskId}`);
    }

    return toolSuccess(formatTaskStatus(status));
  } catch (error) {
    return toolError(`Failed to get task status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * List all tasks with summary information.
 *
 * @returns Formatted list of tasks
 */
export async function list_tasks(): Promise<ReturnType<typeof toolSuccess | typeof toolError>> {
  try {
    const workspaceDir = getWorkspaceDir();
    const provider = new TaskStatusProvider(workspaceDir);
    const tasks = await provider.listTasks();

    if (tasks.length === 0) {
      return toolSuccess('No tasks found.');
    }

    const stateEmoji: Record<TaskState, string> = {
      [TaskState.PENDING]: '⏳',
      [TaskState.RUNNING]: '🔄',
      [TaskState.COMPLETED]: '✅',
      [TaskState.FINALIZED]: '🏁',
    };

    const lines = tasks.map((t: DialogueTaskSummary) =>
      `- ${stateEmoji[t.state]} **${t.title || t.taskId}** (${t.state}, ${t.totalIterations} iterations)`
    );

    return toolSuccess(`**Tasks** (${tasks.length}):\n\n${lines.join('\n')}`);
  } catch (error) {
    return toolError(`Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`);
  }
}
