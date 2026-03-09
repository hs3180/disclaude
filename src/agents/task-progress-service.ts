/**
 * Task Progress Service - Manages progress tracking for complex tasks.
 *
 * Issue #857: Complex Task Auto-Start Task Agent with Progress Reporting
 *
 * This service provides:
 * - Progress card management with updates
 * - Task execution recording to history
 * - Progress updates at fixed intervals (60 seconds)
 *
 * Refactored: Removed TaskComplexityAgent dependency.
 * Progress tracking is now independent of complexity scoring.
 *
 * @module agents/task-progress-service
 */

import { createLogger } from '../utils/logger.js';
import { taskHistoryStorage, type TaskRecord } from './task-history.js';

const logger = createLogger('TaskProgressService');

/**
 * Progress update data.
 */
export interface ProgressUpdate {
  /** Current step description */
  currentStep: string;
  /** Optional percentage (0-100) */
  percent?: number;
  /** Optional message */
  message?: string;
}

/**
 * Progress card configuration.
 */
export interface ProgressCardConfig {
  chatId: string;
  messageId: string;
  userMessage: string;
  sendCard: (card: Record<string, unknown>) => Promise<void>;
}

/**
 * Task status for progress tracking.
 */
type TaskStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

/**
 * Active progress tracking state.
 */
interface ActiveProgress {
  taskId: string;
  chatId: string;
  messageId: string;
  userMessage: string;
  startTime: number;
  lastUpdateTime: number;
  currentPercent: number;
  currentStep: string;
  status: TaskStatus;
  updateInterval: ReturnType<typeof setInterval> | null;
  sendCard: (card: Record<string, unknown>) => Promise<void>;
}

/**
 * Task Progress Service.
 *
 * Manages progress cards and task execution recording.
 * Provides simple progress reporting at fixed intervals.
 */
export class TaskProgressService {
  private activeProgress: Map<string, ActiveProgress> = new Map();

  /** Fixed interval between progress updates (60 seconds) as per Issue #857 */
  private readonly UPDATE_INTERVAL_MS = 60000;

  /** Maximum progress before completion (capped at 90%) */
  private readonly MAX_PROGRESS_BEFORE_COMPLETE = 90;

  /**
   * Start tracking a task.
   *
   * @param config - Progress card configuration
   * @returns Task ID for tracking
   */
  async startTracking(config: ProgressCardConfig): Promise<string> {
    const { chatId, messageId, userMessage, sendCard } = config;

    // Generate unique task ID
    const taskId = `task-${chatId}-${Date.now()}`;

    logger.info({
      taskId,
      chatId,
      messageId,
    }, 'Starting progress tracking for task');

    // Send initial progress card
    const card = this.buildProgressCard({
      taskId,
      status: 'running',
      percent: 0,
      message: '任务已启动',
      currentStep: '正在分析任务...',
    });

    await sendCard(card);

    // Create progress tracking state
    const startTime = Date.now();
    const progress: ActiveProgress = {
      taskId,
      chatId,
      messageId,
      userMessage,
      startTime,
      lastUpdateTime: startTime,
      currentPercent: 0,
      currentStep: '正在分析任务...',
      status: 'running',
      sendCard,
      updateInterval: setInterval(
        () => this.updateProgress(taskId),
        this.UPDATE_INTERVAL_MS
      ),
    };

    this.activeProgress.set(chatId, progress);

    return taskId;
  }

  /**
   * Update progress for an active task.
   *
   * @param taskId - Task ID to update
   */
  private async updateProgress(taskId: string): Promise<void> {
    const progress = this.activeProgress.get(taskId);
    if (!progress) {
      logger.warn({ taskId }, 'No active progress found for update');
      return;
    }

    // Skip update if task is paused
    if (progress.status === 'paused') {
      logger.debug({ taskId }, 'Task is paused, skipping update');
      return;
    }

    // Skip if task is no longer running
    if (progress.status !== 'running') {
      return;
    }

    const elapsed = (Date.now() - progress.startTime) / 1000;

    // Increment progress slightly (simulated progress)
    // In real usage, progress should be updated via updateProgress()
    const newPercent = Math.min(
      this.MAX_PROGRESS_BEFORE_COMPLETE,
      progress.currentPercent + 5
    );

    // Only update if progress increased
    if (newPercent <= progress.currentPercent) {
      return;
    }

    progress.currentPercent = newPercent;
    progress.lastUpdateTime = Date.now();

    logger.debug({
      taskId,
      percent: newPercent,
      elapsed,
    }, 'Updating progress');

    // Send updated progress card
    const card = this.buildProgressCard({
      taskId,
      status: 'running',
      percent: newPercent,
      message: '任务执行中',
      currentStep: progress.currentStep,
    });

    await progress.sendCard(card);
  }

  /**
   * Manually update progress for a task.
   *
   * @param chatId - Chat ID
   * @param update - Progress update data
   */
  async updateProgressManually(chatId: string, update: ProgressUpdate): Promise<void> {
    const progress = this.activeProgress.get(chatId);
    if (!progress) {
      logger.debug({ chatId }, 'No active progress to update');
      return;
    }

    if (progress.status !== 'running') {
      logger.debug({ chatId, status: progress.status }, 'Task not running, skipping update');
      return;
    }

    progress.currentStep = update.currentStep;
    if (update.percent !== undefined) {
      progress.currentPercent = Math.min(
        this.MAX_PROGRESS_BEFORE_COMPLETE,
        Math.max(0, update.percent)
      );
    }
    progress.lastUpdateTime = Date.now();

    logger.debug({
      taskId: progress.taskId,
      percent: progress.currentPercent,
      step: update.currentStep,
    }, 'Manual progress update');

    // Send updated progress card
    const card = this.buildProgressCard({
      taskId: progress.taskId,
      status: 'running',
      percent: progress.currentPercent,
      message: update.message || '任务执行中',
      currentStep: progress.currentStep,
    });

    await progress.sendCard(card);
  }

  /**
   * Complete a tracked task.
   *
   * @param chatId - Chat ID to complete task for
   * @param success - Whether task completed successfully
   * @param summary - Optional task summary
   */
  async completeTask(chatId: string, success: boolean, summary?: string): Promise<void> {
    const progress = this.activeProgress.get(chatId);
    if (!progress) {
      logger.debug({ chatId }, 'No active progress to complete');
      return;
    }

    // Clear update interval
    if (progress.updateInterval) {
      clearInterval(progress.updateInterval);
    }

    const elapsed = (Date.now() - progress.startTime) / 1000;

    // Send completion card
    const card = this.buildProgressCard({
      taskId: progress.taskId,
      status: success ? 'completed' : 'failed',
      percent: 100,
      message: success ? '任务完成' : '任务失败',
      currentStep: summary || (success ? '所有步骤已完成' : '任务执行失败'),
    });

    await progress.sendCard(card);

    // Record to history
    const record: TaskRecord = {
      taskId: progress.taskId,
      chatId: progress.chatId,
      userMessage: progress.userMessage,
      taskType: 'general',
      complexityScore: 0, // No longer using complexity scoring
      estimatedSeconds: 0,
      actualSeconds: elapsed,
      success,
      startedAt: progress.startTime,
      completedAt: Date.now(),
      keyFactors: [],
    };

    await taskHistoryStorage.recordTask(record);

    logger.info({
      taskId: progress.taskId,
      success,
      elapsed,
    }, 'Task completed and recorded');

    // Remove from active tracking
    this.activeProgress.delete(chatId);
  }

  /**
   * Check if there's an active task for a chat.
   */
  hasActiveTask(chatId: string): boolean {
    return this.activeProgress.has(chatId);
  }

  /**
   * Get active task info for a chat.
   */
  getActiveTask(chatId: string): { taskId: string; percent: number; status: TaskStatus } | undefined {
    const progress = this.activeProgress.get(chatId);
    if (!progress) {
      return undefined;
    }
    return {
      taskId: progress.taskId,
      percent: progress.currentPercent,
      status: progress.status,
    };
  }

  /**
   * Pause a tracked task.
   *
   * @param chatId - Chat ID to pause task for
   * @returns true if task was paused, false if no task to pause
   */
  async pauseTask(chatId: string): Promise<boolean> {
    const progress = this.activeProgress.get(chatId);
    if (!progress) {
      logger.debug({ chatId }, 'No active progress to pause');
      return false;
    }

    if (progress.status !== 'running') {
      logger.warn({ chatId, status: progress.status }, 'Task is not running, cannot pause');
      return false;
    }

    // Update status
    progress.status = 'paused';
    progress.lastUpdateTime = Date.now();

    // Send paused card
    const card = this.buildProgressCard({
      taskId: progress.taskId,
      status: 'paused',
      percent: progress.currentPercent,
      message: '任务已暂停',
      currentStep: progress.currentStep,
    });

    await progress.sendCard(card);

    logger.info({ chatId, taskId: progress.taskId }, 'Task paused');
    return true;
  }

  /**
   * Resume a paused task.
   *
   * @param chatId - Chat ID to resume task for
   * @returns true if task was resumed, false if no task to resume
   */
  async resumeTask(chatId: string): Promise<boolean> {
    const progress = this.activeProgress.get(chatId);
    if (!progress) {
      logger.debug({ chatId }, 'No active progress to resume');
      return false;
    }

    if (progress.status !== 'paused') {
      logger.warn({ chatId, status: progress.status }, 'Task is not paused, cannot resume');
      return false;
    }

    // Update status
    progress.status = 'running';
    progress.lastUpdateTime = Date.now();

    // Send resumed card
    const card = this.buildProgressCard({
      taskId: progress.taskId,
      status: 'running',
      percent: progress.currentPercent,
      message: '任务已恢复',
      currentStep: progress.currentStep,
    });

    await progress.sendCard(card);

    logger.info({ chatId, taskId: progress.taskId }, 'Task resumed');
    return true;
  }

  /**
   * Cancel a tracked task.
   *
   * @param chatId - Chat ID to cancel task for
   * @returns true if task was cancelled, false if no task to cancel
   */
  async cancelTask(chatId: string): Promise<boolean> {
    const progress = this.activeProgress.get(chatId);
    if (!progress) {
      logger.debug({ chatId }, 'No active progress to cancel');
      return false;
    }

    if (!['running', 'paused'].includes(progress.status)) {
      logger.warn({ chatId, status: progress.status }, 'Task is not running or paused, cannot cancel');
      return false;
    }

    // Clear update interval
    if (progress.updateInterval) {
      clearInterval(progress.updateInterval);
    }

    const elapsed = (Date.now() - progress.startTime) / 1000;

    // Send cancelled card
    const card = this.buildProgressCard({
      taskId: progress.taskId,
      status: 'cancelled',
      percent: progress.currentPercent,
      message: '任务已取消',
      currentStep: '用户取消了任务',
    });

    await progress.sendCard(card);

    // Record to history as cancelled (success = false)
    const record: TaskRecord = {
      taskId: progress.taskId,
      chatId: progress.chatId,
      userMessage: progress.userMessage,
      taskType: 'general',
      complexityScore: 0,
      estimatedSeconds: 0,
      actualSeconds: elapsed,
      success: false,
      startedAt: progress.startTime,
      completedAt: Date.now(),
      keyFactors: ['Cancelled by user'],
    };

    await taskHistoryStorage.recordTask(record);

    logger.info({
      taskId: progress.taskId,
      elapsed,
    }, 'Task cancelled by user');

    // Remove from active tracking
    this.activeProgress.delete(chatId);

    return true;
  }

  /**
   * Build a progress card for Feishu.
   */
  private buildProgressCard(params: {
    taskId: string;
    status: TaskStatus;
    percent: number;
    message: string;
    currentStep: string;
  }): Record<string, unknown> {
    const { taskId, status, percent, message, currentStep } = params;

    const statusEmoji = {
      running: '🔄',
      paused: '⏸️',
      completed: '✅',
      failed: '❌',
      cancelled: '🚫',
    }[status];

    const headerColor = {
      running: 'blue',
      paused: 'orange',
      completed: 'green',
      failed: 'red',
      cancelled: 'grey',
    }[status];

    const progressBar = this.buildProgressBar(percent);

    const elements: Array<Record<string, unknown>> = [
      { tag: 'markdown', content: `**任务ID**: \`${taskId.slice(-8)}\`` },
      { tag: 'markdown', content: `**状态**: ${statusEmoji} ${message}` },
      { tag: 'markdown', content: `**进度**: ${progressBar} ${percent}%` },
      { tag: 'markdown', content: `**当前步骤**: ${currentStep}` },
    ];

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `${statusEmoji} 任务执行中` },
        template: headerColor,
      },
      elements,
    };
  }

  /**
   * Build a text progress bar.
   */
  private buildProgressBar(percent: number): string {
    const filled = Math.floor(percent / 5);
    const empty = 20 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }
}

/**
 * Global task progress service instance.
 */
export const taskProgressService = new TaskProgressService();
