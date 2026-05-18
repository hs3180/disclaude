/**
 * TaskContext - Runtime task state tracking for progress reporting.
 *
 * Tracks the current state of a task during execution, providing
 * structured information that the agent can use to report progress
 * to the user.
 *
 * Design principle (Issue #857): The agent decides WHEN to report
 * progress based on prompts, not fixed rules. TaskContext provides
 * the data; the LLM makes the decision.
 *
 * @module task/task-context
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskContext');

/**
 * Task context status representing the lifecycle of a task's progress tracking.
 */
export type TaskContextStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * A single step in the task execution.
 */
export interface TaskStep {
  /** Step description */
  description: string;
  /** Step status */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** When this step started */
  startedAt?: number;
  /** When this step completed/failed */
  endedAt?: number;
}

/**
 * Snapshot of current task state for progress reporting.
 */
export interface TaskProgressSnapshot {
  /** Task identifier */
  taskId: string;
  /** Current status */
  status: TaskContextStatus;
  /** Human-readable description of current activity */
  currentActivity: string;
  /** Completed step count */
  completedSteps: number;
  /** Total estimated steps (0 = unknown) */
  totalSteps: number;
  /** Task start time (epoch ms) */
  startTime: number;
  /** Elapsed time in ms */
  elapsedMs: number;
  /** Error messages if any */
  errors: string[];
  /** Tool call count so far */
  toolCallCount: number;
  /** Number of progress reports sent */
  progressReportCount: number;
}

/**
 * TaskContext tracks the runtime state of a task for progress reporting.
 *
 * Usage:
 * ```typescript
 * const ctx = new TaskContext('task-123');
 * ctx.start('Processing data files');
 * ctx.addStep('Parse CSV files');
 * ctx.updateActivity('Parsing orders.csv');
 * ctx.completeStep(0);
 * ctx.complete('All files processed');
 * ```
 */
export class TaskContext {
  readonly taskId: string;
  private status: TaskContextStatus = 'pending';
  private currentActivity = '';
  private steps: TaskStep[] = [];
  private startTime = 0;
  private endTime = 0;
  private errors: string[] = [];
  private toolCallCount = 0;
  private progressReportCount = 0;

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  /**
   * Mark the task as started.
   */
  start(initialActivity: string): void {
    this.status = 'running';
    this.currentActivity = initialActivity;
    this.startTime = Date.now();
    logger.info({ taskId: this.taskId }, 'Task started');
  }

  /**
   * Add a step to the task plan.
   */
  addStep(description: string): void {
    this.steps.push({ description, status: 'pending' });
  }

  /**
   * Mark a step as in-progress.
   */
  beginStep(index: number): void {
    if (index >= 0 && index < this.steps.length) {
      this.steps[index].status = 'in_progress';
      this.steps[index].startedAt = Date.now();
      this.currentActivity = this.steps[index].description;
    }
  }

  /**
   * Mark a step as completed.
   */
  completeStep(index: number): void {
    if (index >= 0 && index < this.steps.length) {
      this.steps[index].status = 'completed';
      this.steps[index].endedAt = Date.now();
    }
  }

  /**
   * Mark a step as failed.
   */
  failStep(index: number, error: string): void {
    if (index >= 0 && index < this.steps.length) {
      this.steps[index].status = 'failed';
      this.steps[index].endedAt = Date.now();
    }
    this.errors.push(error);
  }

  /**
   * Update the current activity description.
   */
  updateActivity(activity: string): void {
    this.currentActivity = activity;
  }

  /**
   * Record a tool call.
   */
  recordToolCall(): void {
    this.toolCallCount++;
  }

  /**
   * Record that a progress report was sent.
   */
  recordProgressReport(): void {
    this.progressReportCount++;
  }

  /**
   * Add an error message.
   */
  addError(error: string): void {
    this.errors.push(error);
  }

  /**
   * Mark the task as completed.
   */
  complete(finalMessage?: string): void {
    this.status = 'completed';
    this.endTime = Date.now();
    if (finalMessage) {
      this.currentActivity = finalMessage;
    }
    logger.info({
      taskId: this.taskId,
      elapsedMs: this.endTime - this.startTime,
      toolCallCount: this.toolCallCount,
      progressReportCount: this.progressReportCount,
    }, 'Task completed');
  }

  /**
   * Mark the task as failed.
   */
  fail(error: string): void {
    this.status = 'failed';
    this.endTime = Date.now();
    this.errors.push(error);
    this.currentActivity = `Failed: ${error}`;
    logger.error({ taskId: this.taskId, error }, 'Task failed');
  }

  /**
   * Get the current progress snapshot.
   */
  getProgress(): TaskProgressSnapshot {
    return {
      taskId: this.taskId,
      status: this.status,
      currentActivity: this.currentActivity,
      completedSteps: this.steps.filter(s => s.status === 'completed').length,
      totalSteps: this.steps.length,
      startTime: this.startTime,
      elapsedMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
      errors: [...this.errors],
      toolCallCount: this.toolCallCount,
      progressReportCount: this.progressReportCount,
    };
  }

  /**
   * Get the elapsed time as a human-readable string.
   */
  getElapsedTimeString(): string {
    const ms = this.startTime > 0 ? (this.endTime || Date.now()) - this.startTime : 0;
    if (ms < 1000) {return `${ms}ms`;}
    if (ms < 60000) {return `${(ms / 1000).toFixed(1)}s`;}
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  /**
   * Get task duration in ms (only valid after completion/failure).
   */
  getDurationMs(): number {
    if (this.startTime === 0 || this.endTime === 0) {return 0;}
    return this.endTime - this.startTime;
  }

  /**
   * Check if the task is still running.
   */
  get isRunning(): boolean {
    return this.status === 'running';
  }

  /**
   * Check if the task is finished (completed or failed).
   */
  get isFinished(): boolean {
    return this.status === 'completed' || this.status === 'failed';
  }
}
