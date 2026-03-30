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
 * Task type classification for ETA estimation.
 *
 * Used to categorize tasks for time estimation purposes.
 * New types can be added as the system learns from historical data.
 */
export type TaskType =
  | 'bugfix'        // Bug fix - varies by reproduction difficulty
  | 'feature-small' // Single-function feature
  | 'feature-medium' // Multi-component feature
  | 'refactoring'   // Code restructuring (scope-dependent)
  | 'documentation' // Docs or comments
  | 'testing'       // Test writing or updates
  | 'chore'         // Maintenance tasks
  | 'investigation' // Research or debugging
  | string;         // Allow custom types for extensibility

/**
 * A single task record entry for ETA tracking.
 *
 * Records are stored as Markdown in `.claude/task-records.md`.
 * This interface represents the structured data used to generate
 * the Markdown record.
 */
export interface TaskRecord {
  /** Short description of the task */
  title: string;
  /** Task type classification */
  type: TaskType;
  /** Estimated duration (e.g., "30分钟", "2小时") */
  estimatedTime: string;
  /** Reasoning behind the estimate */
  estimationBasis: string;
  /** Actual duration taken (empty if not yet completed) */
  actualTime?: string;
  /** Retrospective notes (empty if not yet completed) */
  retrospective?: string;
  /** Task ID or reference (optional) */
  taskId?: string;
  /** Date of the record (defaults to today) */
  date?: string;
}
