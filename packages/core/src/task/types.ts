/**
 * Task module types.
 *
 * @module task/types
 */

/**
 * Message type for task execution messages.
 * Includes all SDK message types plus task-specific types.
 */
export type TaskMessageType =
  | 'text'           // 文本内容
  | 'tool_use'       // 工具调用开始
  | 'tool_progress'  // 工具执行中
  | 'tool_result'    // 工具执行完成
  | 'result'         // 查询完成
  | 'error'          // 错误
  | 'status'         // 系统状态
  | 'task_completion' // 任务完成
  | 'notification'   // 通知
  | 'max_iterations_warning'; // 最大迭代警告

/**
 * Task definition details interface.
 * Used by appendTaskDefinition for adding structured task details.
 */
export interface TaskDefinitionDetails {
  primary_goal: string;
  success_criteria: string[];
  expected_outcome: string;
  deliverables: string[];
  format_requirements: string[];
  constraints: string[];
  quality_criteria: string[];
}

/**
 * Task status derived from file-based state.
 */
export type TaskFileStatus = 'pending' | 'running' | 'completed' | 'failed' | 'unknown';

/**
 * Progress status for a task, derived from its file structure.
 */
export interface TaskProgressStatus {
  /** Task ID (typically the messageId) */
  taskId: string;
  /** Current status derived from file presence */
  status: TaskFileStatus;
  /** Task title extracted from task.md */
  title: string;
  /** Chat ID from task.md (for sending progress cards) */
  chatId: string | null;
  /** Number of completed iterations */
  currentIteration: number;
  /** Whether the task has a final result */
  hasFinalResult: boolean;
  /** Whether the task has a running lock */
  isRunning: boolean;
  /** Latest execution summary (from most recent execution.md) */
  latestExecutionSummary: string | null;
}
