/**
 * TaskContext - File-based shared task state for inter-agent communication.
 *
 * Implements the independent Reporter Agent pattern from Issue #857.
 *
 * Design Principles:
 * - File-based: Uses markdown files for state persistence (consistent with project philosophy)
 * - Inter-agent: Enables communication between Deep Task and Reporter Agent
 * - Human-readable: State files are readable by both agents and humans
 * - Schedule-compatible: Works with the schedule-based task system (Issue #1309)
 *
 * State File: tasks/{task_id}/task-context.md
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
 * Task phase in the execution lifecycle.
 */
export type TaskPhase =
  | 'pending'        // Task created, not yet started
  | 'defining'       // Pilot is defining task objectives
  | 'executing'      // Executor is working on the task
  | 'evaluating'     // Evaluator is checking completion
  | 'reflecting'     // Reflecting on evaluation results
  | 'reporting'      // Reporter is sending results to user
  | 'completed'      // Task completed successfully
  | 'failed';        // Task failed

/**
 * Task context data representing current task state.
 */
export interface TaskContextData {
  /** Unique task identifier (typically messageId) */
  taskId: string;
  /** Human-readable task title */
  title: string;
  /** Task description */
  description: string;
  /** Current execution phase */
  phase: TaskPhase;
  /** Current iteration number (1-indexed, 0 if not started) */
  iteration: number;
  /** Maximum iterations configured */
  maxIterations: number;
  /** Progress percentage (0-100) */
  progress: number;
  /** Start timestamp (ISO string) */
  startedAt: string | null;
  /** Last updated timestamp (ISO string) */
  updatedAt: string;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Estimated time to completion in milliseconds (null if unknown) */
  etaMs: number | null;
  /** Chat ID for user notifications */
  chatId: string;
  /** User ID who initiated the task */
  userId: string | null;
  /** Error message if task failed */
  error: string | null;
  /** Key milestones and their completion status */
  milestones: TaskMilestone[];
  /** Current activity description (what the task is doing right now) */
  currentActivity: string;
}

/**
 * Task milestone for progress tracking.
 */
export interface TaskMilestone {
  /** Milestone name */
  name: string;
  /** Whether this milestone is completed */
  completed: boolean;
  /** Timestamp when completed (ISO string) */
  completedAt: string | null;
}

// ============================================================================
// Constants
// ============================================================================

const CONTEXT_FILENAME = 'task-context.md';

// ============================================================================
// TaskContext Class
// ============================================================================

/**
 * File-based TaskContext for sharing task state between agents.
 *
 * The context is stored as a markdown file at:
 * `tasks/{task_id}/task-context.md`
 *
 * Usage:
 * ```typescript
 * const ctx = await TaskContext.create(taskId, workspaceDir, {
 *   title: 'Fix login bug',
 *   description: 'Fix authentication issue',
 *   chatId: 'oc_xxx',
 * });
 *
 * // Update state during execution
 * await ctx.update({ phase: 'executing', iteration: 1, currentActivity: 'Fixing auth flow' });
 *
 * // Read state from another agent (Reporter)
 * const data = await ctx.read();
 *
 * // Complete the task
 * await ctx.complete();
 * ```
 */
export class TaskContext {
  private readonly contextPath: string;

  private constructor(
    workspaceDir: string,
    private readonly taskId: string
  ) {
    const tasksDir = path.join(workspaceDir, 'tasks');
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.contextPath = path.join(tasksDir, sanitized, CONTEXT_FILENAME);
  }

  // ============================================================================
  // Factory Methods
  // ============================================================================

  /**
   * Create a new TaskContext for a task.
   *
   * @param taskId - Unique task identifier
   * @param workspaceDir - Workspace directory path
   * @param options - Initial context options
   * @returns TaskContext instance
   */
  static async create(
    taskId: string,
    workspaceDir: string,
    options: {
      title: string;
      description?: string;
      chatId: string;
      userId?: string;
      maxIterations?: number;
    }
  ): Promise<TaskContext> {
    const ctx = new TaskContext(workspaceDir, taskId);

    const data: TaskContextData = {
      taskId,
      title: options.title,
      description: options.description || '',
      phase: 'pending',
      iteration: 0,
      maxIterations: options.maxIterations || 10,
      progress: 0,
      startedAt: null,
      updatedAt: new Date().toISOString(),
      elapsedMs: 0,
      etaMs: null,
      chatId: options.chatId,
      userId: options.userId || null,
      error: null,
      milestones: [],
      currentActivity: 'Task created, waiting to start',
    };

    await ctx.write(data);
    logger.info({ taskId }, 'TaskContext created');
    return ctx;
  }

  /**
   * Load an existing TaskContext.
   *
   * @param taskId - Unique task identifier
   * @param workspaceDir - Workspace directory path
   * @returns TaskContext instance
   * @throws Error if context file doesn't exist
   */
  static async load(
    taskId: string,
    workspaceDir: string
  ): Promise<TaskContext> {
    const ctx = new TaskContext(workspaceDir, taskId);
    const data = await ctx.read();
    if (!data) {
      throw new Error(`TaskContext not found for task: ${taskId}`);
    }
    return ctx;
  }

  /**
   * Try to load an existing TaskContext without throwing.
   *
   * @param taskId - Unique task identifier
   * @param workspaceDir - Workspace directory path
   * @returns TaskContext instance or null if not found
   */
  static async tryLoad(
    taskId: string,
    workspaceDir: string
  ): Promise<TaskContext | null> {
    const ctx = new TaskContext(workspaceDir, taskId);
    const data = await ctx.read();
    if (!data) {
      return null;
    }
    return ctx;
  }

  /**
   * List all active (non-terminal) task contexts in the workspace.
   *
   * @param workspaceDir - Workspace directory path
   * @returns Array of active TaskContextData
   */
  static async listActive(workspaceDir: string): Promise<TaskContextData[]> {
    const tasksDir = path.join(workspaceDir, 'tasks');
    const results: TaskContextData[] = [];

    try {
      const entries = await fs.readdir(tasksDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const contextPath = path.join(tasksDir, entry.name, CONTEXT_FILENAME);
        try {
          const content = await fs.readFile(contextPath, 'utf-8');
          const data = TaskContext.parseMarkdown(content);
          // Only include non-terminal states
          if (data && data.phase !== 'completed' && data.phase !== 'failed') {
            results.push(data);
          }
        } catch {
          // Context file doesn't exist or can't be read, skip
        }
      }
    } catch {
      // tasks directory doesn't exist
    }

    return results;
  }

  // ============================================================================
  // Read / Write Operations
  // ============================================================================

  /**
   * Read current task context data.
   *
   * @returns TaskContextData or null if not found
   */
  async read(): Promise<TaskContextData | null> {
    try {
      const content = await fs.readFile(this.contextPath, 'utf-8');
      const data = TaskContext.parseMarkdown(content);

      if (data) {
        // Recalculate elapsed time
        if (data.startedAt) {
          data.elapsedMs = Date.now() - new Date(data.startedAt).getTime();
        }
        // Recalculate ETA based on progress
        if (data.startedAt && data.progress > 0 && data.progress < 100) {
          const totalEstimatedMs = data.elapsedMs / (data.progress / 100);
          data.etaMs = Math.max(0, totalEstimatedMs - data.elapsedMs);
        } else if (data.progress >= 100) {
          data.etaMs = 0;
        }
      }

      return data;
    } catch {
      return null;
    }
  }

  /**
   * Update task context with partial changes.
   *
   * @param updates - Partial update to merge into current context
   */
  async update(updates: Partial<TaskContextData>): Promise<void> {
    const current = await this.read();
    if (!current) {
      throw new Error(`TaskContext not found for task: ${this.taskId}`);
    }

    const updated: TaskContextData = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    // Auto-start timer on first execution phase
    if (updates.phase && ['executing', 'evaluating'].includes(updates.phase) && !current.startedAt) {
      updated.startedAt = new Date().toISOString();
    }

    await this.write(updated);
    logger.debug(
      { taskId: this.taskId, phase: updated.phase, progress: updated.progress },
      'TaskContext updated'
    );
  }

  /**
   * Set task phase.
   *
   * @param phase - New task phase
   * @param activity - Optional description of current activity
   */
  async setPhase(phase: TaskPhase, activity?: string): Promise<void> {
    const updates: Partial<TaskContextData> = { phase };
    if (activity) {
      updates.currentActivity = activity;
    }

    if (phase === 'executing' || phase === 'evaluating') {
      updates.iteration = ((await this.read())?.iteration || 0) + 1;
    }

    await this.update(updates);
  }

  /**
   * Update progress percentage.
   *
   * @param progress - Progress value (0-100)
   * @param activity - Optional description of current activity
   */
  async setProgress(progress: number, activity?: string): Promise<void> {
    const clampedProgress = Math.max(0, Math.min(100, progress));
    const updates: Partial<TaskContextData> = { progress: clampedProgress };
    if (activity) {
      updates.currentActivity = activity;
    }
    await this.update(updates);
  }

  /**
   * Add or update a milestone.
   *
   * @param name - Milestone name
   * @param completed - Whether the milestone is completed
   */
  async setMilestone(name: string, completed: boolean): Promise<void> {
    const current = await this.read();
    if (!current) {
      throw new Error(`TaskContext not found for task: ${this.taskId}`);
    }

    const existing = current.milestones.find(m => m.name === name);
    if (existing) {
      if (completed && !existing.completed) {
        existing.completed = true;
        existing.completedAt = new Date().toISOString();
      }
    } else {
      current.milestones.push({
        name,
        completed,
        completedAt: completed ? new Date().toISOString() : null,
      });
    }

    // Recalculate progress based on milestones
    if (current.milestones.length > 0) {
      const completedCount = current.milestones.filter(m => m.completed).length;
      current.progress = Math.round((completedCount / current.milestones.length) * 100);
    }

    await this.write(current);
  }

  /**
   * Mark task as completed.
   *
   * @param activity - Optional completion description
   */
  async complete(activity?: string): Promise<void> {
    await this.update({
      phase: 'completed',
      progress: 100,
      etaMs: 0,
      currentActivity: activity || 'Task completed successfully',
    });
    logger.info({ taskId: this.taskId }, 'TaskContext marked as completed');
  }

  /**
   * Mark task as failed.
   *
   * @param error - Error message
   */
  async fail(error: string): Promise<void> {
    await this.update({
      phase: 'failed',
      error,
      currentActivity: `Task failed: ${error}`,
    });
    logger.error({ taskId: this.taskId, error }, 'TaskContext marked as failed');
  }

  /**
   * Get formatted status summary for human consumption.
   *
   * @returns Formatted status string
   */
  async getFormattedStatus(): Promise<string> {
    const data = await this.read();
    if (!data) {
      return '❓ No active task found';
    }

    const phaseEmoji: Record<TaskPhase, string> = {
      pending: '⏳',
      defining: '📝',
      executing: '⚙️',
      evaluating: '🔍',
      reflecting: '🤔',
      reporting: '📊',
      completed: '✅',
      failed: '❌',
    };

    const progress = data.progress;
    const filledBars = Math.round(progress / 5);
    const emptyBars = 20 - filledBars;
    const progressBar = '█'.repeat(filledBars) + '░'.repeat(emptyBars);

    const elapsedStr = formatDuration(data.elapsedMs);
    const etaStr = data.etaMs !== null ? formatDuration(data.etaMs) : '计算中...';

    const milestoneLines = data.milestones.length > 0
      ? '\n\n**里程碑:**\n' + data.milestones.map(m =>
          `${m.completed ? '✅' : '⬜'} ${m.name}`
        ).join('\n')
      : '';

    return [
      `${phaseEmoji[data.phase]} **${data.title}**`,
      `状态: ${data.phase} | 迭代: ${data.iteration}/${data.maxIterations}`,
      `进度: ${progressBar} ${progress}%`,
      `已用: ${elapsedStr} | 预计剩余: ${etaStr}`,
      `当前: ${data.currentActivity}`,
      milestoneLines,
    ].filter(Boolean).join('\n');
  }

  /**
   * Check if the context exists.
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.contextPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the context file path.
   */
  getContextPath(): string {
    return this.contextPath;
  }

  /**
   * Get the task ID.
   */
  getTaskId(): string {
    return this.taskId;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Write task context data to file as markdown.
   */
  private async write(data: TaskContextData): Promise<void> {
    const content = TaskContext.toMarkdown(data);
    const dir = path.dirname(this.contextPath);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.contextPath, content, 'utf-8');
    } catch (error) {
      logger.error({ err: error, taskId: this.taskId }, 'Failed to write TaskContext');
      throw error;
    }
  }

  // ============================================================================
  // Static Helpers
  // ============================================================================

  /**
   * Convert TaskContextData to markdown format.
   */
  static toMarkdown(data: TaskContextData): string {
    const lines: string[] = [
      '---',
      `task_id: "${data.taskId}"`,
      `title: "${data.title.replace(/"/g, '\\"')}"`,
      `phase: ${data.phase}`,
      `iteration: ${data.iteration}`,
      `max_iterations: ${data.maxIterations}`,
      `progress: ${data.progress}`,
      `started_at: "${data.startedAt || ''}"`,
      `updated_at: "${data.updatedAt}"`,
      `elapsed_ms: ${data.elapsedMs}`,
      `eta_ms: ${data.etaMs ?? 'null'}`,
      `chat_id: "${data.chatId}"`,
      `user_id: "${data.userId || ''}"`,
      `error: "${(data.error || '').replace(/"/g, '\\"')}"`,
      '---',
      '',
      `# Task: ${data.title}`,
      '',
      `**Status**: ${data.phase}`,
      `**Progress**: ${data.progress}%`,
      `**Iteration**: ${data.iteration} / ${data.maxIterations}`,
      `**Started**: ${data.startedAt || 'Not started'}`,
      `**Updated**: ${data.updatedAt}`,
      `**Elapsed**: ${formatDuration(data.elapsedMs)}`,
      `**ETA**: ${data.etaMs !== null ? formatDuration(data.etaMs) : 'Unknown'}`,
      '',
      '## Description',
      '',
      data.description || 'No description provided.',
      '',
      '## Current Activity',
      '',
      data.currentActivity || 'No activity reported.',
    ];

    // Add milestones section if any
    if (data.milestones.length > 0) {
      lines.push('', '## Milestones', '');
      for (const milestone of data.milestones) {
        const status = milestone.completed ? '✅' : '⬜';
        const time = milestone.completedAt ? ` (${milestone.completedAt})` : '';
        lines.push(`- ${status} ${milestone.name}${time}`);
      }
    }

    // Add error section if failed
    if (data.error) {
      lines.push('', '## Error', '', data.error);
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Parse markdown content into TaskContextData.
   */
  static parseMarkdown(content: string): TaskContextData | null {
    try {
      // Parse YAML frontmatter
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) return null;

      const frontmatter: Record<string, string> = {};
      for (const line of frontmatterMatch[1].split('\n')) {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;
        const key = line.slice(0, colonIndex).trim();
        let value = line.slice(colonIndex + 1).trim();
        // Remove surrounding quotes
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        frontmatter[key] = value;
      }

      // Extract title from markdown heading if not in frontmatter
      const titleMatch = content.match(/^# Task: (.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : frontmatter.title || '';

      // Extract description
      const descMatch = content.match(/## Description\n\n([\s\S]*?)(?=\n## )/);
      const description = descMatch ? descMatch[1].trim() : '';

      // Extract current activity
      const activityMatch = content.match(/## Current Activity\n\n([\s\S]*?)(?=\n## |\n*$)/);
      const currentActivity = activityMatch ? activityMatch[1].trim() : '';

      // Parse milestones
      const milestones: TaskMilestone[] = [];
      const milestoneSection = content.match(/## Milestones\n\n([\s\S]*?)(?=\n## |\n*$)/);
      if (milestoneSection) {
        for (const line of milestoneSection[1].split('\n')) {
          const completedMatch = line.match(/^- ✅ (.+?)(?: \((.+?)\))?$/);
          const pendingMatch = line.match(/^- ⬜ (.+)$/);
          if (completedMatch) {
            milestones.push({
              name: completedMatch[1].trim(),
              completed: true,
              completedAt: completedMatch[2] || null,
            });
          } else if (pendingMatch) {
            milestones.push({
              name: pendingMatch[1].trim(),
              completed: false,
              completedAt: null,
            });
          }
        }
      }

      // Extract error
      const errorMatch = content.match(/## Error\n\n([\s\S]*?)$/);
      const error = errorMatch ? errorMatch[1].trim() : null;

      const startedAt = frontmatter.started_at || null;
      let elapsedMs = parseInt(frontmatter.elapsed_ms || '0', 10);
      // Recalculate elapsed time if task has started
      if (startedAt) {
        elapsedMs = Date.now() - new Date(startedAt).getTime();
      }

      const etaMsStr = frontmatter.eta_ms;
      const etaMs = etaMsStr === 'null' || !etaMsStr ? null : parseInt(etaMsStr, 10);

      return {
        taskId: frontmatter.task_id || '',
        title,
        description,
        phase: (frontmatter.phase as TaskPhase) || 'pending',
        iteration: parseInt(frontmatter.iteration || '0', 10),
        maxIterations: parseInt(frontmatter.max_iterations || '10', 10),
        progress: parseInt(frontmatter.progress || '0', 10),
        startedAt,
        updatedAt: frontmatter.updated_at || new Date().toISOString(),
        elapsedMs,
        etaMs,
        chatId: frontmatter.chat_id || '',
        userId: frontmatter.user_id || null,
        error,
        milestones,
        currentActivity,
      };
    } catch {
      return null;
    }
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format milliseconds into a human-readable duration string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string (e.g., "5m 30s", "1h 15m")
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${seconds}s`;
  }
}
