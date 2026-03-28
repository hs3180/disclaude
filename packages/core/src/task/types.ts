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
 * Task status enum for progress tracking.
 * Issue #857: Used by getTaskStatus to report task state.
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'not_found';

/**
 * Task status information returned by getTaskStatus.
 * Issue #857: Provides comprehensive task state for Reporter Agent.
 */
export interface TaskStatusInfo {
  /** Task identifier */
  taskId: string;
  /** Current task status */
  status: TaskStatus;
  /** Task title (extracted from task.md first heading) */
  title: string | null;
  /** Task description (from task.md) */
  description: string | null;
  /** Total number of iterations completed */
  totalIterations: number;
  /** Latest iteration number (0 if no iterations) */
  latestIteration: number;
  /** Whether a final result exists */
  hasFinalResult: boolean;
  /** Whether a final summary exists */
  hasFinalSummary: boolean;
  /** ISO timestamp of task creation (from task.md frontmatter or file stats) */
  createdAt: string | null;
  /** ISO timestamp of last activity (from file stats) */
  lastModified: string | null;
  /** Elapsed time in seconds since task creation */
  elapsedSeconds: number | null;
  /** Whether the task is currently running (has running.lock) */
  isRunning: boolean;
  /** Path to the task directory */
  taskDir: string;
}
