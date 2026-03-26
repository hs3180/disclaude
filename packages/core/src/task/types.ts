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
 * Task execution status enum.
 * Derived from task file state, not explicitly stored.
 */
export type TaskExecutionStatus =
  | 'unknown'      // Task directory not found or no task.md
  | 'created'      // task.md exists but no iterations yet
  | 'iterating'    // Has iteration directories, no final_result.md
  | 'completed'    // final_result.md exists
  | 'error';       // Latest evaluation indicates error/failure

/**
 * Structured task status information.
 * Computed by TaskStatusReader from existing task files.
 *
 * Issue #857: Provides task context for the Reporter Agent
 * to intelligently decide when and what to report.
 */
export interface TaskStatusInfo {
  /** Task identifier (typically messageId) */
  taskId: string;
  /** Derived execution status */
  status: TaskExecutionStatus;
  /** Task title extracted from task.md header */
  title: string;
  /** Task description extracted from task.md */
  description: string;
  /** Chat ID associated with the task */
  chatId: string;
  /** Current iteration number (0 if not started) */
  currentIteration: number;
  /** Total iteration count */
  totalIterations: number;
  /** Whether final_result.md exists (task is complete) */
  hasFinalResult: boolean;
  /** Whether final-summary.md exists */
  hasFinalSummary: boolean;
  /** ISO timestamp of task creation (from task.md metadata) */
  createdAt: string;
  /** ISO timestamp of latest file modification */
  updatedAt: string;
  /** Summary of the latest evaluation content (if available) */
  latestEvaluationSummary: string;
  /** Summary of the latest execution content (if available) */
  latestExecutionSummary: string;
}
