/**
 * Task Progress Service - Manages complex task execution with progress reporting.
 *
 * Issue #857: Complex Task Auto-Start Task Agent
 *
 * This service provides:
 * - Progress tracking during task execution
 * - ETA updates based on elapsed time
 * - Progress card updates to keep user informed
 *
 * @module agents/task-progress-service
 */

import { createLogger } from '../utils/logger.js';
import type { TaskComplexityResult } from './task-complexity-agent.js';
import { taskHistoryStorage, type TaskRecord } from './task-history.js';

const logger = createLogger('TaskProgressService');

/**
 * Progress card configuration.
 */
export interface ProgressCardConfig {
  chatId: string;
  threadId?: string;
  taskDescription: string;
  estimatedSeconds: number;
  sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadId?: string) => Promise<void>;
  updateCard?: (cardId: string, card: Record<string, unknown>) => Promise<void>;
}

/**
 * Progress update data.
 */
export interface ProgressUpdate {
  /** Current progress percentage (0-100) */
  percentComplete: number;
  /** Current activity description */
  currentActivity: string;
  /** Elapsed time in seconds */
  elapsedSeconds: number;
  /** Remaining time estimate in seconds */
  remainingSeconds: number;
  /** Current step number */
  currentStep?: number;
  /** Total steps */
  totalSteps?: number;
}

/**
 * Task Progress Service.
 *
 * Manages progress tracking and reporting for complex tasks.
 */
export class TaskProgressService {
  private startTime: number = 0;
  private config: ProgressCardConfig;
  private cardMessageId?: string;
  private lastUpdateTime: number = 0;
  private updateCount: number = 0;
  private completed: boolean = false;

  /** Minimum interval between progress updates (ms) */
  private readonly MIN_UPDATE_INTERVAL = 30000; // 30 seconds

  /** Early update threshold - always update in first few seconds */
  private readonly EARLY_UPDATE_THRESHOLD = 10000; // 10 seconds

  constructor(config: ProgressCardConfig) {
    this.config = config;
  }

  /**
   * Start progress tracking - send initial progress card.
   */
  async start(complexity: TaskComplexityResult): Promise<void> {
    this.startTime = Date.now();
    this.completed = false;

    const card = this.buildProgressCard({
      percentComplete: 0,
      currentActivity: '正在启动任务...',
      elapsedSeconds: 0,
      remainingSeconds: complexity.estimatedSeconds,
      currentStep: 0,
      totalSteps: complexity.estimatedSteps,
    }, complexity);

    await this.config.sendCard(
      this.config.chatId,
      card,
      '任务已启动',
      this.config.threadId
    );

    logger.info({
      chatId: this.config.chatId,
      estimatedSeconds: complexity.estimatedSeconds,
      complexityScore: complexity.complexityScore,
    }, 'Progress tracking started');
  }

  /**
   * Update progress - send updated progress card if enough time has passed.
   */
  async update(activity: string, step?: number, totalSteps?: number): Promise<void> {
    if (this.completed) {
      return;
    }

    const now = Date.now();
    const elapsedMs = now - this.startTime;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);

    // Calculate progress percentage
    // Use logarithmic scale for better UX on long tasks
    const estimatedMs = this.config.estimatedSeconds * 1000;
    const linearProgress = (elapsedMs / estimatedMs) * 100;
    // Cap at 90% until task is actually complete
    const percentComplete = Math.min(90, Math.round(linearProgress));

    // Calculate remaining time
    const remainingSeconds = Math.max(
      0,
      Math.round(this.config.estimatedSeconds - elapsedSeconds)
    );

    const update: ProgressUpdate = {
      percentComplete,
      currentActivity: activity,
      elapsedSeconds,
      remainingSeconds,
      currentStep: step,
      totalSteps,
    };

    // Check if we should update
    const timeSinceLastUpdate = now - this.lastUpdateTime;
    const isFirstUpdate = this.updateCount === 0;

    // Always update if:
    // 1. First update
    // 2. In early phase (first 10 seconds)
    // 3. Enough time has passed since last update
    if (isFirstUpdate ||
        elapsedMs < this.EARLY_UPDATE_THRESHOLD ||
        timeSinceLastUpdate >= this.MIN_UPDATE_INTERVAL) {
      await this.sendUpdate(update);
      this.lastUpdateTime = now;
      this.updateCount++;
    }
  }

  /**
   * Complete progress tracking - send final completion card.
   */
  async complete(success: boolean, summary?: string): Promise<void> {
    this.completed = true;
    const elapsedMs = Date.now() - this.startTime;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);

    const card = this.buildCompletionCard(success, elapsedSeconds, summary);

    await this.config.sendCard(
      this.config.chatId,
      card,
      success ? '任务完成' : '任务失败',
      this.config.threadId
    );

    logger.info({
      chatId: this.config.chatId,
      success,
      elapsedSeconds,
      updateCount: this.updateCount,
    }, 'Progress tracking completed');
  }

  /**
   * Record task execution to history.
   */
  async recordToHistory(
    taskId: string,
    userMessage: string,
    complexity: TaskComplexityResult,
    success: boolean
  ): Promise<void> {
    const elapsedMs = Date.now() - this.startTime;
    const actualSeconds = Math.floor(elapsedMs / 1000);

    const record: TaskRecord = {
      taskId,
      chatId: this.config.chatId,
      userMessage,
      taskType: complexity.reasoning.taskType,
      complexityScore: complexity.complexityScore,
      estimatedSeconds: this.config.estimatedSeconds,
      actualSeconds,
      success,
      startedAt: this.startTime,
      completedAt: Date.now(),
      keyFactors: complexity.reasoning.keyFactors,
    };

    await taskHistoryStorage.recordTask(record);

    logger.info({
      chatId: this.config.chatId,
      taskId,
      taskType: record.taskType,
      estimatedSeconds: record.estimatedSeconds,
      actualSeconds: record.actualSeconds,
    }, 'Task execution recorded to history');
  }

  /**
   * Send a progress update card.
   */
  private async sendUpdate(update: ProgressUpdate): Promise<void> {
    const card = this.buildProgressCard(update);

    if (this.config.updateCard && this.cardMessageId) {
      // Update existing card if supported
      await this.config.updateCard(this.cardMessageId, card);
    } else {
      // Send new card
      await this.config.sendCard(
        this.config.chatId,
        card,
        `进度: ${update.percentComplete}%`,
        this.config.threadId
      );
    }

    logger.debug({
      chatId: this.config.chatId,
      percentComplete: update.percentComplete,
      currentActivity: update.currentActivity,
    }, 'Progress update sent');
  }

  /**
   * Build a progress card.
   */
  private buildProgressCard(
    update: ProgressUpdate,
    complexity?: TaskComplexityResult
  ): Record<string, unknown> {
    const progressBar = this.buildProgressBar(update.percentComplete);
    const timeInfo = this.formatTimeInfo(update);

    const elements: Record<string, unknown>[] = [
      {
        tag: 'markdown',
        content: `**任务**: ${this.config.taskDescription}`,
      },
      {
        tag: 'markdown',
        content: `**状态**: ${update.currentActivity}`,
      },
      {
        tag: 'markdown',
        content: `**进度**: ${update.percentComplete}% ${progressBar}`,
      },
    ];

    // Add step info if available
    if (update.currentStep !== undefined && update.totalSteps !== undefined) {
      elements.push({
        tag: 'markdown',
        content: `**步骤**: ${update.currentStep}/${update.totalSteps}`,
      });
    }

    // Add time info
    elements.push({
      tag: 'markdown',
      content: timeInfo,
    });

    // Add complexity info for initial card
    if (complexity) {
      elements.push({
        tag: 'markdown',
        content: `**复杂度**: ${this.formatComplexityLevel(complexity.complexityLevel)} (${complexity.complexityScore}/10)`,
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
   * Build a completion card.
   */
  private buildCompletionCard(
    success: boolean,
    elapsedSeconds: number,
    summary?: string
  ): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      {
        tag: 'markdown',
        content: `**任务**: ${this.config.taskDescription}`,
      },
      {
        tag: 'markdown',
        content: `**状态**: ${success ? '✅ 已完成' : '❌ 失败'}`,
      },
      {
        tag: 'markdown',
        content: `**耗时**: ${this.formatDuration(elapsedSeconds)}`,
      },
    ];

    if (summary) {
      elements.push({
        tag: 'markdown',
        content: `**摘要**: ${summary}`,
      });
    }

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: success ? '✅ 任务完成' : '❌ 任务失败' },
        template: success ? 'green' : 'red',
      },
      elements,
    };
  }

  /**
   * Build a text-based progress bar.
   */
  private buildProgressBar(percent: number): string {
    const filled = Math.floor(percent / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  /**
   * Format time information string.
   */
  private formatTimeInfo(update: ProgressUpdate): string {
    const parts: string[] = [];

    if (update.elapsedSeconds > 0) {
      parts.push(`已用时间: ${this.formatDuration(update.elapsedSeconds)}`);
    }

    if (update.remainingSeconds > 0) {
      parts.push(`预计剩余: ${this.formatDuration(update.remainingSeconds)}`);
    }

    return `**时间**: ${parts.join(' | ')}`;
  }

  /**
   * Format duration in human-readable format.
   */
  private formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}秒`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes < 60) {
      return remainingSeconds > 0
        ? `${minutes}分${remainingSeconds}秒`
        : `${minutes}分钟`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0
      ? `${hours}小时${remainingMinutes}分钟`
      : `${hours}小时`;
  }

  /**
   * Format complexity level for display.
   */
  private formatComplexityLevel(level: string): string {
    const levelMap: Record<string, string> = {
      trivial: '简单',
      low: '较低',
      medium: '中等',
      high: '复杂',
      critical: '非常复杂',
    };
    return levelMap[level] || level;
  }
}

/**
 * Create a TaskProgressService instance.
 */
export function createTaskProgressService(config: ProgressCardConfig): TaskProgressService {
  return new TaskProgressService(config);
}
