/**
 * Task Context MCP Tools - Inline tool definitions for task status management.
 *
 * Provides tools for agents to read and update task context during execution.
 * These are inline tool definitions that can be registered with any agent.
 *
 * Tools:
 * - get_current_task_status: Read current task context (read-only, for Reporter)
 * - update_task_status: Update task context (write, for Executor/Evaluator)
 *
 * Issue #857: Independent Reporter Agent pattern
 *
 * @module task/task-context-tools
 */

import { TaskContext, type TaskContextData, type TaskPhase, formatDuration } from './task-context.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for task context tools.
 */
export interface TaskContextToolsOptions {
  /** Workspace directory path */
  workspaceDir: string;
}

/**
 * Input for get_current_task_status tool.
 */
export interface GetTaskStatusInput {
  /** Task ID to query. If omitted, returns all active tasks. */
  taskId?: string;
}

/**
 * Input for update_task_status tool.
 */
export interface UpdateTaskStatusInput {
  /** Task ID to update */
  taskId: string;
  /** New task phase */
  phase?: TaskPhase;
  /** Current iteration number */
  iteration?: number;
  /** Progress percentage (0-100) */
  progress?: number;
  /** Description of current activity */
  currentActivity?: string;
  /** Error message (if task failed) */
  error?: string;
  /** Mark a milestone as completed */
  completeMilestone?: string;
  /** Mark task as completed */
  markCompleted?: boolean;
  /** Mark task as failed */
  markFailed?: boolean;
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get current task status.
 *
 * If taskId is provided, returns status for that specific task.
 * If omitted, returns a summary of all active tasks.
 *
 * @param input - Tool input
 * @param options - Tool options
 * @returns Formatted status string
 */
export async function getTaskStatus(
  input: GetTaskStatusInput,
  options: TaskContextToolsOptions
): Promise<string> {
  const { workspaceDir } = options;

  if (input.taskId) {
    // Get specific task status
    const ctx = await TaskContext.tryLoad(input.taskId, workspaceDir);
    if (!ctx) {
      return `❓ Task ${input.taskId} not found or has no context.`;
    }
    return await ctx.getFormattedStatus();
  }

  // Get all active tasks
  const activeTasks = await TaskContext.listActive(workspaceDir);

  if (activeTasks.length === 0) {
    return '📭 No active tasks found.';
  }

  const lines = [`📊 **${activeTasks.length} Active Task(s)**`, ''];

  for (const task of activeTasks) {
    const phaseEmoji: Record<string, string> = {
      pending: '⏳',
      defining: '📝',
      executing: '⚙️',
      evaluating: '🔍',
      reflecting: '🤔',
      reporting: '📊',
    };
    const emoji = phaseEmoji[task.phase] || '❓';
    const elapsed = formatDuration(task.elapsedMs);
    const eta = task.etaMs !== null ? formatDuration(task.etaMs) : '...';

    lines.push(`${emoji} **${task.title}** (${task.taskId})`);
    lines.push(`   ${task.phase} | ${task.progress}% | ${elapsed} elapsed | ETA: ${eta}`);
    lines.push(`   ${task.currentActivity}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Update task status.
 *
 * Updates the specified task context with the provided changes.
 * At least one update field must be provided.
 *
 * @param input - Tool input
 * @param options - Tool options
 * @returns Confirmation message
 */
export async function updateTaskStatus(
  input: UpdateTaskStatusInput,
  options: TaskContextToolsOptions
): Promise<string> {
  const { workspaceDir } = options;

  const ctx = await TaskContext.tryLoad(input.taskId, workspaceDir);
  if (!ctx) {
    return `❌ Task context not found for task: ${input.taskId}\n\nMake sure to create a TaskContext before updating it.`;
  }

  const updates: Partial<TaskContextData> = {};

  if (input.phase) updates.phase = input.phase;
  if (input.iteration !== undefined) updates.iteration = input.iteration;
  if (input.progress !== undefined) updates.progress = Math.max(0, Math.min(100, input.progress));
  if (input.currentActivity) updates.currentActivity = input.currentActivity;
  if (input.error) updates.error = input.error;

  // Handle completion
  if (input.markCompleted) {
    updates.phase = 'completed';
    updates.progress = 100;
    updates.etaMs = 0;
    updates.currentActivity = updates.currentActivity || 'Task completed successfully';
  }

  // Handle failure
  if (input.markFailed) {
    updates.phase = 'failed';
    updates.error = updates.error || 'Task failed';
    updates.currentActivity = `Task failed: ${updates.error}`;
  }

  // Apply updates
  if (Object.keys(updates).length > 0) {
    await ctx.update(updates);
  }

  // Handle milestone
  if (input.completeMilestone) {
    await ctx.setMilestone(input.completeMilestone, true);
  }

  // Return updated status
  const updatedData = await ctx.read();
  if (!updatedData) {
    return `✅ Task ${input.taskId} updated (unable to read back status)`;
  }

  return `✅ Task ${input.taskId} updated successfully\n\n${await ctx.getFormattedStatus()}`;
}

/**
 * Create a new task context.
 *
 * This is typically called when a deep task starts.
 *
 * @param taskId - Task identifier
 * @param options - Task context creation options
 * @param toolOptions - Tool options
 * @returns Confirmation message
 */
export async function createTaskContext(
  taskId: string,
  options: {
    title: string;
    description?: string;
    chatId: string;
    userId?: string;
    maxIterations?: number;
  },
  toolOptions: TaskContextToolsOptions
): Promise<string> {
  const ctx = await TaskContext.create(taskId, toolOptions.workspaceDir, options);
  return `✅ TaskContext created for task: ${taskId}\nPath: ${ctx.getContextPath()}`;
}
