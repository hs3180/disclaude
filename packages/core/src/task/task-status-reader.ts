/**
 * TaskStatusReader - Reads task status from existing task file structure.
 *
 * Derives task progress from the existing markdown-based task directory:
 *
 * tasks/{task_id}/
 *   ├── task.md           → task description, created time
 *   ├── final_result.md   → task complete indicator
 *   └── iterations/
 *       ├── iter-1/
 *       │   ├── evaluation.md
 *       │   └── execution.md
 *       └── final-summary.md
 *
 * This design follows the "Markdown as Data" principle: no new state files needed,
 * status is derived from the existing file structure.
 *
 * @module task/task-status-reader
 * @see Issue #857 - Independent Agent progress reporting
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Status of a task derived from file structure.
 */
export interface TaskStatus {
  /** Task ID (derived from directory name) */
  taskId: string;
  /** Current status: running, completed, or unknown */
  status: 'running' | 'completed' | 'unknown';
  /** Task title (extracted from task.md first heading) */
  title: string;
  /** Task description (from task.md ## Original Request) */
  description: string;
  /** Chat ID associated with this task */
  chatId: string;
  /** Creation timestamp (from task.md **Created** field) */
  createdAt: string;
  /** Number of iterations completed */
  totalIterations: number;
  /** Whether final summary exists */
  hasFinalSummary: boolean;
  /** Whether final result exists (task marked complete) */
  hasFinalResult: boolean;
  /** Latest iteration number (0 if none) */
  latestIteration: number;
  /** Whether latest iteration has evaluation */
  hasLatestEvaluation: boolean;
  /** Whether latest iteration has execution */
  hasLatestExecution: boolean;
  /** Directory path for this task */
  taskDir: string;
}

/**
 * Summary of all active (running) tasks.
 */
export interface ActiveTasksSummary {
  /** List of active tasks with their status */
  tasks: TaskStatus[];
  /** Total number of active tasks */
  totalActive: number;
  /** Timestamp of this summary */
  generatedAt: string;
}

/**
 * TaskStatusReader - Derives task progress from existing markdown files.
 *
 * No new state files are created. Status is computed from:
 * - task.md presence and content
 * - iterations/ directory contents
 * - final_result.md existence
 * - final-summary.md existence
 */
export class TaskStatusReader {
  private readonly tasksDir: string;

  /**
   * Create a TaskStatusReader.
   *
   * @param workspaceDir - Workspace directory containing tasks/
   */
  constructor(workspaceDir: string) {
    this.tasksDir = path.join(workspaceDir, 'tasks');
  }

  /**
   * Read status of a specific task.
   *
   * @param taskId - Task identifier (typically message ID)
   * @returns TaskStatus or null if task doesn't exist
   */
  async getTaskStatus(taskId: string): Promise<TaskStatus | null> {
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const taskDir = path.join(this.tasksDir, sanitized);

    // Check if task directory exists
    try {
      await fs.access(taskDir);
    } catch {
      return null;
    }

    // Check for final_result.md
    const hasFinalResult = await this.fileExists(
      path.join(taskDir, 'final_result.md')
    );

    // Check for final-summary.md
    const hasFinalSummary = await this.fileExists(
      path.join(taskDir, 'iterations', 'final-summary.md')
    );

    // Parse task.md
    const taskMdPath = path.join(taskDir, 'task.md');
    const taskMdContent = await this.readOptionalFile(taskMdPath);
    const parsed = this.parseTaskMd(taskMdContent || '');

    // List iterations
    const iterations = await this.listIterations(taskDir);
    const latestIteration = iterations.length > 0 ? Math.max(...iterations) : 0;

    // Check latest iteration files
    const hasLatestEvaluation =
      latestIteration > 0 &&
      (await this.fileExists(
        path.join(taskDir, 'iterations', `iter-${latestIteration}`, 'evaluation.md')
      ));

    const hasLatestExecution =
      latestIteration > 0 &&
      (await this.fileExists(
        path.join(taskDir, 'iterations', `iter-${latestIteration}`, 'execution.md')
      ));

    // Determine status
    let status: TaskStatus['status'] = 'unknown';
    if (hasFinalResult) {
      status = 'completed';
    } else if (taskMdContent) {
      status = 'running';
    }

    return {
      taskId,
      status,
      title: parsed.title,
      description: parsed.description,
      chatId: parsed.chatId,
      createdAt: parsed.createdAt,
      totalIterations: iterations.length,
      hasFinalSummary,
      hasFinalResult,
      latestIteration,
      hasLatestEvaluation,
      hasLatestExecution,
      taskDir,
    };
  }

  /**
   * Get all active (running) tasks.
   *
   * Active tasks are those that have a task.md but no final_result.md.
   *
   * @returns Summary of all active tasks
   */
  async getActiveTasks(): Promise<ActiveTasksSummary> {
    const tasks: TaskStatus[] = [];

    // Ensure tasks directory exists
    try {
      await fs.access(this.tasksDir);
    } catch {
      return {
        tasks: [],
        totalActive: 0,
        generatedAt: new Date().toISOString(),
      };
    }

    // List task directories
    const entries = await fs.readdir(this.tasksDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Check if task.md exists
      const taskMdPath = path.join(this.tasksDir, entry.name, 'task.md');
      const hasTaskMd = await this.fileExists(taskMdPath);
      if (!hasTaskMd) continue;

      // Check if final_result.md exists (completed task)
      const finalResultPath = path.join(this.tasksDir, entry.name, 'final_result.md');
      const hasFinalResult = await this.fileExists(finalResultPath);
      if (hasFinalResult) continue;

      // This is an active task
      const status = await this.getTaskStatus(entry.name);
      if (status) {
        tasks.push(status);
      }
    }

    return {
      tasks,
      totalActive: tasks.length,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Get a formatted markdown summary of all active tasks.
   *
   * Useful for the Reporter Agent to quickly assess what's happening.
   *
   * @returns Markdown string summarizing active tasks
   */
  async getActiveTasksMarkdown(): Promise<string> {
    const summary = await this.getActiveTasks();

    if (summary.totalActive === 0) {
      return 'No active tasks found.';
    }

    const lines: string[] = [
      `## Active Tasks (${summary.totalActive})`,
      '',
      `*Generated at: ${summary.generatedAt}*`,
      '',
    ];

    for (const task of summary.tasks) {
      lines.push(`### ${task.title}`);
      lines.push(`- **Task ID**: ${task.taskId}`);
      lines.push(`- **Chat**: ${task.chatId}`);
      lines.push(`- **Started**: ${task.createdAt}`);
      lines.push(`- **Iterations**: ${task.totalIterations} (latest: iter-${task.latestIteration})`);
      lines.push(
        `- **Latest iter status**: ${formatLatestStatus(task)}`
      );
      if (task.description) {
        lines.push(`- **Description**: ${task.description.substring(0, 200)}${task.description.length > 200 ? '...' : ''}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Get detailed markdown for a specific task's latest iteration.
   *
   * @param taskId - Task identifier
   * @returns Markdown content of the latest evaluation and execution, or null
   */
  async getTaskLatestIterationDetail(taskId: string): Promise<string | null> {
    const status = await this.getTaskStatus(taskId);
    if (!status || status.latestIteration === 0) return null;

    const iterDir = path.join(
      status.taskDir,
      'iterations',
      `iter-${status.latestIteration}`
    );

    const parts: string[] = [];

    const evaluation = await this.readOptionalFile(
      path.join(iterDir, 'evaluation.md')
    );
    if (evaluation) {
      parts.push('## Latest Evaluation\n');
      parts.push(evaluation);
      parts.push('');
    }

    const execution = await this.readOptionalFile(
      path.join(iterDir, 'execution.md')
    );
    if (execution) {
      parts.push('## Latest Execution\n');
      parts.push(execution);
      parts.push('');
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  // ===== Private helpers =====

  /**
   * Check if a file exists.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a file, returning null if it doesn't exist.
   */
  private async readOptionalFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Parse task.md content to extract metadata.
   */
  private parseTaskMd(content: string): {
    title: string;
    description: string;
    chatId: string;
    createdAt: string;
  } {
    const result = {
      title: 'Unknown Task',
      description: '',
      chatId: '',
      createdAt: '',
    };

    if (!content) return result;

    // Extract title from first heading, stripping "Task: " prefix if present
    const titleMatch = content.match(/^#\s+(?:Task:\s*)?(.+)/m);
    if (titleMatch) {
      result.title = titleMatch[1].trim();
    }

    // Extract Chat ID
    const chatIdMatch = content.match(/\*\*Chat ID\*\*:\s*(.+)/);
    if (chatIdMatch) {
      result.chatId = chatIdMatch[1].trim();
    }

    // Extract creation time
    const createdMatch = content.match(/\*\*Created\*\*:\s*(.+)/);
    if (createdMatch) {
      result.createdAt = createdMatch[1].trim();
    }

    // Extract description from Original Request code block
    const descMatch = content.match(/##\s+Original Request\s*\n\n```\n?([\s\S]*?)\n?```/);
    if (descMatch) {
      result.description = descMatch[1].trim();
    }

    return result;
  }

  /**
   * List iteration numbers for a task directory.
   */
  private async listIterations(taskDir: string): Promise<number[]> {
    const iterationsDir = path.join(taskDir, 'iterations');

    try {
      await fs.access(iterationsDir);
    } catch {
      return [];
    }

    try {
      const entries = await fs.readdir(iterationsDir, { withFileTypes: true });
      const iterations: number[] = [];

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('iter-')) {
          const match = entry.name.match(/^iter-(\d+)$/);
          if (match) {
            iterations.push(parseInt(match[1], 10));
          }
        }
      }

      return iterations.sort((a, b) => a - b);
    } catch {
      return [];
    }
  }
}

/**
 * Format the status of the latest iteration for display.
 */
function formatLatestStatus(task: TaskStatus): string {
  if (task.latestIteration === 0) {
    return 'Not started';
  }

  const parts: string[] = [];
  if (task.hasLatestExecution) parts.push('executed');
  if (task.hasLatestEvaluation) parts.push('evaluated');

  return parts.length > 0 ? parts.join(' + ') : 'in progress';
}
