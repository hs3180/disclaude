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

// ============================================================================
// TaskContext Types (Issue #857: Independent Reporter Agent)
// ============================================================================

/**
 * Status of a task context.
 *
 * Follows the same lifecycle as TaskQueue's TaskStatus for consistency,
 * but managed independently as file-based state.
 */
export type TaskContextStatus =
  | 'pending'    // Task created, not yet started
  | 'running'    // Task is currently executing
  | 'completed'  // Task finished successfully
  | 'failed'     // Task failed with an error
  | 'cancelled'; // Task was cancelled

/**
 * Runtime context for a task, providing shared state between
 * the main task executor and the Reporter Agent.
 *
 * Design Principles (Issue #857):
 * - Markdown as Data: Written as context.md for human readability
 * - Lightweight: Only essential progress information
 * - Extensible: metadata field for task-specific data
 *
 * The Reporter Agent reads this context to decide:
 * - When to report progress to the user
 * - What progress information to include
 * - How to format the progress update
 */
export interface TaskContext {
  /** Unique task identifier */
  taskId: string;
  /** Chat ID where the task was initiated */
  chatId: string;
  /** Current status of the task */
  status: TaskContextStatus;
  /** Human-readable description of the task */
  description: string;
  /** ISO timestamp when the task was created */
  createdAt: string;
  /** ISO timestamp when the context was last updated */
  updatedAt: string;
  /** ISO timestamp when the task started running (optional, set when status becomes 'running') */
  startedAt?: string;
  /** ISO timestamp when the task completed (optional, set when status becomes terminal) */
  completedAt?: string;
  /** Current step description (what the agent is doing right now) */
  currentStep?: string;
  /** List of completed step descriptions */
  completedSteps: string[];
  /** Total number of expected steps (optional, for progress calculation) */
  totalSteps?: number;
  /** Error messages accumulated during execution */
  errors: string[];
  /** Arbitrary metadata for task-specific data */
  metadata?: Record<string, unknown>;
}

/**
 * Options for creating a new TaskContext.
 */
export interface CreateTaskContextOptions {
  /** Chat ID where the task was initiated */
  chatId: string;
  /** Human-readable description of the task */
  description: string;
  /** Total number of expected steps (optional) */
  totalSteps?: number;
  /** Arbitrary metadata (optional) */
  metadata?: Record<string, unknown>;
}

/**
 * Options for updating an existing TaskContext.
 * All fields are optional - only provided fields will be updated.
 */
export interface UpdateTaskContextOptions {
  /** Update task status */
  status?: TaskContextStatus;
  /** Update current step description */
  currentStep?: string;
  /** Add to completed steps list */
  addCompletedStep?: string;
  /** Update total steps count */
  totalSteps?: number;
  /** Add an error message */
  addError?: string;
  /** Update metadata (merged with existing) */
  metadata?: Record<string, unknown>;
}
