/**
 * TaskContext - Shared task state for progress reporting (Issue #857).
 *
 * Provides an in-memory + on-disk shared state that tracks task progress.
 * This enables the Reporter Agent to read current task status and
 * intelligently decide when/how to report progress to the user.
 *
 * Design Principles:
 * - Agent-decided reporting: The model decides when to report (not fixed intervals)
 * - Shared state: TaskContext is the "single source of truth" for task progress
 * - Human-readable: On-disk state stored as markdown for debugging
 * - Non-blocking: Status updates are fast and don't block task execution
 *
 * Directory structure:
 * tasks/{task_id}/
 *   ├── task.md          (task specification)
 *   ├── context.md       (live progress state, updated by executor)
 *   ├── final_result.md  (created when task is COMPLETE)
 *   └── iterations/
 *
 * @module task/task-context
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskContext');

// ============================================================================
// Types
// ============================================================================

/**
 * Task execution status.
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * A single step in the task execution.
 */
export interface TaskStep {
  /** Step description */
  description: string;
  /** Step status */
  status: 'pending' | 'running' | 'completed' | 'skipped';
  /** Optional timestamp when step started */
  startedAt?: string;
  /** Optional timestamp when step completed */
  completedAt?: string;
}

/**
 * Task context data — the shared state between executor and reporter.
 */
export interface TaskContextData {
  /** Task ID (typically messageId) */
  taskId: string;
  /** Chat ID for user communication */
  chatId: string;
  /** Current task status */
  status: TaskStatus;
  /** Task title (from task.md) */
  title: string;
  /** List of execution steps */
  steps: TaskStep[];
  /** Current operation description */
  currentOperation?: string;
  /** Timestamp when task was created */
  createdAt: string;
  /** Timestamp when task execution started */
  startedAt?: string;
  /** Timestamp when task completed/failed */
  completedAt?: string;
  /** Error message if task failed */
  errorMessage?: string;
  /** Arbitrary metadata for extensibility */
  metadata?: Record<string, unknown>;
}

/**
 * Options for creating a TaskContext.
 */
export interface TaskContextOptions {
  /** Workspace directory for task files */
  workspaceDir: string;
}

// ============================================================================
// TaskContext Class
// ============================================================================

/**
 * Manages shared task state for progress reporting.
 *
 * Usage:
 * 1. Executor creates context and updates steps as it progresses
 * 2. Reporter reads context to decide when/how to report
 * 3. Context is persisted to disk for crash recovery
 */
export class TaskContext {
  private readonly tasksDir: string;
  private data: TaskContextData;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    options: TaskContextOptions,
    initialData: TaskContextData,
  ) {
    this.tasksDir = path.join(options.workspaceDir, 'tasks');
    this.data = { ...initialData };
  }

  // ===== Factory Methods =====

  /**
   * Create a new TaskContext for a task.
   *
   * @param options - Workspace options
   * @param taskId - Task identifier
   * @param chatId - Chat ID for communication
   * @param title - Task title
   */
  static async create(
    options: TaskContextOptions,
    taskId: string,
    chatId: string,
    title: string,
  ): Promise<TaskContext> {
    const tasksDir = path.join(options.workspaceDir, 'tasks');
    const taskDir = path.join(tasksDir, taskId.replace(/[^a-zA-Z0-9_-]/g, '_'));
    await fs.mkdir(taskDir, { recursive: true });

    const data: TaskContextData = {
      taskId,
      chatId,
      status: 'pending',
      title,
      steps: [],
      createdAt: new Date().toISOString(),
    };

    const ctx = new TaskContext(options, data);
    await ctx.flush();
    return ctx;
  }

  /**
   * Load an existing TaskContext from disk.
   *
   * @param options - Workspace options
   * @param taskId - Task identifier
   */
  static async load(options: TaskContextOptions, taskId: string): Promise<TaskContext | null> {
    const tasksDir = path.join(options.workspaceDir, 'tasks');
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const contextPath = path.join(tasksDir, sanitized, 'context.md');

    try {
      const content = await fs.readFile(contextPath, 'utf-8');
      const data = parseContextMarkdown(content);
      if (!data) {
        logger.warn({ taskId }, 'Failed to parse context.md');
        return null;
      }
      return new TaskContext(options, data);
    } catch (_error) {
      logger.debug({ taskId }, 'No existing context.md found');
      return null;
    }
  }

  // ===== Status Updates =====

  /**
   * Mark the task as running.
   */
  async start(): Promise<void> {
    this.data.status = 'running';
    this.data.startedAt = new Date().toISOString();
    await this.flush();
    logger.info({ taskId: this.data.taskId }, 'Task started');
  }

  /**
   * Mark the task as completed.
   */
  async complete(): Promise<void> {
    this.data.status = 'completed';
    this.data.completedAt = new Date().toISOString();
    // Mark remaining pending steps as skipped
    for (const step of this.data.steps) {
      if (step.status === 'pending' || step.status === 'running') {
        step.status = 'completed';
      }
    }
    await this.flush();
    logger.info({ taskId: this.data.taskId }, 'Task completed');
  }

  /**
   * Mark the task as failed.
   */
  async fail(errorMessage: string): Promise<void> {
    this.data.status = 'failed';
    this.data.completedAt = new Date().toISOString();
    this.data.errorMessage = errorMessage;
    // Mark running steps as failed
    for (const step of this.data.steps) {
      if (step.status === 'running') {
        step.status = 'pending'; // Reset to indicate not completed
      }
    }
    await this.flush();
    logger.info({ taskId: this.data.taskId, errorMessage }, 'Task failed');
  }

  // ===== Step Management =====

  /**
   * Add a step to the task.
   */
  async addStep(description: string): Promise<void> {
    this.data.steps.push({
      description,
      status: 'pending',
    });
    await this.flush();
  }

  /**
   * Mark a step as running.
   */
  async startStep(index: number): Promise<void> {
    if (index >= 0 && index < this.data.steps.length) {
      this.data.steps[index].status = 'running';
      this.data.steps[index].startedAt = new Date().toISOString();
      this.data.currentOperation = this.data.steps[index].description;
      await this.flush();
    }
  }

  /**
   * Mark a step as completed.
   */
  async completeStep(index: number): Promise<void> {
    if (index >= 0 && index < this.data.steps.length) {
      this.data.steps[index].status = 'completed';
      this.data.steps[index].completedAt = new Date().toISOString();
      // Update currentOperation to next pending step or clear
      const nextStep = this.data.steps.find(s => s.status === 'pending');
      this.data.currentOperation = nextStep?.description;
      await this.flush();
    }
  }

  /**
   * Skip a step.
   */
  async skipStep(index: number): Promise<void> {
    if (index >= 0 && index < this.data.steps.length) {
      this.data.steps[index].status = 'skipped';
      await this.flush();
    }
  }

  // ===== Current Operation =====

  /**
   * Update the current operation description.
   * Use this for fine-grained progress tracking within a step.
   */
  async updateCurrentOperation(operation: string): Promise<void> {
    this.data.currentOperation = operation;
    await this.debouncedFlush();
  }

  // ===== Metadata =====

  /**
   * Set arbitrary metadata.
   */
  async setMetadata(key: string, value: unknown): Promise<void> {
    if (!this.data.metadata) {
      this.data.metadata = {};
    }
    this.data.metadata[key] = value;
    await this.flush();
  }

  // ===== Read Access =====

  /**
   * Get a snapshot of the current task context data.
   */
  getData(): Readonly<TaskContextData> {
    return { ...this.data, steps: [...this.data.steps] };
  }

  /**
   * Get task status summary for the Reporter Agent.
   */
  getSummary(): string {
    const completedSteps = this.data.steps.filter(s => s.status === 'completed').length;
    const totalSteps = this.data.steps.length;
    const elapsed = this.getElapsedTime();

    const parts: string[] = [];
    parts.push(`**Task**: ${this.data.title}`);
    parts.push(`**Status**: ${formatStatus(this.data.status)}`);
    if (elapsed) {
      parts.push(`**Elapsed**: ${elapsed}`);
    }
    if (totalSteps > 0) {
      parts.push(`**Progress**: ${completedSteps}/${totalSteps} steps completed`);
    }
    if (this.data.currentOperation) {
      parts.push(`**Current**: ${this.data.currentOperation}`);
    }
    if (this.data.errorMessage) {
      parts.push(`**Error**: ${this.data.errorMessage}`);
    }

    return parts.join('\n');
  }

  /**
   * Get elapsed time as human-readable string.
   */
  private getElapsedTime(): string | null {
    const start = this.data.startedAt;
    if (!start) { return null; }
    const end = this.data.completedAt || new Date().toISOString();
    const elapsedMs = new Date(end).getTime() - new Date(start).getTime();
    return formatDuration(elapsedMs);
  }

  // ===== Persistence =====

  /**
   * Get the file path for context.md.
   */
  private getContextPath(): string {
    const sanitized = this.data.taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.tasksDir, sanitized, 'context.md');
  }

  /**
   * Flush current state to disk.
   */
  private async flush(): Promise<void> {
    const contextPath = this.getContextPath();
    const content = toContextMarkdown(this.data);
    try {
      await fs.writeFile(contextPath, content, 'utf-8');
    } catch (error) {
      logger.error({ err: error, taskId: this.data.taskId }, 'Failed to flush context');
    }
  }

  /**
   * Debounced flush — avoids excessive disk writes for frequent updates.
   */
  private debouncedFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(err => {
        logger.error({ err }, 'Debounced flush failed');
      });
    }, 1000);
  }
}

// ============================================================================
// Markdown Serialization / Deserialization
// ============================================================================

/**
 * Serialize TaskContextData to markdown for on-disk storage.
 */
function toContextMarkdown(data: TaskContextData): string {
  const lines: string[] = [
    `# Task Context: ${data.title}`,
    '',
    `**Task ID**: ${data.taskId}`,
    `**Chat ID**: ${data.chatId}`,
    `**Status**: ${data.status}`,
    `**Created**: ${data.createdAt}`,
  ];

  if (data.startedAt) {
    lines.push(`**Started**: ${data.startedAt}`);
  }
  if (data.completedAt) {
    lines.push(`**Completed**: ${data.completedAt}`);
  }
  if (data.currentOperation) {
    lines.push(`**Current Operation**: ${data.currentOperation}`);
  }
  if (data.errorMessage) {
    lines.push(`**Error**: ${data.errorMessage}`);
  }

  if (data.steps.length > 0) {
    lines.push('', '## Steps', '');
    for (let i = 0; i < data.steps.length; i++) {
      const step = data.steps[i];
      const statusIcon = step.status === 'completed' ? '✅'
        : step.status === 'running' ? '🔄'
        : step.status === 'skipped' ? '⏭️'
        : '⬜';
      lines.push(`${statusIcon} ${i}. ${step.description} [${step.status}]${step.startedAt ? ` (started: ${step.startedAt})` : ''}${step.completedAt ? ` (completed: ${step.completedAt})` : ''}`);
    }
  }

  if (data.metadata && Object.keys(data.metadata).length > 0) {
    lines.push('', '## Metadata', '', '```json');
    lines.push(JSON.stringify(data.metadata, null, 2));
    lines.push('```');
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Parse context.md back into TaskContextData.
 */
function parseContextMarkdown(content: string): TaskContextData | null {
  try {
    const data: Partial<TaskContextData> = {};

    // Helper: extract first capture group from regex match
    const extract = (pattern: RegExp): string | undefined => {
      const match = content.match(pattern);
      return match?.[1];
    };

    // Extract key-value pairs from header
    data.title = extract(/^# Task Context: (.+)$/m);
    data.taskId = extract(/\*\*Task ID\*\*: (.+)$/m);
    data.chatId = extract(/\*\*Chat ID\*\*: (.+)$/m);
    const statusStr = extract(/\*\*Status\*\*: (.+)$/m);
    if (statusStr) { data.status = statusStr as TaskStatus; }
    data.createdAt = extract(/\*\*Created\*\*: (.+)$/m);
    data.startedAt = extract(/\*\*Started\*\*: (.+)$/m);
    data.completedAt = extract(/\*\*Completed\*\*: (.+)$/m);
    data.currentOperation = extract(/\*\*Current Operation\*\*: (.+)$/m);
    data.errorMessage = extract(/\*\*Error\*\*: (.+)$/m);

    // Parse steps
    data.steps = [];
    const stepPattern = /^(?:✅|🔄|⏭️|⬜) (\d+)\. (.+) \[(\w+)\](?: \(started: ([^)]+)\))?(?: \(completed: ([^)]+)\))?$/gm;
    let stepMatch;
    while ((stepMatch = stepPattern.exec(content)) !== null) {
      data.steps.push({
        description: stepMatch[2],
        status: stepMatch[3] as TaskStep['status'],
        startedAt: stepMatch[4] || undefined,
        completedAt: stepMatch[5] || undefined,
      });
    }

    // Parse metadata
    const metadataMatch = content.match(/## Metadata\s*\n\s*```json\n([\s\S]*?)\n```/);
    if (metadataMatch) {
      try {
        data.metadata = JSON.parse(metadataMatch[1]);
      } catch {
        // Ignore malformed metadata
      }
    }

    // Validate required fields
    if (!data.taskId || !data.chatId || !data.status || !data.createdAt) {
      return null;
    }

    return data as TaskContextData;
  } catch {
    return null;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format task status for display.
 */
function formatStatus(status: TaskStatus): string {
  const map: Record<TaskStatus, string> = {
    pending: '⬜ 等待中',
    running: '🔄 执行中',
    completed: '✅ 已完成',
    failed: '❌ 失败',
  };
  return map[status] || status;
}

/**
 * Format milliseconds to human-readable duration.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  if (ms < 60000) { return `${Math.round(ms / 1000)}s`; }
  if (ms < 3600000) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.round((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}
