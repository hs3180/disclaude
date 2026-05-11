/**
 * ProgressReporter - Timer-based task progress reporting.
 *
 * Sends progress cards at regular intervals during task execution,
 * keeping users informed about long-running tasks.
 *
 * Issue #857: Task progress tracking for complex tasks.
 *
 * @module task/progress-reporter
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('ProgressReporter');

/**
 * Progress step definition.
 */
export interface ProgressStep {
  /** Step description */
  label: string;
  /** Whether this step is complete */
  done: boolean;
}

/**
 * Progress card structure (Feishu card format).
 */
export interface ProgressCard {
  config: { wide_screen_mode: boolean };
  header: {
    title: { tag: string; content: string };
    template: string;
  };
  elements: Array<{ tag: string; content: string }>;
}

/**
 * Progress reporter configuration.
 */
export interface ProgressReporterOptions {
  /** Callback to send progress card */
  sendCard: (card: ProgressCard) => Promise<void>;
  /** Interval in milliseconds between progress reports (default: 60000) */
  reportIntervalMs?: number;
}

/**
 * Task-level progress reporter.
 *
 * Provides timer-based progress reporting for long-running tasks.
 * Designed to be independent of the task orchestration layer,
 * making it easy to integrate with a future TaskFlowOrchestrator.
 *
 * Usage:
 * ```typescript
 * const reporter = new ProgressReporter({
 *   sendCard: async (card) => { await channel.sendCard(card); },
 * });
 *
 * reporter.start('my-task', ['Analyze code', 'Fix bug', 'Run tests']);
 * reporter.updateStep(1, 'Fixing auth.service.ts');
 * reporter.complete('All done');
 * ```
 */
export class ProgressReporter {
  private readonly sendCard: (card: ProgressCard) => Promise<void>;
  private readonly reportIntervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private taskId: string | null = null;
  private steps: ProgressStep[] = [];
  private currentStepIndex = -1;
  private currentStepDetail = '';
  private nextStepHint = '';
  private startTime = 0;
  private status: 'idle' | 'running' | 'completed' | 'error' = 'idle';

  constructor(options: ProgressReporterOptions) {
    this.sendCard = options.sendCard;
    this.reportIntervalMs = options.reportIntervalMs ?? 60_000;
  }

  /**
   * Start tracking progress for a task.
   *
   * @param taskId - Unique task identifier
   * @param stepLabels - Labels for each step in the task
   */
  start(taskId: string, stepLabels: string[]): void {
    this.stop(); // Clear any previous tracking

    this.taskId = taskId;
    this.steps = stepLabels.map(label => ({ label, done: false }));
    this.currentStepIndex = -1;
    this.currentStepDetail = '';
    this.nextStepHint = '';
    this.startTime = Date.now();
    this.status = 'running';

    logger.info({ taskId, steps: stepLabels.length }, 'Progress tracking started');

    // Start periodic reporting
    this.timer = setInterval(() => {
      this.sendProgressCard().catch(err => {
        logger.error({ err, taskId: this.taskId }, 'Failed to send periodic progress card');
      });
    }, this.reportIntervalMs);
  }

  /**
   * Update the current step being worked on.
   * Marks the previous step as done.
   *
   * @param stepIndex - 0-based step index
   * @param detail - Optional detail about what's happening in this step
   */
  updateStep(stepIndex: number, detail?: string): void {
    if (this.status !== 'running') {return;}

    // Mark previous step as done
    if (this.currentStepIndex >= 0 && this.currentStepIndex < this.steps.length) {
      this.steps[this.currentStepIndex].done = true;
    }

    this.currentStepIndex = stepIndex;
    this.currentStepDetail = detail ?? '';
    this.nextStepHint = '';

    logger.debug({ taskId: this.taskId, stepIndex, detail }, 'Progress step updated');
  }

  /**
   * Set a hint about what the next step will be.
   */
  setNextStepHint(hint: string): void {
    this.nextStepHint = hint;
  }

  /**
   * Immediately send a progress card (for milestone events).
   */
  async reportNow(): Promise<void> {
    await this.sendProgressCard();
  }

  /**
   * Mark progress as complete and send final card.
   *
   * @param summary - Summary of what was accomplished
   */
  async complete(summary: string): Promise<void> {
    if (this.status !== 'running') {return;}

    // Mark all remaining steps as done
    for (const step of this.steps) {
      step.done = true;
    }

    this.status = 'completed';
    this.stopTimer();

    const elapsed = this.formatElapsed(Date.now() - this.startTime);

    const card: ProgressCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '✅ 任务完成' },
        template: 'green',
      },
      elements: [
        { tag: 'markdown', content: `**用时**: ${elapsed}` },
        { tag: 'markdown', content: `**结果**: ${summary}` },
      ],
    };

    await this.sendCard(card);
    logger.info({ taskId: this.taskId, elapsed }, 'Progress tracking completed');
  }

  /**
   * Mark progress as failed and send error card.
   *
   * @param message - Error description
   */
  async error(message: string): Promise<void> {
    if (this.status !== 'running') {return;}

    this.status = 'error';
    this.stopTimer();

    const elapsed = this.formatElapsed(Date.now() - this.startTime);

    const card: ProgressCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '❌ 任务失败' },
        template: 'red',
      },
      elements: [
        { tag: 'markdown', content: `**用时**: ${elapsed}` },
        { tag: 'markdown', content: `**错误**: ${message}` },
      ],
    };

    await this.sendCard(card);
    logger.info({ taskId: this.taskId, elapsed, message }, 'Progress tracking ended with error');
  }

  /**
   * Stop tracking without sending a final card.
   */
  stop(): void {
    this.stopTimer();
    this.status = 'idle';
    this.taskId = null;
    this.steps = [];
    this.currentStepIndex = -1;
    this.currentStepDetail = '';
    this.nextStepHint = '';
  }

  /**
   * Get current progress state (for introspection).
   */
  getState(): {
    status: string;
    taskId: string | null;
    totalSteps: number;
    completedSteps: number;
    currentStep: string | null;
    elapsed: string;
  } {
    return {
      status: this.status,
      taskId: this.taskId,
      totalSteps: this.steps.length,
      completedSteps: this.steps.filter(s => s.done).length,
      currentStep: this.currentStepIndex >= 0 && this.currentStepIndex < this.steps.length
        ? this.steps[this.currentStepIndex].label
        : null,
      elapsed: this.startTime > 0 ? this.formatElapsed(Date.now() - this.startTime) : '0s',
    };
  }

  /**
   * Build and send an in-progress card.
   */
  private async sendProgressCard(): Promise<void> {
    if (this.status !== 'running') {return;}

    const completedCount = this.steps.filter(s => s.done).length;
    const total = this.steps.length;
    const elapsed = this.formatElapsed(Date.now() - this.startTime);

    const elements: Array<{ tag: string; content: string }> = [];

    // Current step
    if (this.currentStepIndex >= 0 && this.currentStepIndex < total) {
      const stepLabel = this.steps[this.currentStepIndex].label;
      const detail = this.currentStepDetail ? ` — ${this.currentStepDetail}` : '';
      elements.push({ tag: 'markdown', content: `**当前步骤**: ${stepLabel}${detail}` });
    }

    // Progress counter
    elements.push({ tag: 'markdown', content: `**已处理**: ${completedCount}/${total} 个步骤` });

    // Elapsed time
    elements.push({ tag: 'markdown', content: `**用时**: ${elapsed}` });

    // Next step hint
    if (this.nextStepHint) {
      elements.push({ tag: 'markdown', content: `_下一步: ${this.nextStepHint}_` });
    }

    const card: ProgressCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '🔄 任务执行中' },
        template: 'blue',
      },
      elements,
    };

    await this.sendCard(card);
  }

  /**
   * Stop the periodic timer.
   */
  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Format elapsed milliseconds as a human-readable string.
   */
  private formatElapsed(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {return `${seconds}s`;}
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {return `${minutes}m ${remainingSeconds}s`;}
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
}
