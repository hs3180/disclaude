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
 * Task type classification for ETA estimation records.
 * Used by TaskRecordManager to categorize task execution history.
 */
export type TaskRecordType =
  | 'bugfix'        // Bug fix
  | 'feature'       // New feature
  | 'refactoring'   // Code refactoring
  | 'research'      // Research or analysis
  | 'test'          // Writing or running tests
  | 'docs'          // Documentation
  | 'chore';        // Maintenance tasks

/**
 * Task execution record for ETA estimation (Issue #1234 Phase 1).
 *
 * Records are stored as unstructured Markdown in `.claude/task-records.md`.
 * Each record captures estimation vs actual time, enabling future ETA predictions
 * to learn from historical patterns.
 *
 * Design principle: Non-structured Markdown storage, not structured data.
 * The agent records these entries after completing significant tasks.
 */
export interface TaskRecord {
  /** Date of task execution (YYYY-MM-DD) */
  date: string;
  /** Brief description of the task */
  title: string;
  /** Task type classification */
  type: TaskRecordType;
  /** Time estimate made before starting the task */
  estimatedTime: string;
  /** Reasoning behind the estimate — reference similar past tasks or complexity factors */
  estimationBasis: string;
  /** How long the task actually took */
  actualTime: string;
  /** Retrospective: what went well, what was underestimated, lessons learned */
  review: string;
}
