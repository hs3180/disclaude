/**
 * Recommendation Engine - Generate and manage schedule recommendations.
 *
 * Orchestrates pattern analysis and recommendation creation.
 * Integrates with ScheduleManager for task creation.
 *
 * Based on Issue #265: 智能定时任务推荐
 */

import { createLogger } from '../../utils/logger.js';
import type { ScheduleManager } from '../schedule-manager.js';
import type { PatternAnalyzer } from './pattern-analyzer.js';
import type { RecommendationStore } from './recommendation-store.js';
import type {
  ScheduleRecommendation,
  InteractionPattern,
  RecommendationConfig,
  RecommendationEngineOptions,
  PatternAnalysisResult,
} from './types.js';
import { DEFAULT_RECOMMENDATION_CONFIG } from './types.js';

const logger = createLogger('RecommendationEngine');

/**
 * Result of running recommendation analysis.
 */
export interface RecommendationResult {
  /** Chat ID analyzed */
  chatId: string;
  /** New recommendations created */
  newRecommendations: ScheduleRecommendation[];
  /** Total pending recommendations (including existing) */
  totalPending: number;
  /** Patterns detected but skipped (cooldown, etc.) */
  skippedPatterns: Array<{ intent: string; reason: string }>;
  /** Analysis timestamp */
  analyzedAt: string;
}

/**
 * Feishu card action payload for recommendation responses.
 */
export interface RecommendationActionPayload {
  /** Recommendation ID */
  recId: string;
  /** Action taken by user */
  action: 'accept' | 'reject' | 'adjust';
  /** Chat ID */
  chatId: string;
  /** Optional adjusted schedule */
  adjustedSchedule?: {
    cron?: string;
    time?: string;
  };
}

/**
 * Recommendation Engine - Manages the recommendation workflow.
 *
 * Usage:
 * ```typescript
 * const engine = new RecommendationEngine({
 *   patternAnalyzer,
 *   recommendationStore,
 *   scheduleManager,
 * });
 *
 * // Analyze and generate recommendations
 * const result = await engine.analyzeAndRecommend('oc_xxx');
 *
 * // Handle user action
 * await engine.handleUserAction({ recId: 'rec-xxx', action: 'accept', chatId: 'oc_xxx' });
 * ```
 */
export class RecommendationEngine {
  private patternAnalyzer: PatternAnalyzer;
  private recommendationStore: RecommendationStore;
  private scheduleManager: ScheduleManager;
  private config: RecommendationConfig;

  constructor(options: RecommendationEngineOptions) {
    this.patternAnalyzer = options.patternAnalyzer;
    this.recommendationStore = options.recommendationStore;
    this.scheduleManager = options.scheduleManager;
    this.config = { ...DEFAULT_RECOMMENDATION_CONFIG, ...options.config };
    logger.info({ config: this.config }, 'RecommendationEngine initialized');
  }

  /**
   * Analyze chat patterns and generate recommendations.
   *
   * @param chatId - Chat ID to analyze
   * @returns Recommendation result
   */
  async analyzeAndRecommend(chatId: string): Promise<RecommendationResult> {
    logger.info({ chatId }, 'Starting recommendation analysis');

    // Analyze patterns
    const analysis = await this.patternAnalyzer.analyzeChatPatterns(chatId);

    const newRecommendations: ScheduleRecommendation[] = [];
    const skippedPatterns: Array<{ intent: string; reason: string }> = [];

    // Process each pattern
    for (const pattern of analysis.patterns) {
      // Check cooldown
      const inCooldown = await this.recommendationStore.isPatternInCooldown(
        chatId,
        pattern.intent,
        this.config.cooldownDays
      );

      if (inCooldown) {
        skippedPatterns.push({
          intent: pattern.intent,
          reason: 'Recently rejected (cooldown)',
        });
        continue;
      }

      // Check if similar task already exists
      const existingTask = await this.checkExistingTask(chatId, pattern);
      if (existingTask) {
        skippedPatterns.push({
          intent: pattern.intent,
          reason: 'Similar task already exists',
        });
        continue;
      }

      // Create recommendation
      const recommendation = await this.recommendationStore.createRecommendation(
        pattern,
        this.config
      );
      newRecommendations.push(recommendation);
    }

    // Get total pending
    const pendingRecs = await this.recommendationStore.getPendingRecommendations(chatId);

    const result: RecommendationResult = {
      chatId,
      newRecommendations,
      totalPending: pendingRecs.length,
      skippedPatterns,
      analyzedAt: analysis.analyzedAt,
    };

    logger.info(
      {
        chatId,
        newCount: newRecommendations.length,
        totalPending: pendingRecs.length,
        skippedCount: skippedPatterns.length,
      },
      'Recommendation analysis completed'
    );

    return result;
  }

  /**
   * Check if a similar task already exists.
   */
  private async checkExistingTask(
    chatId: string,
    pattern: InteractionPattern
  ): Promise<boolean> {
    const existingTasks = await this.scheduleManager.listByChatId(chatId);

    // Check if any existing task has similar prompt
    for (const task of existingTasks) {
      // Check for keyword overlap
      const taskKeywords = this.extractKeywords(task.prompt);
      const patternKeywords = this.extractKeywords(pattern.promptTemplate);

      const overlap = taskKeywords.filter(k => patternKeywords.includes(k));
      const similarity = overlap.length / Math.max(taskKeywords.length, patternKeywords.length, 1);

      if (similarity > 0.5) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract keywords from text.
   */
  private extractKeywords(text: string): string[] {
    // Simple keyword extraction
    const stopWords = new Set(['的', '了', '是', '在', '和', '与', '或', '有', '这', '那', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once']);

    return text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 1 && !stopWords.has(word));
  }

  /**
   * Handle user action on a recommendation.
   *
   * @param payload - Action payload from user
   * @returns Updated recommendation or null if not found
   */
  async handleUserAction(payload: RecommendationActionPayload): Promise<{
    recommendation: ScheduleRecommendation | null;
    createdTask?: { id: string; name: string };
  }> {
    const { recId, action, chatId, adjustedSchedule } = payload;

    logger.info({ recId, action, chatId }, 'Handling recommendation action');

    const recommendation = await this.recommendationStore.getRecommendation(recId);
    if (!recommendation) {
      logger.warn({ recId }, 'Recommendation not found');
      return { recommendation: null };
    }

    if (recommendation.chatId !== chatId) {
      logger.warn({ recId, chatId }, 'Chat ID mismatch');
      return { recommendation: null };
    }

    if (recommendation.status !== 'pending') {
      logger.warn({ recId, status: recommendation.status }, 'Recommendation not pending');
      return { recommendation };
    }

    switch (action) {
      case 'accept': {
        // Create the scheduled task
        const cron = adjustedSchedule?.cron || recommendation.schedule.cronExpression;
        if (!cron) {
          logger.error({ recId }, 'No cron expression available');
          return { recommendation };
        }

        const task = await this.scheduleManager.create({
          name: recommendation.task.suggestedName,
          cron,
          prompt: recommendation.task.prompt,
          chatId: recommendation.chatId,
          createdBy: recommendation.userId,
        });

        // Mark recommendation as accepted
        const updated = await this.recommendationStore.updateStatus(recId, 'accepted');

        logger.info({ recId, taskId: task.id }, 'Task created from recommendation');

        return {
          recommendation: updated,
          createdTask: { id: task.id, name: task.name },
        };
      }

      case 'reject': {
        const updated = await this.recommendationStore.updateStatus(recId, 'rejected');
        logger.info({ recId }, 'Recommendation rejected');
        return { recommendation: updated };
      }

      case 'adjust': {
        // For now, just keep it pending - in future could update the schedule
        logger.info({ recId, adjustedSchedule }, 'Recommendation adjustment requested');
        return { recommendation };
      }

      default:
        return { recommendation };
    }
  }

  /**
   * Get pending recommendations for a chat.
   */
  async getPendingRecommendations(chatId: string): Promise<ScheduleRecommendation[]> {
    return this.recommendationStore.getPendingRecommendations(chatId);
  }

  /**
   * Generate Feishu interactive card for a recommendation.
   */
  generateRecommendationCard(recommendation: ScheduleRecommendation): Record<string, unknown> {
    const scheduleText = this.formatScheduleText(recommendation);

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '💡 定时任务推荐' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'markdown',
          content: `**检测到您经常执行以下任务：**\n\n📝 **任务**：${recommendation.task.suggestedName}\n⏰ **建议时间**：${scheduleText}\n📊 **依据**：过去一段时间内您已手动执行此任务 ${recommendation.reason.occurrences} 次\n\n${recommendation.task.prompt.substring(0, 100)}...`,
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: `置信度: ${(recommendation.reason.confidence * 100).toFixed(0)}%`,
            },
          ],
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 创建' },
              type: 'primary',
              value: { recId: recommendation.id, action: 'accept' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '❌ 忽略' },
              type: 'default',
              value: { recId: recommendation.id, action: 'reject' },
            },
          ],
        },
      ],
    };
  }

  /**
   * Format schedule text for display.
   */
  private formatScheduleText(recommendation: ScheduleRecommendation): string {
    const { schedule } = recommendation;

    switch (schedule.type) {
      case 'daily':
        return `每天 ${schedule.time}`;
      case 'weekly': {
        const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        return `每${dayNames[schedule.dayOfWeek!]} ${schedule.time}`;
      }
      case 'hourly':
        return '按小时执行';
      default:
        return schedule.cronExpression || '自定义时间';
    }
  }

  /**
   * Clean up expired recommendations.
   */
  async cleanupExpired(): Promise<number> {
    return this.recommendationStore.cleanupExpired();
  }

  /**
   * Get store statistics.
   */
  async getStats(): Promise<{
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
    expired: number;
  }> {
    return this.recommendationStore.getStats();
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<RecommendationConfig>): void {
    this.config = { ...this.config, ...config };
    this.patternAnalyzer.updateConfig(this.config);
    logger.info({ config: this.config }, 'RecommendationEngine config updated');
  }

  /**
   * Check if recommendation system is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}
