/**
 * Task Status MCP Tool - Reads deep task status from the file system.
 *
 * Issue #857: Provides the "Task Context" that an independent Agent reads
 * to decide when/how to report progress. The Agent calls this tool to
 * understand the current state of a deep task.
 *
 * @module mcp-server/tools/task-status
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getWorkspaceDir } from './credentials.js';

/**
 * Iteration status within a task.
 */
interface IterationStatus {
  /** Iteration number (1-indexed) */
  iteration: number;
  /** Whether evaluation.md exists */
  hasEvaluation: boolean;
  /** Whether execution.md exists */
  hasExecution: boolean;
  /** Number of step result files */
  stepCount: number;
}

/**
 * Task status returned by the tool.
 */
export interface TaskStatusResult {
  success: boolean;
  message: string;
  /** Task status details (present on success) */
  status?: {
    /** Task ID */
    taskId: string;
    /** Whether the task exists */
    exists: boolean;
    /** Task title (extracted from task.md first line heading) */
    title: string;
    /** Current task phase */
    phase: 'pending' | 'evaluating' | 'executing' | 'completed' | 'unknown';
    /** Total number of iterations */
    totalIterations: number;
    /** Per-iteration status */
    iterations: IterationStatus[];
    /** Whether final_result.md exists (task complete) */
    hasFinalResult: boolean;
    /** Whether final-summary.md exists */
    hasFinalSummary: boolean;
    /** Task creation time (file mtime of task.md) */
    createdAt: string | null;
    /** Elapsed time since task creation (ISO duration string) */
    elapsed: string | null;
    /** Raw task.md content (truncated to first 2000 chars) */
    taskSpec: string | null;
  };
}

/**
 * Get the status of a deep task.
 *
 * Reads the task file system to determine:
 * - Task existence and metadata
 * - Current phase (pending/evaluating/executing/completed)
 * - Iteration progress
 * - Completion status
 *
 * @param params - Tool parameters
 * @param params.taskId - The task ID (typically the message ID)
 * @returns Task status result
 */
export async function get_task_status(
  params: { taskId: string }
): Promise<TaskStatusResult> {
  const { taskId } = params;

  if (!taskId || typeof taskId !== 'string') {
    return {
      success: false,
      message: 'Invalid taskId: must be a non-empty string',
    };
  }

  const workspaceDir = getWorkspaceDir();
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const taskDir = path.join(workspaceDir, 'tasks', sanitized);
  const taskSpecPath = path.join(taskDir, 'task.md');
  const iterationsDir = path.join(taskDir, 'iterations');
  const finalResultPath = path.join(taskDir, 'final_result.md');
  const finalSummaryPath = path.join(iterationsDir, 'final-summary.md');

  // Check if task directory exists
  try {
    await fs.access(taskDir);
  } catch {
    return {
      success: true,
      message: `Task ${taskId} not found`,
      status: {
        taskId,
        exists: false,
        title: '',
        phase: 'unknown',
        totalIterations: 0,
        iterations: [],
        hasFinalResult: false,
        hasFinalSummary: false,
        createdAt: null,
        elapsed: null,
        taskSpec: null,
      },
    };
  }

  // Read task.md
  let taskSpec: string | null = null;
  let title = '';
  let createdAt: string | null = null;

  try {
    const specContent = await fs.readFile(taskSpecPath, 'utf-8');
    taskSpec = specContent.length > 2000 ? `${specContent.substring(0, 2000)}...` : specContent;

    // Extract title from first markdown heading
    const titleMatch = specContent.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1].trim();
    }

    // Get creation time from file stats
    const stat = await fs.stat(taskSpecPath);
    createdAt = stat.mtime.toISOString();
  } catch {
    // task.md might not exist yet
  }

  // Check final_result.md
  let hasFinalResult = false;
  try {
    await fs.access(finalResultPath);
    hasFinalResult = true;
  } catch {
    // doesn't exist
  }

  // Check final-summary.md
  let hasFinalSummary = false;
  try {
    await fs.access(finalSummaryPath);
    hasFinalSummary = true;
  } catch {
    // doesn't exist
  }

  // List iterations
  const iterations: IterationStatus[] = [];
  let totalIterations = 0;

  try {
    const entries = await fs.readdir(iterationsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('iter-')) {
        const match = entry.name.match(/^iter-(\d+)$/);
        if (match) {
          const iterNum = parseInt(match[1], 10);
          totalIterations = Math.max(totalIterations, iterNum);

          const iterDir = path.join(iterationsDir, entry.name);
          const stepsDir = path.join(iterDir, 'steps');

          // Check evaluation.md
          let hasEvaluation = false;
          try {
            await fs.access(path.join(iterDir, 'evaluation.md'));
            hasEvaluation = true;
          } catch {
            // doesn't exist
          }

          // Check execution.md
          let hasExecution = false;
          try {
            await fs.access(path.join(iterDir, 'execution.md'));
            hasExecution = true;
          } catch {
            // doesn't exist
          }

          // Count steps
          let stepCount = 0;
          try {
            const stepFiles = await fs.readdir(stepsDir);
            stepCount = stepFiles.filter(f => f.match(/^step-\d+\.md$/)).length;
          } catch {
            // steps dir doesn't exist
          }

          iterations.push({
            iteration: iterNum,
            hasEvaluation,
            hasExecution,
            stepCount,
          });
        }
      }
    }
  } catch {
    // iterations dir doesn't exist
  }

  // Sort iterations by number
  iterations.sort((a, b) => a.iteration - b.iteration);

  // Determine phase
  let phase: 'pending' | 'evaluating' | 'executing' | 'completed' | 'unknown' = 'pending';

  if (hasFinalResult) {
    phase = 'completed';
  } else if (iterations.length > 0) {
    const latestIter = iterations[iterations.length - 1];
    if (latestIter.hasEvaluation && latestIter.hasExecution) {
      // Both evaluation and execution done - likely waiting for next iteration
      phase = 'evaluating';
    } else if (latestIter.hasEvaluation && !latestIter.hasExecution) {
      phase = 'executing';
    } else {
      phase = 'evaluating';
    }
  } else if (taskSpec) {
    // task.md exists but no iterations yet
    phase = 'pending';
  }

  // Calculate elapsed time
  let elapsed: string | null = null;
  if (createdAt) {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMs = now.getTime() - created.getTime();
    const minutes = Math.floor(diffMs / 60000);
    const seconds = Math.floor((diffMs % 60000) / 1000);

    if (minutes > 0) {
      elapsed = `${minutes}m ${seconds}s`;
    } else {
      elapsed = `${seconds}s`;
    }
  }

  const status = {
    taskId,
    exists: true,
    title,
    phase,
    totalIterations: iterations.length,
    iterations,
    hasFinalResult,
    hasFinalSummary,
    createdAt,
    elapsed,
    taskSpec,
  };

  return {
    success: true,
    message: `Task ${taskId} status: ${phase} (${iterations.length} iteration${iterations.length !== 1 ? 's' : ''}${hasFinalResult ? ', completed' : ''})`,
    status,
  };
}
