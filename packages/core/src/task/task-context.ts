/**
 * TaskContext - Real-time task progress tracking for deep tasks.
 *
 * Provides a structured JSON representation of task execution state
 * that can be read by independent Reporter Agents to generate
 * progress reports for users.
 *
 * File location: tasks/{taskId}/task-context.json
 *
 * Design:
 * - TaskContext is the shared state between the main task executor
 *   and the independent Reporter Agent (Issue #857)
 * - The executor updates context as it progresses
 * - The Reporter Agent reads context and decides when/how to report
 * - Uses JSON for structured access (not markdown) since this is
 *   machine-to-machine communication
 *
 * @module task/task-context
 */

/**
 * Current phase of task execution.
 */
export type TaskPhase =
  | 'definition'    // Task spec being created (deep-task skill)
  | 'evaluation'    // Evaluator assessing completion
  | 'execution'     // Executor performing work
  | 'verification'  // Final verification of results
  | 'completed'     // Task finished successfully
  | 'failed';       // Task failed

/**
 * Progress metrics for task execution.
 */
export interface TaskMetrics {
  /** Number of files modified/created */
  filesModified: number;
  /** Number of tests run */
  testsRun: number;
  /** Number of tests passed */
  testsPassed: number;
  /** Number of tools invoked */
  toolsInvoked: number;
}

/**
 * Progress step within a task.
 */
export interface TaskStep {
  /** Step description */
  description: string;
  /** When the step started */
  startedAt: string;
  /** When the step completed (null if in progress) */
  completedAt: string | null;
  /** Step status */
  status: 'in_progress' | 'completed' | 'failed' | 'skipped';
}

/**
 * TaskContext - shared state between executor and reporter.
 *
 * This is the central data structure that enables the "Independent Reporter Agent"
 * approach (Issue #857). The main task executor writes updates to this context,
 * and the Reporter Agent reads it to generate progress reports.
 *
 * Lifecycle:
 * 1. Created when deep-task starts (Phase: 'definition')
 * 2. Updated throughout execution (Phase: 'evaluation' | 'execution')
 * 3. Finalized on completion (Phase: 'completed' | 'failed')
 */
export interface TaskContext {
  /** Schema version for future compatibility */
  version: 1;

  /** Task identifier (same as directory name) */
  taskId: string;

  /** Chat ID where task was initiated (for progress reports) */
  chatId: string;

  /** Current status of the task */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

  /** Current execution phase */
  phase: TaskPhase;

  /** Task title (extracted from user request) */
  title: string;

  /** Task description */
  description: string;

  /** ISO 8601 timestamp when task was created */
  createdAt: string;

  /** ISO 8601 timestamp when task started execution */
  startedAt: string | null;

  /** ISO 8601 timestamp of last context update */
  updatedAt: string;

  /** ISO 8601 timestamp when task completed */
  completedAt: string | null;

  /** Current iteration number (dialogue workflow: eval → exec → eval → ...) */
  currentIteration: number;

  /** Total iterations so far */
  totalIterations: number;

  /** Current step being executed (null if between steps) */
  currentStep: string | null;

  /** Steps completed so far */
  completedSteps: TaskStep[];

  /** Next planned steps (populated by executor) */
  plannedSteps: string[];

  /** Execution metrics */
  metrics: TaskMetrics;

  /** Error message if status is 'failed' */
  error: string | null;
}

/**
 * Options for creating a new TaskContext.
 */
export interface CreateTaskContextOptions {
  taskId: string;
  chatId: string;
  title: string;
  description: string;
}

/**
 * Options for updating an existing TaskContext.
 * All fields are optional - only provided fields will be updated.
 */
export interface UpdateTaskContextOptions {
  status?: TaskContext['status'];
  phase?: TaskPhase;
  currentIteration?: number;
  currentStep?: string | null;
  plannedSteps?: string[];
  metrics?: Partial<TaskMetrics>;
  error?: string | null;
  completedAt?: string;
}
