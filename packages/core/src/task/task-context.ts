/**
 * TaskContextStore - File-based runtime task context management.
 *
 * Issue #857: Provides shared state between the main task executor
 * and the independent Reporter Agent.
 *
 * Architecture:
 * ```
 * Main Task (ChatAgent)
 *   └── writes context.md ──▶ tasks/{taskId}/context.md
 *                                     │
 * Reporter Agent                      │
 *   └── reads context.md ◀───────────┘
 *       └── decides: when/how to report to user
 * ```
 *
 * Design Principles:
 * - Markdown as Data: Context stored as human-readable markdown
 * - Non-blocking: Reads are cheap file reads; writes are append-only
 * - Task-local: Each task has its own context file
 * - Extensible: metadata field for task-specific data
 *
 * Directory Structure:
 * ```
 * tasks/{taskId}/
 *   ├── task.md           # Task specification (existing)
 *   ├── context.md        # Runtime context (NEW - this module)
 *   ├── final_result.md   # Created on completion (existing)
 *   └── iterations/       # Execution history (existing)
 * ```
 *
 * @module task/task-context
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type {
  TaskContext,
  TaskContextStatus,
  CreateTaskContextOptions,
  UpdateTaskContextOptions,
} from './types.js';

const logger = createLogger('TaskContextStore');

/**
 * TaskContextStore - Manages runtime task context files.
 *
 * This class provides the foundation for Issue #857's independent Reporter Agent
 * by maintaining a file-based shared state that any agent can read.
 *
 * Usage:
 * ```typescript
 * // In the main task executor:
 * const store = new TaskContextStore(workspaceDir);
 * await store.create('task-123', { chatId: 'oc_xxx', description: 'Build feature X' });
 * await store.update('task-123', { status: 'running', currentStep: 'Cloning repository' });
 * await store.update('task-123', { addCompletedStep: 'Cloning repository', currentStep: 'Analyzing code' });
 * await store.update('task-123', { status: 'completed' });
 *
 * // In the Reporter Agent:
 * const context = await store.read('task-123');
 * // Agent uses context.status, context.currentStep, context.completedSteps, etc.
 * // to decide when and how to report progress to the user
 * ```
 */
export class TaskContextStore {
  private readonly tasksDir: string;

  constructor(workspaceDir: string) {
    this.tasksDir = path.join(workspaceDir, 'tasks');
  }

  /**
   * Get the context file path for a task.
   *
   * @param taskId - Task identifier
   * @returns Absolute path to context.md
   */
  getContextPath(taskId: string): string {
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.tasksDir, sanitized, 'context.md');
  }

  /**
   * Create a new task context.
   *
   * Initializes a context.md file with 'pending' status.
   * The task directory must already exist (created by TaskTracker/TaskFileManager).
   *
   * @param taskId - Task identifier
   * @param options - Creation options
   * @returns The created TaskContext
   * @throws Error if context already exists
   */
  async create(taskId: string, options: CreateTaskContextOptions): Promise<TaskContext> {
    const contextPath = this.getContextPath(taskId);

    // Check if context already exists
    try {
      await fs.access(contextPath);
      throw new Error(`Task context already exists for ${taskId}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) {
        throw error;
      }
      // File doesn't exist, proceed
    }

    const now = new Date().toISOString();
    const context: TaskContext = {
      taskId,
      chatId: options.chatId,
      status: 'pending',
      description: options.description,
      createdAt: now,
      updatedAt: now,
      completedSteps: [],
      errors: [],
      totalSteps: options.totalSteps,
      metadata: options.metadata,
    };

    await this.writeContextFile(contextPath, context);
    logger.info({ taskId, chatId: options.chatId }, 'Task context created');
    return context;
  }

  /**
   * Read the current task context.
   *
   * This is the primary method for the Reporter Agent to read task state.
   *
   * @param taskId - Task identifier
   * @returns The current TaskContext
   * @throws Error if context does not exist
   */
  async read(taskId: string): Promise<TaskContext> {
    const contextPath = this.getContextPath(taskId);
    return await this.readContextFile(contextPath);
  }

  /**
   * Update an existing task context.
   *
   * Only provided fields will be updated. The updatedAt timestamp is always refreshed.
   * When status transitions to 'running', startedAt is set automatically.
   * When status transitions to a terminal state ('completed', 'failed', 'cancelled'),
   * completedAt is set automatically.
   *
   * @param taskId - Task identifier
   * @param updates - Partial updates to apply
   * @returns The updated TaskContext
   * @throws Error if context does not exist
   */
  async update(taskId: string, updates: UpdateTaskContextOptions): Promise<TaskContext> {
    const contextPath = this.getContextPath(taskId);
    const context = await this.readContextFile(contextPath);
    const now = new Date().toISOString();

    // Apply status transition
    if (updates.status) {
      context.status = updates.status;

      // Auto-set startedAt when transitioning to running
      if (updates.status === 'running' && !context.startedAt) {
        context.startedAt = now;
      }

      // Auto-set completedAt when transitioning to terminal state
      if (['completed', 'failed', 'cancelled'].includes(updates.status) && !context.completedAt) {
        context.completedAt = now;
      }
    }

    // Update current step
    if (updates.currentStep !== undefined) {
      context.currentStep = updates.currentStep;
    }

    // Add completed step
    if (updates.addCompletedStep) {
      context.completedSteps.push(updates.addCompletedStep);
    }

    // Update total steps
    if (updates.totalSteps !== undefined) {
      context.totalSteps = updates.totalSteps;
    }

    // Add error
    if (updates.addError) {
      context.errors.push(updates.addError);
    }

    // Merge metadata
    if (updates.metadata) {
      context.metadata = { ...context.metadata, ...updates.metadata };
    }

    context.updatedAt = now;

    await this.writeContextFile(contextPath, context);
    logger.debug({ taskId, updates: Object.keys(updates) }, 'Task context updated');
    return context;
  }

  /**
   * Check if a task context exists.
   *
   * @param taskId - Task identifier
   * @returns True if context.md exists
   */
  async exists(taskId: string): Promise<boolean> {
    const contextPath = this.getContextPath(taskId);
    try {
      await fs.access(contextPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a task context file.
   *
   * @param taskId - Task identifier
   */
  async delete(taskId: string): Promise<void> {
    const contextPath = this.getContextPath(taskId);
    try {
      await fs.unlink(contextPath);
      logger.debug({ taskId }, 'Task context deleted');
    } catch (error) {
      logger.warn({ err: error, taskId }, 'Failed to delete task context');
    }
  }

  /**
   * List all task contexts.
   *
   * Scans the tasks directory for context.md files and reads them.
   * Useful for the Reporter Agent to find all active tasks.
   *
   * @param filter - Optional status filter
   * @returns Array of TaskContext objects
   */
  async listAll(filter?: TaskContextStatus): Promise<TaskContext[]> {
    const contexts: TaskContext[] = [];

    try {
      const entries = await fs.readdir(this.tasksDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {continue;}

        const contextPath = path.join(this.tasksDir, entry.name, 'context.md');
        try {
          const context = await this.readContextFile(contextPath);
          if (!filter || context.status === filter) {
            contexts.push(context);
          }
        } catch {
          // Not all task directories have context.md - skip silently
        }
      }
    } catch {
      // tasks directory may not exist yet
    }

    return contexts;
  }

  /**
   * Get active (running) tasks.
   *
   * Convenience method for the Reporter Agent to find tasks
   * that need progress reporting.
   *
   * @returns Array of running TaskContext objects
   */
  async getActiveTasks(): Promise<TaskContext[]> {
    return await this.listAll('running');
  }

  /**
   * Calculate progress percentage for a task.
   *
   * @param context - Task context
   * @returns Progress as a number between 0 and 100, or undefined if totalSteps is not set
   */
  calculateProgress(context: TaskContext): number | undefined {
    if (context.totalSteps === undefined || context.totalSteps === 0) {
      return undefined;
    }
    return Math.min(100, Math.round((context.completedSteps.length / context.totalSteps) * 100));
  }

  // =========================================================================
  // Private Methods - File I/O
  // =========================================================================

  /**
   * Write TaskContext to a markdown file.
   *
   * Format follows the project's "Markdown as Data" pattern,
   * making context readable by both humans and machines.
   */
  private async writeContextFile(filePath: string, context: TaskContext): Promise<void> {
    const content = this.serializeToMarkdown(context);
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Read TaskContext from a markdown file.
   */
  private async readContextFile(filePath: string): Promise<TaskContext> {
    const content = await fs.readFile(filePath, 'utf-8');
    return this.deserializeFromMarkdown(content);
  }

  /**
   * Serialize TaskContext to markdown format.
   *
   * Uses YAML frontmatter-like format for structured data,
   * with a human-readable progress section below.
   */
  private serializeToMarkdown(context: TaskContext): string {
    const lines: string[] = [
      `# Task Context: ${context.taskId}`,
      '',
      '<!-- task-context-v1 -->',
      `<!-- ${JSON.stringify(this.toJsonSerializable(context))} -->`,
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| **Task ID** | ${context.taskId} |`,
      `| **Chat ID** | ${context.chatId} |`,
      `| **Status** | ${context.status} |`,
      `| **Description** | ${context.description} |`,
      `| **Created** | ${context.createdAt} |`,
      `| **Updated** | ${context.updatedAt} |`,
      `| **Started** | ${context.startedAt ?? 'N/A'} |`,
      `| **Completed** | ${context.completedAt ?? 'N/A'} |`,
      `| **Current Step** | ${context.currentStep ?? 'N/A'} |`,
      `| **Progress** | ${context.completedSteps.length}/${context.totalSteps ?? '?'} |`,
      '',
    ];

    if (context.completedSteps.length > 0) {
      lines.push('## Completed Steps');
      lines.push('');
      context.completedSteps.forEach((step, i) => {
        lines.push(`${i + 1}. ${step}`);
      });
      lines.push('');
    }

    if (context.errors.length > 0) {
      lines.push('## Errors');
      lines.push('');
      context.errors.forEach((err, i) => {
        lines.push(`${i + 1}. ${err}`);
      });
      lines.push('');
    }

    if (context.metadata && Object.keys(context.metadata).length > 0) {
      lines.push('## Metadata');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(context.metadata, null, 2));
      lines.push('```');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Deserialize TaskContext from markdown format.
   *
   * Reads the embedded JSON comment for reliable parsing.
   */
  private deserializeFromMarkdown(content: string): TaskContext {
    // Extract JSON from HTML comment
    const match = content.match(/<!-- ({[\s\S]*?}) -->/);
    if (!match) {
      throw new Error('Invalid context.md format: missing JSON comment');
    }

    try {
      const json = JSON.parse(match[1]);
      return this.fromJsonDeserializable(json);
    } catch (error) {
      throw new Error(`Failed to parse context.md JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Convert TaskContext to a JSON-serializable object.
   * Ensures all values are JSON-safe.
   */
  private toJsonSerializable(context: TaskContext): Record<string, unknown> {
    return {
      taskId: context.taskId,
      chatId: context.chatId,
      status: context.status,
      description: context.description,
      createdAt: context.createdAt,
      updatedAt: context.updatedAt,
      startedAt: context.startedAt,
      completedAt: context.completedAt,
      currentStep: context.currentStep,
      completedSteps: context.completedSteps,
      totalSteps: context.totalSteps,
      errors: context.errors,
      metadata: context.metadata,
    };
  }

  /**
   * Convert a deserialized JSON object back to TaskContext.
   * Validates required fields and provides defaults for optional fields.
   */
  private fromJsonDeserializable(json: Record<string, unknown>): TaskContext {
    return {
      taskId: json.taskId as string,
      chatId: json.chatId as string,
      status: json.status as TaskContextStatus,
      description: json.description as string,
      createdAt: json.createdAt as string,
      updatedAt: json.updatedAt as string,
      startedAt: json.startedAt as string | undefined,
      completedAt: json.completedAt as string | undefined,
      currentStep: json.currentStep as string | undefined,
      completedSteps: (json.completedSteps as string[]) ?? [],
      errors: (json.errors as string[]) ?? [],
      totalSteps: json.totalSteps as number | undefined,
      metadata: json.metadata as Record<string, unknown> | undefined,
    };
  }
}
