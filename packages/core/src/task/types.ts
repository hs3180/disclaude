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
 * Task progress status.
 * @since Issue #857
 */
export type TaskProgressStatus = 'in_progress' | 'completed' | 'failed' | 'paused';

/**
 * Task progress update data.
 * Written to progress.md in the task directory.
 *
 * @since Issue #857
 */
export interface TaskProgress {
  /** Task identifier (messageId) */
  taskId: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Current status */
  status: TaskProgressStatus;
  /** Human-readable description of current activity */
  message: string;
  /** List of completed steps */
  completedSteps: string[];
  /** List of remaining steps */
  remainingSteps: string[];
  /** ISO 8601 timestamp when progress was last updated */
  updatedAt: string;
  /** ISO 8601 timestamp when task started */
  startedAt: string;
}
