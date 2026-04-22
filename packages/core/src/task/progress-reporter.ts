/**
 * Progress reporter for deep tasks.
 *
 * Scans task directories, reads execution state, and formats progress cards
 * for delivery to users. Designed to be called periodically by a schedule.
 *
 * Task states are determined by file presence:
 * - pending:   task.md ✓, final_result.md ✗, running.lock ✗
 * - running:   running.lock ✓
 * - completed: final_result.md ✓
 * - failed:    failed.md ✓
 *
 * Progress report throttling:
 * - Each task tracks its last report time in `.last-progress-report`
 * - Reports are only sent if `minReportIntervalMs` has elapsed since last report
 *
 * @module task/progress-reporter
 */

import * as fs from 'fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ProgressReporter');

/** Feishu card JSON structure (minimal). */
export interface FeishuCard {
  config?: Record<string, unknown>;
  header?: Record<string, unknown>;
  elements?: Array<Record<string, unknown>>;
}

/** Progress data for a single running task. */
export interface TaskProgress {
  /** Task ID (sanitized directory name). */
  taskId: string;
  /** Task directory absolute path. */
  taskDir: string;
  /** Task title extracted from task.md first heading or frontmatter. */
  title: string;
  /** Chat ID extracted from task.md. */
  chatId: string;
  /** Current iteration number (0 if no iterations yet). */
  currentIteration: number;
  /** Total number of iterations completed. */
  totalIterations: number;
  /** Latest execution summary text (from most recent execution.md). */
  latestExecutionSummary: string;
  /** Latest evaluation status (COMPLETE / NEED_EXECUTE / unknown). */
  latestEvaluationStatus: string;
  /** Timestamp when running.lock was created. */
  startedAt: string;
  /** Timestamp of the most recent file modification in the task directory. */
  lastActivityAt: string;
  /** ISO timestamp of the last progress report sent. */
  lastReportAt: string | null;
  /** Whether a report should be sent (based on throttle). */
  shouldReport: boolean;
}

/** Configuration for ProgressReporter. */
export interface ProgressReporterConfig {
  /** Workspace root directory containing tasks/. */
  workspaceDir: string;
  /** Minimum interval between progress reports for the same task (ms). Default: 60000. */
  minReportIntervalMs?: number;
}

/**
 * Progress reporter — reads task state and formats progress cards.
 */
export class ProgressReporter {
  private readonly tasksDir: string;
  private readonly minReportIntervalMs: number;

  constructor(config: ProgressReporterConfig) {
    this.tasksDir = path.join(config.workspaceDir, 'tasks');
    this.minReportIntervalMs = config.minReportIntervalMs ?? 60_000;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Scan for running tasks and return their progress data.
   *
   * A task is "running" if it has a `running.lock` file but no `final_result.md`.
   */
  async getRunningTasks(): Promise<TaskProgress[]> {
    const entries = await this.safeReaddir(this.tasksDir);
    if (entries.length === 0) {return [];}

    const results: TaskProgress[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      const taskDir = path.join(this.tasksDir, entry.name);
      const taskId = entry.name;

      const isRunning = await this.fileExists(path.join(taskDir, 'running.lock'));
      const isCompleted = await this.fileExists(path.join(taskDir, 'final_result.md'));
      const isFailed = await this.fileExists(path.join(taskDir, 'failed.md'));

      if (!isRunning || isCompleted || isFailed) {continue;}

      const progress = await this.buildTaskProgress(taskId, taskDir);
      if (progress) {results.push(progress);}
    }

    return results;
  }

  /**
   * Build a Feishu progress card for a task.
   */
  buildProgressCard(progress: TaskProgress): FeishuCard {
    const elapsed = this.formatElapsed(progress.startedAt, progress.lastActivityAt);
    const statusIcon = this.getStatusIcon(progress.latestEvaluationStatus);

    const elements: Array<Record<string, unknown>> = [
      {
        tag: 'markdown',
        content: `**任务**: ${progress.title}`,
      },
      {
        tag: 'markdown',
        content: `**状态**: ${statusIcon} ${progress.latestEvaluationStatus || '执行中'}`,
      },
      {
        tag: 'markdown',
        content: `**迭代**: 第 ${progress.currentIteration} 轮（共 ${progress.totalIterations} 轮已完成）`,
      },
      {
        tag: 'markdown',
        content: `**已运行**: ${elapsed}`,
      },
    ];

    if (progress.latestExecutionSummary) {
      elements.push({ tag: 'hr' });
      // Truncate long summaries to avoid oversized cards
      const summary = progress.latestExecutionSummary.length > 300
        ? `${progress.latestExecutionSummary.substring(0, 300)  }...`
        : progress.latestExecutionSummary;
      elements.push({
        tag: 'markdown',
        content: `**最近执行**:\n${summary}`,
      });
    }

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '🔄 任务执行中' },
        template: 'blue',
      },
      elements,
    };
  }

  /**
   * Mark a progress report as sent for a task.
   *
   * Writes the current timestamp to `.last-progress-report` in the task directory.
   */
  async markReportSent(taskId: string): Promise<void> {
    const markerPath = path.join(this.tasksDir, taskId, '.last-progress-report');
    try {
      await fs.writeFile(markerPath, new Date().toISOString(), 'utf-8');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to write progress report marker');
    }
  }

  /**
   * Read the last progress report timestamp for a task.
   */
  async getLastReportTime(taskId: string): Promise<string | null> {
    const markerPath = path.join(this.tasksDir, taskId, '.last-progress-report');
    try {
      return await fs.readFile(markerPath, 'utf-8');
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async buildTaskProgress(taskId: string, taskDir: string): Promise<TaskProgress | null> {
    try {
      // Read task.md
      const taskMd = await this.readFile(path.join(taskDir, 'task.md'));
      if (!taskMd) {return null;}

      const title = this.extractTitle(taskMd);
      const chatId = this.extractChatId(taskMd);

      // Read iteration info
      const iterations = await this.listIterations(taskDir);
      const totalIterations = iterations.length;
      const currentIteration = totalIterations > 0 ? (iterations[iterations.length - 1] as number) : 0;

      // Read latest execution and evaluation
      let latestExecutionSummary = '';
      let latestEvaluationStatus = '';
      if (currentIteration > 0) {
        const execContent = await this.readFile(
          path.join(taskDir, 'iterations', `iter-${currentIteration}`, 'execution.md'),
        );
        latestExecutionSummary = execContent ? this.extractSummary(execContent) : '';

        const evalContent = await this.readFile(
          path.join(taskDir, 'iterations', `iter-${currentIteration}`, 'evaluation.md'),
        );
        latestEvaluationStatus = evalContent ? this.extractEvalStatus(evalContent) : '';
      }

      // Timestamps
      const lockStat = await fs.stat(path.join(taskDir, 'running.lock')).catch(() => null);
      const startedAt = lockStat?.mtime?.toISOString() ?? new Date().toISOString();

      const lastActivityAt = await this.getLastActivityTime(taskDir);

      // Throttle check
      const lastReportAt = await this.getLastReportTime(taskId);
      const shouldReport = this.checkShouldReport(lastReportAt);

      return {
        taskId,
        taskDir,
        title,
        chatId,
        currentIteration,
        totalIterations,
        latestExecutionSummary,
        latestEvaluationStatus,
        startedAt,
        lastActivityAt,
        lastReportAt,
        shouldReport,
      };
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to build task progress');
      return null;
    }
  }

  /**
   * Check if enough time has passed since the last report.
   */
  private checkShouldReport(lastReportAt: string | null): boolean {
    if (!lastReportAt) {return true;}
    try {
      const elapsed = Date.now() - new Date(lastReportAt).getTime();
      return elapsed >= this.minReportIntervalMs;
    } catch {
      return true;
    }
  }

  /**
   * Extract title from task.md.
   * Looks for first markdown heading or Title metadata field.
   */
  private extractTitle(taskMd: string): string {
    // Try "**Task ID**" style metadata first
    const metaTitleMatch = taskMd.match(/^#\s+Task:\s+(.+)$/m);
    if (metaTitleMatch?.[1]) {return metaTitleMatch[1].trim();}

    // Fallback to first heading
    const headingMatch = taskMd.match(/^#\s+(.+)$/m);
    if (headingMatch?.[1]) {return headingMatch[1].trim();}

    return 'Unknown Task';
  }

  /**
   * Extract chatId from task.md content.
   * Looks for `**Chat ID**: xxx` or `**Chat**: xxx` patterns.
   */
  private extractChatId(taskMd: string): string {
    const match = taskMd.match(/\*\*Chat(?:\s+ID)?\*\*:\s*(\S+)/i);
    return match?.[1] ?? '';
  }

  /**
   * Extract a short summary from execution.md content.
   * Returns the "Summary" section if present, otherwise the first 200 chars.
   */
  private extractSummary(execMd: string): string {
    // Try to find ## Summary section
    const summaryMatch = execMd.match(/##\s+Summary\s*\n([\s\S]*?)(?=\n##|\n---|\n\*\*|$)/i);
    if (summaryMatch && summaryMatch[1]) {
      return summaryMatch[1].trim();
    }
    // Fallback: first meaningful paragraph
    const lines = execMd.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('**'));
    return lines.slice(0, 3).join('\n').trim() || '';
  }

  /**
   * Extract evaluation status (COMPLETE / NEED_EXECUTE) from evaluation.md.
   */
  private extractEvalStatus(evalMd: string): string {
    const match = evalMd.match(/##\s+Status\s*\n\s*(COMPLETE|NEED_EXECUTE)/i);
    return match?.[1]?.toUpperCase() ?? '';
  }

  /**
   * List iteration directories and return sorted iteration numbers.
   */
  private async listIterations(taskDir: string): Promise<number[]> {
    const iterDir = path.join(taskDir, 'iterations');
    const entries = await this.safeReaddir(iterDir);
    if (entries.length === 0) {return [];}

    const iterations: number[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      const match = entry.name.match(/^iter-(\d+)$/);
      if (match?.[1]) {
        iterations.push(parseInt(match[1], 10));
      }
    }
    return iterations.sort((a, b) => a - b);
  }

  /**
   * Get the most recent file modification time in a task directory tree.
   */
  private async getLastActivityTime(taskDir: string): Promise<string> {
    try {
      const lockStat = await fs.stat(path.join(taskDir, 'running.lock'));
      return lockStat.mtime.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  /**
   * Format elapsed time between two ISO timestamps.
   */
  private formatElapsed(startIso: string, _endIso: string): string {
    try {
      const startMs = new Date(startIso).getTime();
      const elapsedMs = Date.now() - startMs;
      const minutes = Math.floor(elapsedMs / 60_000);
      const hours = Math.floor(minutes / 60);

      if (hours > 0) {
        return `${hours} 小时 ${minutes % 60} 分钟`;
      }
      return `${minutes} 分钟`;
    } catch {
      return '未知';
    }
  }

  /**
   * Get status icon for evaluation status.
   */
  private getStatusIcon(status: string): string {
    switch (status.toUpperCase()) {
      case 'COMPLETE': return '✅';
      case 'NEED_EXECUTE': return '🔄';
      default: return '⏳';
    }
  }

  // ---------------------------------------------------------------------------
  // Low-level helpers
  // ---------------------------------------------------------------------------

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async readFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  private async safeReaddir(dirPath: string): Promise<fsSync.Dirent[]> {
    try {
      return await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
  }
}
