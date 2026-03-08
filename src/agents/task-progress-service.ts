/**
 * Task Progress Service - Manages progress tracking for complex tasks.
 *
 * Issue #857: Complex Task Auto-Start Task Agent
 *
 * This service provides:
 * - Progress card management with ETA updates
 * - Task execution recording to history
 * - Progress updates at appropriate intervals
 *
 * @module agents/task-progress-service
 */

import { createLogger } from '../utils/logger.js';
import { taskHistoryStorage, type TaskRecord } from './task-history.js';
import type { TaskComplexityResult } from './task-complexity-agent.js';

const logger = createLogger('TaskProgressService');

/**
 * Progress card configuration.
 */
export interface ProgressCardConfig {
  chatId: string;
  messageId: string;
  userMessage: string;
  complexity: TaskComplexityResult;
  sendCard: (card: Record<string, unknown>) => Promise<void>;
}

/**
 * Active progress tracking state.
 */
interface ActiveProgress {
  taskId: string;
  chatId: string;
  messageId: string;
  userMessage: string;
  complexity: TaskComplexityResult;
  startTime: number;
  lastUpdateTime: number;
  currentPercent: number;
  currentStep: string;
  cardMessageId?: string;
  updateInterval: ReturnType<typeof setInterval>;
  sendCard: (card: Record<string, unknown>) => Promise<void>;
}

/**
 * Task Progress Service.
 *
 * Manages progress cards and task execution recording.
 */
export class TaskProgressService {
  private activeProgress: Map<string, ActiveProgress> = new Map();

  /** Minimum interval between progress updates (30 seconds) */
  private readonly MIN_UPDATE_INTERVAL = 30000;

  /** Maximum progress before completion (capped at 90%) */
  private readonly MAX_PROGRESS_BEFORE_COMPLETE = 90;

  /**
   * Start tracking a complex task.
   *
   * @param config - Progress card configuration
   * @returns Task ID for tracking
   */
  async startTracking(config: ProgressCardConfig): Promise<string> {
    const { chatId, messageId, userMessage, complexity, sendCard } = config;

    // Generate unique task ID
    const taskId = `task-${chatId}-${Date.now()}`;

    logger.info({
      taskId,
      chatId,
      messageId,
      complexityScore: complexity.complexityScore,
      estimatedSeconds: complexity.estimatedSeconds,
    }, 'Starting progress tracking for complex task');

    // Send initial progress card
    const card = this.buildProgressCard({
      taskId,
      status: 'running',
      percent: 0,
      message: complexity.recommendation.message || '任务已启动',
      eta: complexity.estimatedSeconds,
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
      complexity,
      startTime,
      lastUpdateTime: startTime,
      currentPercent: 0,
      currentStep: '正在分析任务...',
      sendCard,
      updateInterval: setInterval(
        () => this.updateProgress(taskId),
        Math.max(this.MIN_UPDATE_INTERVAL, complexity.recommendation.reportingInterval * 1000)
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

    const elapsed = (Date.now() - progress.startTime) / 1000;
    const estimated = progress.complexity.estimatedSeconds;

    // Calculate progress percentage (capped at 90% until completion)
    const rawPercent = Math.min(
      this.MAX_PROGRESS_BEFORE_COMPLETE,
      Math.floor((elapsed / estimated) * 100)
    );

    // Only update if progress increased by at least 5%
    if (rawPercent <= progress.currentPercent + 5) {
      return;
    }

    progress.currentPercent = rawPercent;
    progress.lastUpdateTime = Date.now();

    // Determine current step based on progress
    const stepIndex = Math.floor(
      (rawPercent / 100) * progress.complexity.estimatedSteps
    );
    progress.currentStep = this.getStepDescription(stepIndex, progress.complexity);

    logger.debug({
      taskId,
      percent: rawPercent,
      elapsed,
      estimated,
    }, 'Updating progress');

    // Send updated progress card
    const card = this.buildProgressCard({
      taskId,
      status: 'running',
      percent: rawPercent,
      message: '任务执行中',
      eta: Math.max(0, estimated - elapsed),
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
    clearInterval(progress.updateInterval);

    const elapsed = (Date.now() - progress.startTime) / 1000;

    // Send completion card
    const card = this.buildProgressCard({
      taskId: progress.taskId,
      status: success ? 'completed' : 'failed',
      percent: 100,
      message: success ? '任务完成' : '任务失败',
      eta: 0,
      currentStep: summary || (success ? '所有步骤已完成' : '任务执行失败'),
    });

    await progress.sendCard(card);

    // Record to history
    const record: TaskRecord = {
      taskId: progress.taskId,
      chatId: progress.chatId,
      userMessage: progress.userMessage,
      taskType: progress.complexity.reasoning.taskType,
      complexityScore: progress.complexity.complexityScore,
      estimatedSeconds: progress.complexity.estimatedSeconds,
      actualSeconds: elapsed,
      success,
      startedAt: progress.startTime,
      completedAt: Date.now(),
      keyFactors: progress.complexity.reasoning.keyFactors,
    };

    await taskHistoryStorage.recordTask(record);

    logger.info({
      taskId: progress.taskId,
      success,
      elapsed,
      estimated: progress.complexity.estimatedSeconds,
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
  getActiveTask(chatId: string): { taskId: string; percent: number } | undefined {
    const progress = this.activeProgress.get(chatId);
    if (!progress) {
      return undefined;
    }
    return {
      taskId: progress.taskId,
      percent: progress.currentPercent,
    };
  }

  /**
   * Build a progress card for Feishu.
   */
  private buildProgressCard(params: {
    taskId: string;
    status: 'running' | 'completed' | 'failed';
    percent: number;
    message: string;
    eta: number;
    currentStep: string;
  }): Record<string, unknown> {
    const { taskId, status, percent, message, eta, currentStep } = params;

    const statusEmoji = {
      running: '🔄',
      completed: '✅',
      failed: '❌',
    }[status];

    const headerColor = {
      running: 'blue',
      completed: 'green',
      failed: 'red',
    }[status];

    const progressBar = this.buildProgressBar(percent);

    const elements: Array<Record<string, unknown>> = [
      { tag: 'markdown', content: `**任务ID**: \`${taskId.slice(-8)}\`` },
      { tag: 'markdown', content: `**状态**: ${statusEmoji} ${message}` },
      { tag: 'markdown', content: `**进度**: ${progressBar} ${percent}%` },
    ];

    if (status === 'running' && eta > 0) {
      elements.push({
        tag: 'markdown',
        content: `**预计剩余时间**: ${this.formatTime(eta)}`,
      });
    }

    elements.push({
      tag: 'markdown',
      content: `**当前步骤**: ${currentStep}`,
    });

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

  /**
   * Format time in human-readable format.
   */
  private formatTime(seconds: number): string {
    if (seconds < 60) {
      return `${Math.round(seconds)}秒`;
    }
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (minutes < 60) {
      return secs > 0 ? `${minutes}分${secs}秒` : `${minutes}分钟`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}小时${mins}分钟` : `${hours}小时`;
  }

  /**
   * Get step description based on progress.
   */
  private getStepDescription(stepIndex: number, complexity: TaskComplexityResult): string {
    const factors = complexity.reasoning.keyFactors;
    if (factors.length === 0) {
      return `步骤 ${stepIndex + 1}/${complexity.estimatedSteps}`;
    }
    return factors[stepIndex % factors.length] || `步骤 ${stepIndex + 1}/${complexity.estimatedSteps}`;
  }
}

/**
 * Global task progress service instance.
 */
export const taskProgressService = new TaskProgressService();
