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
 * Task execution status.
 * Determined by file existence in the task directory.
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'unknown';

/**
 * Iteration status within a task.
 */
export interface IterationStatus {
  /** Iteration number (1-indexed) */
  iteration: number;
  /** Whether evaluation.md exists */
  hasEvaluation: boolean;
  /** Whether execution.md exists */
  hasExecution: boolean;
}

/**
 * Structured task status returned by getTaskStatus().
 * Provides all information an agent needs to decide whether and how to report progress.
 *
 * Issue #857: Task status reading interface for progress reporting.
 */
export interface TaskStatusInfo {
  /** Task identifier */
  taskId: string;
  /** Current execution status */
  status: TaskStatus;
  /** Number of completed iterations */
  totalIterations: number;
  /** Whether final summary has been written */
  hasFinalSummary: boolean;
  /** Whether final result exists (task is COMPLETE) */
  hasFinalResult: boolean;
  /** Status of each iteration */
  iterations: IterationStatus[];
}
