/**
 * TaskContext - Shared state management for task progress reporting.
 *
 * Provides a centralized, file-based task state that can be read by
 * independent Reporter Agents to decide when and how to report progress
 * to users.
 *
 * Design Principles:
 * - Markdown as Data: Persists state as readable markdown (consistent with
 *   the codebase's "Markdown as Data" philosophy)
 * - Human-Readable: All task progress is traceable by both humans and agents
 * - Agent-Driven Reporting: Provides rich context for agents to make
 *   intelligent reporting decisions (no fixed intervals)
 *
 * Directory structure extension:
 * {task_id}/
 *   ├── task.md
 *   ├── task-context.md    ← NEW: shared state for Reporter Agent
 *   ├── final_result.md
 *   └── iterations/
 *
 * @module task/task-context
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskContext');

/**
 * Status of a task step.
 */
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/**
 * Status of the overall task.
 */
export type TaskRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Information about a single task step.
 */
export interface StepInfo {
  /** Step name/identifier */
  name: string;
  /** Current status */
  status: StepStatus;
  /** When the step started */
  startedAt: string | null;
  /** When the step completed/failed */
  completedAt: string | null;
  /** Result summary (if completed) */
  result: string | null;
  /** Error message (if failed) */
  error: string | null;
}

/**
 * Information about an error that occurred during task execution.
 */
export interface ErrorRecord {
  /** Step where the error occurred */
  step: string;
  /** Error message */
  message: string;
  /** When the error occurred */
  timestamp: string;
}

/**
 * Complete task context - the shared state between Deep Task and Reporter Agent.
 */
export interface TaskContextData {
  /** Task identifier */
  taskId: string;
  /** Chat ID for user notifications */
  chatId: string;
  /** Overall task status */
  status: TaskRunStatus;
  /** Brief description of the task */
  description: string;
  /** When the task was created */
  createdAt: string;
  /** When the task started running */
  startedAt: string | null;
  /** When the task was last updated */
  updatedAt: string;
  /** When the task completed/failed */
  completedAt: string | null;
  /** List of task steps with their status */
  steps: StepInfo[];
  /** Errors encountered during execution */
  errors: ErrorRecord[];
  /** Total number of planned steps (if known upfront) */
  totalStepsPlanned: number | null;
  /** Arbitrary metadata for extensibility */
  metadata: Record<string, string>;
}

/**
 * TaskContext - Manages shared task state for progress reporting.
 *
 * This class provides the interface for:
 * 1. Deep Task to write progress updates during execution
 * 2. Reporter Agent to read current state and decide when to report
 *
 * The state is persisted as `task-context.md` in the task directory,
 * making it both machine-readable (parseable) and human-readable.
 */
export class TaskContext {
  private readonly contextFilePath: string;
  private data: TaskContextData;

  /**
   * Create a TaskContext instance.
   *
   * @param taskDir - Absolute path to the task directory
   * @param taskId - Task identifier
   * @param chatId - Chat ID for user notifications
   * @param description - Brief task description
   */
  constructor(
    taskDir: string,
    taskId: string,
    chatId: string,
    description: string
  ) {
    this.contextFilePath = path.join(taskDir, 'task-context.md');
    const now = new Date().toISOString();
    this.data = {
      taskId,
      chatId,
      status: 'pending',
      description,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      steps: [],
      errors: [],
      totalStepsPlanned: null,
      metadata: {},
    };
  }

  /**
   * Create a TaskContext from an existing task directory.
   * Loads existing context if present, otherwise creates a new one.
   *
   * @param taskDir - Absolute path to the task directory
   * @param taskId - Task identifier
   * @param chatId - Chat ID for user notifications
   * @param description - Brief task description
   * @returns Initialized TaskContext
   */
  static async create(
    taskDir: string,
    taskId: string,
    chatId: string,
    description: string
  ): Promise<TaskContext> {
    const ctx = new TaskContext(taskDir, taskId, chatId, description);
    const existing = await ctx.loadFromDisk();
    if (existing) {
      ctx.data = existing;
    }
    return ctx;
  }

  /**
   * Get the current task context data (read-only snapshot).
   */
  getData(): Readonly<TaskContextData> {
    return { ...this.data, steps: [...this.data.steps], errors: [...this.data.errors] };
  }

  /**
   * Get the overall task status.
   */
  getStatus(): TaskRunStatus {
    return this.data.status;
  }

  /**
   * Get the number of completed steps.
   */
  getCompletedStepCount(): number {
    return this.data.steps.filter(s => s.status === 'completed').length;
  }

  /**
   * Get the total number of steps.
   */
  getTotalStepCount(): number {
    return this.data.steps.length;
  }

  /**
   * Get the elapsed time in seconds since the task started.
   */
  getElapsedTimeSeconds(): number | null {
    if (!this.data.startedAt) {return null;}
    const end = this.data.completedAt
      ? new Date(this.data.completedAt).getTime()
      : Date.now();
    return Math.round((end - new Date(this.data.startedAt).getTime()) / 1000);
  }

  /**
   * Check if a progress update would be informative.
   * This is a heuristic hint - the Reporter Agent makes the final decision.
   */
  shouldConsiderReporting(): boolean {
    // Don't report if task hasn't started
    if (this.data.status === 'pending') {return false;}
    // Always worth considering if there are errors
    if (this.data.errors.length > 0) {return true;}
    // Worth considering if steps have been completed
    if (this.getCompletedStepCount() > 0) {return true;}
    // Worth considering if running and some time has passed
    if (this.data.status === 'running') {
      const elapsed = this.getElapsedTimeSeconds();
      if (elapsed !== null && elapsed > 30) {return true;}
    }
    return false;
  }

  // ===== Write Operations (used by Deep Task / Executor) =====

  /**
   * Set the total number of planned steps.
   */
  setTotalStepsPlanned(count: number): void {
    this.data.totalStepsPlanned = count;
    this.data.updatedAt = new Date().toISOString();
  }

  /**
   * Mark the task as running.
   */
  start(): void {
    this.data.status = 'running';
    this.data.startedAt = new Date().toISOString();
    this.data.updatedAt = new Date().toISOString();
  }

  /**
   * Add a new step to the task context.
   */
  addStep(name: string): void {
    // Don't add duplicate steps
    if (this.data.steps.some(s => s.name === name)) {
      logger.warn({ stepName: name, taskId: this.data.taskId }, 'Step already exists, skipping add');
      return;
    }
    this.data.steps.push({
      name,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    });
    this.data.updatedAt = new Date().toISOString();
  }

  /**
   * Mark a step as in progress.
   */
  startStep(name: string): void {
    const step = this.data.steps.find(s => s.name === name);
    if (!step) {
      logger.warn({ stepName: name, taskId: this.data.taskId }, 'Step not found for startStep');
      return;
    }
    step.status = 'in_progress';
    step.startedAt = new Date().toISOString();
    this.data.updatedAt = new Date().toISOString();
  }

  /**
   * Mark a step as completed with a result summary.
   */
  completeStep(name: string, result?: string): void {
    const step = this.data.steps.find(s => s.name === name);
    if (!step) {
      logger.warn({ stepName: name, taskId: this.data.taskId }, 'Step not found for completeStep');
      return;
    }
    step.status = 'completed';
    step.completedAt = new Date().toISOString();
    step.result = result ?? null;
    this.data.updatedAt = new Date().toISOString();
  }

  /**
   * Mark a step as failed with an error message.
   */
  failStep(name: string, error: string): void {
    const step = this.data.steps.find(s => s.name === name);
    if (!step) {
      logger.warn({ stepName: name, taskId: this.data.taskId }, 'Step not found for failStep');
      return;
    }
    step.status = 'failed';
    step.completedAt = new Date().toISOString();
    step.error = error;
    this.data.errors.push({
      step: name,
      message: error,
      timestamp: new Date().toISOString(),
    });
    this.data.updatedAt = new Date().toISOString();
  }

  /**
   * Mark the task as completed.
   */
  complete(): void {
    this.data.status = 'completed';
    this.data.completedAt = new Date().toISOString();
    this.data.updatedAt = new Date().toISOString();
  }

  /**
   * Mark the task as failed.
   */
  fail(error: string): void {
    this.data.status = 'failed';
    this.data.completedAt = new Date().toISOString();
    this.data.errors.push({
      step: 'task',
      message: error,
      timestamp: new Date().toISOString(),
    });
    this.data.updatedAt = new Date().toISOString();
  }

  /**
   * Set arbitrary metadata.
   */
  setMetadata(key: string, value: string): void {
    this.data.metadata[key] = value;
    this.data.updatedAt = new Date().toISOString();
  }

  // ===== Persistence =====

  /**
   * Save the current context to disk as markdown.
   */
  async save(): Promise<void> {
    try {
      const dir = path.dirname(this.contextFilePath);
      await fs.mkdir(dir, { recursive: true });
      const markdown = this.toMarkdown();
      await fs.writeFile(this.contextFilePath, markdown, 'utf-8');
      logger.debug({ taskId: this.data.taskId, path: this.contextFilePath }, 'Task context saved');
    } catch (error) {
      logger.error({ err: error, taskId: this.data.taskId }, 'Failed to save task context');
      throw error;
    }
  }

  /**
   * Save synchronously (for critical writes before process exit).
   */
  saveSync(): void {
    try {
      const dir = path.dirname(this.contextFilePath);
      if (!fsSync.existsSync(dir)) {
        fsSync.mkdirSync(dir, { recursive: true });
      }
      const markdown = this.toMarkdown();
      fsSync.writeFileSync(this.contextFilePath, markdown, 'utf-8');
      logger.debug({ taskId: this.data.taskId }, 'Task context saved (sync)');
    } catch (error) {
      logger.error({ err: error, taskId: this.data.taskId }, 'Failed to save task context (sync)');
      throw error;
    }
  }

  /**
   * Load context from disk.
   *
   * @returns Parsed TaskContextData, or null if file doesn't exist
   */
  private async loadFromDisk(): Promise<TaskContextData | null> {
    try {
      const content = await fs.readFile(this.contextFilePath, 'utf-8');
      return TaskContext.parseMarkdown(content);
    } catch {
      return null;
    }
  }

  // ===== Markdown Serialization =====

  /**
   * Serialize context data to markdown format.
   */
  toMarkdown(): string {
    const d = this.data;
    const elapsed = this.getElapsedTimeSeconds();
    const completedSteps = this.getCompletedStepCount();
    const totalSteps = this.getTotalStepCount();

    let md = `# Task Context: ${d.description}

**Task ID**: ${d.taskId}
**Chat ID**: ${d.chatId}
**Status**: ${d.status}
**Created**: ${d.createdAt}
**Updated**: ${d.updatedAt}
${d.startedAt ? `**Started**: ${d.startedAt}` : ''}
${d.completedAt ? `**Completed**: ${d.completedAt}` : ''}
${elapsed !== null ? `**Elapsed**: ${elapsed}s` : ''}
**Progress**: ${completedSteps}/${totalSteps}${d.totalStepsPlanned ? ` (planned: ${d.totalStepsPlanned})` : ''}

## Steps

`;

    if (d.steps.length === 0) {
      md += '*No steps defined yet.*\n';
    } else {
      for (const step of d.steps) {
        const icon = this.statusIcon(step.status);
        const duration = step.startedAt && step.completedAt
          ? ` (${Math.round((new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()) / 1000)}s)`
          : '';
        md += `### ${icon} ${step.name}\n\n`;
        md += `- **Status**: ${step.status}\n`;
        if (step.startedAt) {md += `- **Started**: ${step.startedAt}\n`;}
        if (step.completedAt) {md += `- **Completed**: ${step.completedAt}${duration}\n`;}
        if (step.result) {md += `- **Result**: ${step.result}\n`;}
        if (step.error) {md += `- **Error**: ${step.error}\n`;}
        md += '\n';
      }
    }

    if (d.errors.length > 0) {
      md += '## Errors\n\n';
      for (const err of d.errors) {
        md += `- **[${err.timestamp}]** ${err.step}: ${err.message}\n`;
      }
      md += '\n';
    }

    if (Object.keys(d.metadata).length > 0) {
      md += '## Metadata\n\n';
      for (const [key, value] of Object.entries(d.metadata)) {
        md += `- **${key}**: ${value}\n`;
      }
      md += '\n';
    }

    // Embed JSON for reliable machine parsing (hidden HTML comment)
    md += `<!-- TASK_CONTEXT_JSON\n${JSON.stringify(d, null, 2)}\n-->\n`;

    return md;
  }

  /**
   * Get status icon for display.
   */
  private statusIcon(status: StepStatus | TaskRunStatus): string {
    const icons: Record<string, string> = {
      pending: '⏳',
      in_progress: '🔄',
      running: '🔄',
      completed: '✅',
      failed: '❌',
      cancelled: '🚫',
      skipped: '⏭️',
    };
    return icons[status] || '❓';
  }

  /**
   * Parse task-context.md content back into TaskContextData.
   *
   * This uses a structured code block at the end of the markdown for
   * reliable machine parsing, while keeping the human-readable markdown above.
   */
  static parseMarkdown(content: string): TaskContextData {
    // Extract JSON data from code block for reliable parsing
    const jsonMatch = content.match(/<!-- TASK_CONTEXT_JSON\n([\s\S]*?)\n-->/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch {
        logger.warn('Failed to parse embedded JSON, falling back to markdown parsing');
      }
    }

    // Fallback: parse the human-readable markdown
    return TaskContext.parseFromReadableMarkdown(content);
  }

  /**
   * Parse from human-readable markdown format (fallback).
   */
  private static parseFromReadableMarkdown(content: string): TaskContextData {
    const now = new Date().toISOString();
    const data: TaskContextData = {
      taskId: '',
      chatId: '',
      status: 'pending',
      description: '',
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      steps: [],
      errors: [],
      totalStepsPlanned: null,
      metadata: {},
    };

    // Parse header fields
    const taskIdMatch = content.match(/\*\*Task ID\*\*:\s*(.+)/);
    if (taskIdMatch) {data.taskId = taskIdMatch[1].trim();}

    const chatIdMatch = content.match(/\*\*Chat ID\*\*:\s*(.+)/);
    if (chatIdMatch) {data.chatId = chatIdMatch[1].trim();}

    const statusMatch = content.match(/\*\*Status\*\*:\s*(.+)/);
    if (statusMatch) {data.status = statusMatch[1].trim() as TaskRunStatus;}

    const descMatch = content.match(/^# Task Context:\s*(.+)$/m);
    if (descMatch) {data.description = descMatch[1].trim();}

    const createdMatch = content.match(/\*\*Created\*\*:\s*(.+)/);
    if (createdMatch) {data.createdAt = createdMatch[1].trim();}

    const startedMatch = content.match(/\*\*Started\*\*:\s*(.+)/);
    if (startedMatch) {data.startedAt = startedMatch[1].trim();}

    const completedMatch = content.match(/\*\*Completed\*\*:\s*(.+)/);
    if (completedMatch) {data.completedAt = completedMatch[1].trim();}

    const updatedMatch = content.match(/\*\*Updated\*\*:\s*(.+)/);
    if (updatedMatch) {data.updatedAt = updatedMatch[1].trim();}

    // Parse steps from ### sections
    const stepRegex = /### [^\s]+ (.+)\n\n([\s\S]*?)(?=\n### |\n## |$)/g;
    let stepMatch;
    while ((stepMatch = stepRegex.exec(content)) !== null) {
      const [, stepNameRaw, stepContentRaw] = stepMatch;
      const stepName = stepNameRaw.trim();
      const stepContent = stepContentRaw;

      const [, statusRaw = 'pending'] = stepContent.match(/\*\*Status\*\*:\s*(.+)/) ?? [];
      const [, startedRaw = ''] = stepContent.match(/\*\*Started\*\*:\s*(.+)/) ?? [];
      const [, completedRaw = ''] = stepContent.match(/\*\*Completed\*\*:\s*(.+)/) ?? [];
      const [, resultRaw = ''] = stepContent.match(/\*\*Result\*\*:\s*(.+)/) ?? [];
      const [, errorRaw = ''] = stepContent.match(/\*\*Error\*\*:\s*(.+)/) ?? [];

      data.steps.push({
        name: stepName,
        status: statusRaw.trim() as StepStatus || 'pending',
        startedAt: startedRaw ? startedRaw.trim() : null,
        completedAt: completedRaw ? completedRaw.replace(/\s*\(.*\)/, '').trim() : null,
        result: resultRaw ? resultRaw.trim() : null,
        error: errorRaw ? errorRaw.trim() : null,
      });
    }

    return data;
  }
}
