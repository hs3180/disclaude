/**
 * Recommendation Store - Persist schedule recommendations.
 *
 * Stores recommendations as JSON files to track:
 * - Pending recommendations waiting for user response
 * - Accepted/rejected recommendations history
 * - Cooldown tracking to avoid spam
 *
 * Based on Issue #265: 智能定时任务推荐
 */

import { createLogger } from '../../utils/logger.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  ScheduleRecommendation,
  InteractionPattern,
  RecommendationStoreOptions,
  RecommendationConfig,
} from './types.js';

const logger = createLogger('RecommendationStore');

/**
 * Recommendation Store - Manages recommendation persistence.
 *
 * Usage:
 * ```typescript
 * const store = new RecommendationStore({ dataDir: './workspace/data' });
 *
 * // Create recommendation
 * const rec = await store.createRecommendation(pattern, chatId);
 *
 * // Get pending recommendations
 * const pending = await store.getPendingRecommendations(chatId);
 *
 * // Mark as accepted
 * await store.updateStatus(rec.id, 'accepted');
 * ```
 */
export class RecommendationStore {
  private dataDir: string;
  private recommendationsDir: string;

  constructor(options: RecommendationStoreOptions) {
    this.dataDir = options.dataDir;
    this.recommendationsDir = path.join(this.dataDir, 'recommendations');
    logger.info({ dataDir: this.dataDir }, 'RecommendationStore initialized');
  }

  /**
   * Initialize the store (create directories if needed).
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.recommendationsDir, { recursive: true });
      logger.info({ dir: this.recommendationsDir }, 'Created recommendations directory');
    } catch (error) {
      logger.error({ err: error }, 'Failed to create recommendations directory');
      throw error;
    }
  }

  /**
   * Create a new recommendation from a pattern.
   */
  async createRecommendation(
    pattern: InteractionPattern,
    config: RecommendationConfig
  ): Promise<ScheduleRecommendation> {
    await this.initialize();

    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.expirationHours * 60 * 60 * 1000);

    // Generate suggested task name
    const suggestedName = this.generateTaskName(pattern);

    const recommendation: ScheduleRecommendation = {
      id: `rec-${uuidv4().slice(0, 8)}`,
      chatId: pattern.chatId,
      userId: pattern.userId,
      patternId: pattern.id,
      schedule: {
        type: pattern.timePattern.type,
        time: pattern.timePattern.time,
        dayOfWeek: pattern.timePattern.dayOfWeek,
        cronExpression: pattern.timePattern.cronExpression,
      },
      task: {
        type: pattern.intent,
        prompt: pattern.promptTemplate,
        description: this.generateDescription(pattern),
        suggestedName,
      },
      reason: {
        occurrences: pattern.occurrences,
        timePattern: pattern.timePattern.description,
        confidence: pattern.confidence,
      },
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    // Save to file
    const filePath = this.getRecommendationPath(recommendation.id);
    await fs.writeFile(filePath, JSON.stringify(recommendation, null, 2));

    logger.info(
      { recId: recommendation.id, chatId: pattern.chatId, intent: pattern.intent },
      'Created recommendation'
    );

    return recommendation;
  }

  /**
   * Generate a task name from pattern.
   */
  private generateTaskName(pattern: InteractionPattern): string {
    const intentNames: Record<string, string> = {
      'code-summary': '代码变更总结',
      'weekly-report': '周报生成',
      'daily-standup': '日报',
      'status-check': '状态检查',
      'issue-check': 'Issue 检查',
      'pr-review': 'PR 审查',
      'test-run': '测试运行',
      'deployment': '部署检查',
    };

    const baseName = intentNames[pattern.intent] || '定时任务';
    return `${baseName} (${pattern.timePattern.description})`;
  }

  /**
   * Generate a description for the recommendation.
   */
  private generateDescription(pattern: InteractionPattern): string {
    const intentDescriptions: Record<string, string> = {
      'code-summary': '自动总结代码变更',
      'weekly-report': '自动生成周报',
      'daily-standup': '自动生成日报',
      'status-check': '自动检查服务状态',
      'issue-check': '自动检查 Issue 状态',
      'pr-review': '自动检查待审查 PR',
      'test-run': '自动运行测试',
      'deployment': '自动检查部署状态',
    };

    return intentDescriptions[pattern.intent] || `执行: ${pattern.promptTemplate.substring(0, 50)}...`;
  }

  /**
   * Get a recommendation by ID.
   */
  async getRecommendation(id: string): Promise<ScheduleRecommendation | null> {
    try {
      const filePath = this.getRecommendationPath(id);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as ScheduleRecommendation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get all pending recommendations for a chat.
   */
  async getPendingRecommendations(chatId: string): Promise<ScheduleRecommendation[]> {
    await this.initialize();

    const recommendations: ScheduleRecommendation[] = [];
    const files = await fs.readdir(this.recommendationsDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await fs.readFile(
          path.join(this.recommendationsDir, file),
          'utf-8'
        );
        const rec = JSON.parse(content) as ScheduleRecommendation;

        if (rec.chatId === chatId && rec.status === 'pending') {
          // Check if expired
          if (new Date(rec.expiresAt) < new Date()) {
            await this.updateStatus(rec.id, 'expired');
            continue;
          }
          recommendations.push(rec);
        }
      } catch (error) {
        logger.warn({ err: error, file }, 'Failed to read recommendation file');
      }
    }

    return recommendations;
  }

  /**
   * Update recommendation status.
   */
  async updateStatus(
    id: string,
    status: 'accepted' | 'rejected' | 'expired'
  ): Promise<ScheduleRecommendation | null> {
    const recommendation = await this.getRecommendation(id);
    if (!recommendation) {
      return null;
    }

    recommendation.status = status;
    recommendation.respondedAt = new Date().toISOString();

    const filePath = this.getRecommendationPath(id);
    await fs.writeFile(filePath, JSON.stringify(recommendation, null, 2));

    logger.info({ recId: id, status }, 'Updated recommendation status');
    return recommendation;
  }

  /**
   * Check if a pattern has been recently rejected (cooldown check).
   */
  async isPatternInCooldown(
    chatId: string,
    intent: string,
    cooldownDays: number
  ): Promise<boolean> {
    await this.initialize();

    const cooldownStart = new Date(
      Date.now() - cooldownDays * 24 * 60 * 60 * 1000
    );

    const files = await fs.readdir(this.recommendationsDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await fs.readFile(
          path.join(this.recommendationsDir, file),
          'utf-8'
        );
        const rec = JSON.parse(content) as ScheduleRecommendation;

        if (
          rec.chatId === chatId &&
          rec.task.type === intent &&
          rec.status === 'rejected' &&
          new Date(rec.respondedAt!) >= cooldownStart
        ) {
          return true;
        }
      } catch (error) {
        logger.warn({ err: error, file }, 'Failed to read recommendation file');
      }
    }

    return false;
  }

  /**
   * Clean up expired recommendations.
   */
  async cleanupExpired(): Promise<number> {
    await this.initialize();

    let cleanedCount = 0;
    const files = await fs.readdir(this.recommendationsDir);
    const now = new Date();

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await fs.readFile(
          path.join(this.recommendationsDir, file),
          'utf-8'
        );
        const rec = JSON.parse(content) as ScheduleRecommendation;

        if (rec.status === 'pending' && new Date(rec.expiresAt) < now) {
          await this.updateStatus(rec.id, 'expired');
          cleanedCount++;
        }
      } catch (error) {
        logger.warn({ err: error, file }, 'Failed to process recommendation file');
      }
    }

    logger.info({ cleanedCount }, 'Cleaned up expired recommendations');
    return cleanedCount;
  }

  /**
   * Get the file path for a recommendation.
   */
  private getRecommendationPath(id: string): string {
    return path.join(this.recommendationsDir, `${id}.json`);
  }

  /**
   * Get statistics about recommendations.
   */
  async getStats(): Promise<{
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
    expired: number;
  }> {
    await this.initialize();

    const stats = {
      total: 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
      expired: 0,
    };

    const files = await fs.readdir(this.recommendationsDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await fs.readFile(
          path.join(this.recommendationsDir, file),
          'utf-8'
        );
        const rec = JSON.parse(content) as ScheduleRecommendation;

        stats.total++;
        stats[rec.status]++;
      } catch (error) {
        logger.warn({ err: error, file }, 'Failed to read recommendation file');
      }
    }

    return stats;
  }
}
