/**
 * Type definitions for long task mechanism.
 */

/**
 * Input specification for a subtask.
 */
export interface SubtaskInput {
  /** Input description */
  description: string;
  /** File paths or data from previous subtask */
  sources: string[];
  /** Context data */
  context?: Record<string, unknown>;
}

/**
 * Markdown section requirement for a subtask summary.
 */
export interface MarkdownSectionRequirement {
  /** Section identifier (used for references by next steps) */
  id: string;
  /** Section heading/title */
  title: string;
  /** Description of what content this section should contain */
  content: string;
  /** Whether this section is required or optional */
  required: boolean;
}

/**
 * Output specification for a subtask.
 */
export interface SubtaskOutput {
  /** Output description */
  description: string;
  /** Expected output files */
  files: string[];
  /** Markdown summary file path */
  summaryFile: string;
  /** Structure requirements for the markdown summary (ensures next step can use it) */
  markdownRequirements?: MarkdownSectionRequirement[];
}

/**
 * A single subtask in the long task workflow.
 */
export interface Subtask {
  /** Subtask sequence number (1-indexed) */
  sequence: number;
  /** Subtask title */
  title: string;
  /** Detailed description of what to do */
  description: string;
  /** Input specification */
  inputs: SubtaskInput;
  /** Output specification */
  outputs: SubtaskOutput;
  /** Estimated complexity for user display */
  complexity?: 'simple' | 'medium' | 'complex';
}

/**
 * A long task plan with multiple subtasks.
 */
export interface LongTaskPlan {
  /** Unique task identifier */
  taskId: string;
  /** Original user request */
  originalRequest: string;
  /** Task title */
  title: string;
  /** Overall description */
  description: string;
  /** Linear sequence of subtasks */
  subtasks: Subtask[];
  /** Estimated total steps */
  totalSteps: number;
  /** Creation timestamp */
  createdAt: string;
}

/**
 * Status of a long task execution.
 */
export type LongTaskStatus =
  | 'planning'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * State of a long task execution.
 */
export interface LongTaskState {
  /** Task plan */
  plan: LongTaskPlan;
  /** Current status */
  status: LongTaskStatus;
  /** Current subtask being executed (0-indexed) */
  currentStep: number;
  /** Results from completed subtasks */
  results: Map<number, SubtaskResult>;
  /** Error message if failed */
  error?: string;
  /** Start timestamp */
  startedAt?: string;
  /** Completion timestamp */
  completedAt?: string;
}

/**
 * Result from a completed subtask.
 */
export interface SubtaskResult {
  /** Subtask sequence number */
  sequence: number;
  /** Success status */
  success: boolean;
  /** Output summary */
  summary: string;
  /** Generated files */
  files: string[];
  /** Markdown summary file path */
  summaryFile: string;
  /** Error message if failed */
  error?: string;
  /** Completion timestamp */
  completedAt: string;
}

/**
 * Configuration for the long task manager.
 */
export interface LongTaskConfig {
  /** Base workspace directory */
  workspaceBaseDir: string;
  /** Send message callback for progress updates */
  sendMessage: (chatId: string, message: string) => Promise<void>;
  /** Send interactive card callback for rich content */
  sendCard: (chatId: string, card: Record<string, unknown>) => Promise<void>;
  /** Chat ID for this task */
  chatId: string;
  /** Total number of steps (optional, for display purposes) */
  totalSteps?: number;
  /** Optional API base URL for custom endpoints (e.g., GLM) */
  apiBaseUrl?: string;
  /** Timeout for task execution in milliseconds (default: 24 hours) */
  taskTimeoutMs?: number;
  /** Maximum cost limit in USD (optional, default: no limit) */
  maxCostUsd?: number;
  /** Abort signal for task cancellation */
  abortSignal?: AbortSignal;
}
