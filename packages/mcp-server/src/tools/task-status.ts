/**
 * get_task_status tool implementation for reading task progress (Issue #857).
 *
 * This MCP tool enables the Reporter Agent to read current task status
 * and intelligently decide when/how to report progress to the user.
 *
 * Design: The agent calls this tool to read task context, then uses its own
 * judgment (guided by progress reporting guidance in MessageBuilder) to decide
 * whether to send a progress card, what to include, and how to format it.
 *
 * @module mcp-server/tools/task-status
 */

import { TaskContext, type TaskContextData } from '@disclaude/core';
import { getWorkspaceDir } from './credentials.js';
import type { SendMessageResult } from './types.js';

/**
 * Get the status of a running or completed task.
 *
 * Reads the TaskContext from disk and returns a structured summary
 * that the agent can use to decide whether and how to report progress.
 *
 * @param params.taskId - Task identifier (messageId)
 */
export async function get_task_status(params: {
  taskId: string;
}): Promise<SendMessageResult> {
  const { taskId } = params;

  try {
    if (!taskId) {
      return { success: false, error: 'taskId is required', message: '❌ taskId is required' };
    }

    const workspaceDir = getWorkspaceDir();
    if (!workspaceDir) {
      return { success: false, error: 'Workspace directory not configured', message: '❌ Workspace directory not configured' };
    }

    const ctx = await TaskContext.load({ workspaceDir }, taskId);
    if (!ctx) {
      return {
        success: false,
        error: `No task context found for taskId: ${taskId}`,
        message: `❌ No task context found for taskId: ${taskId}`,
      };
    }

    const data = ctx.getData();
    const summary = ctx.getSummary();

    // Build structured response
    const response = formatTaskStatusResponse(data, summary);

    return {
      success: true,
      message: response,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to get task status: ${errorMessage}`,
    };
  }
}

/**
 * Format task status as a readable response for the agent.
 */
function formatTaskStatusResponse(data: TaskContextData, summary: string): string {
  const parts: string[] = [
    '## Task Status',
    '',
    summary,
  ];

  // Add step details if available
  if (data.steps.length > 0) {
    parts.push('', '### Steps');
    for (let i = 0; i < data.steps.length; i++) {
      const step = data.steps[i];
      const icon = step.status === 'completed' ? '✅'
        : step.status === 'running' ? '🔄'
        : step.status === 'skipped' ? '⏭️'
        : '⬜';
      parts.push(`${icon} ${step.description}`);
    }
  }

  // Add guidance for the agent
  parts.push('');
  parts.push('### Reporting Guidance');
  if (data.status === 'completed') {
    parts.push('Task is **completed**. Consider sending a completion card to the user.');
  } else if (data.status === 'failed') {
    parts.push('Task has **failed**. Send an error notification to the user.');
  } else if (data.status === 'running') {
    parts.push('Task is **running**. Decide based on context:');
    parts.push('- Has enough time passed since last report?');
    parts.push('- Is there a significant milestone to report?');
    parts.push('- Would the user benefit from knowing current progress?');
  } else {
    parts.push('Task is **pending**. No need to report yet.');
  }

  return parts.join('\n');
}
