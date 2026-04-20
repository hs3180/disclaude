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
 * Status of a single iteration in the dialogue workflow.
 * @see Issue #857 - Task progress reporting
 */
export type IterationStatus = 'pending' | 'evaluating' | 'executing' | 'completed';

/**
 * Overall status of a deep task.
 * @see Issue #857 - Task progress reporting
 */
export type TaskStatus = 'created' | 'in_progress' | 'completed' | 'failed';

/**
 * Snapshot of a single iteration's state.
 */
export interface IterationSnapshot {
  /** Iteration number (1-indexed) */
  number: number;
  /** Current status of this iteration */
  status: IterationStatus;
  /** Brief summary from evaluation.md (first few lines) */
  evaluationSummary: string | null;
  /** Evaluation status (COMPLETE or NEED_EXECUTE) */
  evaluationVerdict: string | null;
  /** Brief summary from execution.md (first few lines) */
  executionSummary: string | null;
  /** Number of step files in this iteration */
  stepCount: number;
}

/**
 * Read-only snapshot of a task's current state.
 *
 * This is the data structure that the Reporter Agent reads to decide
 * when and what to report to the user. It is derived entirely from
 * existing task files (task.md, evaluation.md, execution.md).
 *
 * @see Issue #857 - Independent Reporter Agent design
 */
export interface TaskContext {
  /** Task identifier (message ID) */
  taskId: string;
  /** Overall task status */
  status: TaskStatus;
  /** Title extracted from task.md */
  title: string;
  /** Original user request from task.md */
  originalRequest: string;
  /** When the task was created (ISO timestamp) */
  createdAt: string | null;
  /** Chat ID associated with this task */
  chatId: string | null;
  /** Total number of iterations */
  totalIterations: number;
  /** Snapshot of each iteration */
  iterations: IterationSnapshot[];
  /** Whether a final_result.md exists (task is complete) */
  hasFinalResult: boolean;
  /** Whether a final-summary.md exists */
  hasFinalSummary: boolean;
  /** Time elapsed since task creation (human-readable) */
  elapsed: string | null;
  /** Key information for reporter: primary goal and deliverables */
  primaryGoal: string | null;
  deliverables: string[];
  /** Number of success criteria defined */
  successCriteriaCount: number;
}
