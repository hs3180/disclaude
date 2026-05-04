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
 * Task type classification for ETA estimation (Issue #1234).
 */
export type TaskType =
  | 'bugfix'
  | 'feature-small'
  | 'feature-medium'
  | 'feature-large'
  | 'refactoring'
  | 'test'
  | 'documentation'
  | 'research'
  | 'other';

/**
 * Task record for ETA estimation system (Issue #1234 Phase 1).
 *
 * Records task execution metadata including estimated and actual duration,
 * enabling future ETA predictions based on historical patterns.
 *
 * Stored in `{workspace}/task-records.md` as Markdown entries.
 */
export interface TaskRecord {
  /** Task title / brief description */
  title: string;
  /** Task type classification */
  type: TaskType;
  /** ISO timestamp when the task was started */
  startedAt: string;
  /** ISO timestamp when the task was completed */
  completedAt: string;
  /** Estimated duration in minutes (null if not estimated) */
  estimatedMinutes: number | null;
  /** Reasoning / basis for the estimate */
  estimationBasis: string;
  /** Actual duration in minutes (computed from startedAt/completedAt) */
  actualMinutes: number;
  /** Post-completion review / retrospective notes */
  review: string;
  /** Optional tags for categorization */
  tags?: string[];
}
