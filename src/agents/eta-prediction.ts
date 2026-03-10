/**
 * ETA Prediction Service - Predicts task completion time using Markdown-based rules.
 *
 * Issue #1234: Task ETA Estimation System
 *
 * Uses Markdown task records and rules to generate predictions with
 * transparent reasoning process.
 *
 * Key design principle: Non-structured Markdown storage, NOT structured data.
 *
 * @module agents/eta-prediction
 */

import { createLogger } from '../utils/logger.js';
import { etaTaskRecords, type TaskRecordEntry } from './eta-task-records.js';
import { etaRules } from './eta-rules.js';

const logger = createLogger('ETAPrediction');

/**
 * ETA prediction result with reasoning.
 */
export interface ETAPrediction {
  /** Estimated time in seconds */
  estimatedSeconds: number;
  /** Human-readable estimated time */
  estimatedTime: string;
  /** Confidence level: low, medium, high */
  confidence: 'low' | 'medium' | 'high';
  /** The reasoning process (transparent) */
  reasoning: string;
  /** Similar tasks found (for reference) */
  similarTasks: string[];
}

/**
 * Task context for prediction.
 */
export interface TaskContext {
  /** Task description */
  description: string;
  /** Task type classification */
  taskType: string;
  /** Key factors identified */
  keyFactors: string[];
  /** Additional context */
  additionalContext?: string;
}

/**
 * Baseline times for task types (in seconds).
 */
const BASELINE_TIMES: Record<string, number> = {
  'bugfix': 22 * 60,        // 15-30 minutes avg: 22 min
  'feature-small': 45 * 60, // 30-60 minutes avg: 45 min
  'feature-medium': 3 * 60 * 60, // 2-4 hours avg: 3 hours
  'feature-large': 6 * 60 * 60,  // 4-8 hours avg: 6 hours
  'refactoring': 2 * 60 * 60,    // varies, default 2 hours
  'documentation': 22 * 60,      // 15-30 minutes avg: 22 min
  'testing': 45 * 60,            // 30-60 minutes avg: 45 min
  'default': 30 * 60,            // default 30 minutes
};

/**
 * Multiplier rules based on key factors.
 */
const FACTOR_MULTIPLIERS: Record<string, number> = {
  '认证': 1.5,
  '安全': 1.5,
  '核心模块': 2.0,
  '参考代码': 0.7,
  '模板': 0.7,
  '第三方API': 1.5,
  '外部服务': 1.5,
  '数据库迁移': 1.3,
  '跨平台': 1.5,
  '多端': 1.5,
  '异步': 1.3,
  '状态管理': 1.3,
};

/**
 * ETA Prediction Service.
 *
 * Provides task time estimation with transparent reasoning.
 */
export class ETAPredictionService {
  /**
   * Predict task completion time.
   */
  async predict(context: TaskContext): Promise<ETAPrediction> {
    logger.info({ taskType: context.taskType }, 'Starting ETA prediction');

    // Get baseline time
    const baseline = this.getBaselineTime(context.taskType);

    // Calculate multiplier from key factors
    const multiplier = this.calculateMultiplier(context.keyFactors);

    // Search for similar tasks
    const keywords = this.extractKeywords(context);
    const similarTasks = await etaTaskRecords.searchSimilarTasks(keywords, 3);

    // Build reasoning
    const reasoning = this.buildReasoning(
      context,
      baseline,
      multiplier,
      similarTasks
    );

    // Calculate final estimate
    const estimatedSeconds = Math.round(baseline * multiplier);

    // Determine confidence
    const confidence = this.determineConfidence(similarTasks.length, context.keyFactors.length);

    return {
      estimatedSeconds,
      estimatedTime: this.formatTime(estimatedSeconds),
      confidence,
      reasoning,
      similarTasks,
    };
  }

  /**
   * Record a completed task for future predictions.
   */
  async recordTask(
    context: TaskContext,
    prediction: ETAPrediction,
    actualSeconds: number,
    review: string
  ): Promise<void> {
    const entry: TaskRecordEntry = {
      taskDescription: context.description,
      taskType: context.taskType,
      estimatedTime: prediction.estimatedTime,
      estimatedSeconds: prediction.estimatedSeconds,
      estimationReasoning: prediction.reasoning,
      actualTime: this.formatTime(actualSeconds),
      actualSeconds,
      review,
      keyFactors: context.keyFactors,
    };

    await etaTaskRecords.recordTask(entry);

    // Check if we need to update rules based on this task
    await this.maybeUpdateRules(prediction, actualSeconds);
  }

  /**
   * Get baseline time for task type.
   */
  private getBaselineTime(taskType: string): number {
    const normalizedType = taskType.toLowerCase().replace(/[-\s]/g, '');

    for (const [key, value] of Object.entries(BASELINE_TIMES)) {
      if (normalizedType.includes(key.toLowerCase()) || key.toLowerCase().includes(normalizedType)) {
        return value;
      }
    }

    return BASELINE_TIMES['default'];
  }

  /**
   * Calculate multiplier based on key factors.
   */
  private calculateMultiplier(keyFactors: string[]): number {
    let multiplier = 1.0;

    for (const factor of keyFactors) {
      for (const [pattern, mult] of Object.entries(FACTOR_MULTIPLIERS)) {
        if (factor.includes(pattern) || pattern.includes(factor)) {
          multiplier *= mult;
          break; // Only apply one multiplier per factor
        }
      }
    }

    // Cap multiplier at reasonable bounds
    return Math.max(0.5, Math.min(4.0, multiplier));
  }

  /**
   * Extract keywords from task context for similarity search.
   */
  private extractKeywords(context: TaskContext): string[] {
    const keywords: string[] = [];

    // Add task type
    keywords.push(context.taskType);

    // Add key factors
    keywords.push(...context.keyFactors);

    // Extract meaningful words from description
    const words = context.description.split(/[\s,，。.!！?？]+/);
    for (const word of words) {
      if (word.length >= 2 && !this.isStopWord(word)) {
        keywords.push(word);
      }
    }

    return [...new Set(keywords)]; // Remove duplicates
  }

  /**
   * Check if a word is a stop word.
   */
  private isStopWord(word: string): boolean {
    const stopWords = ['的', '是', '在', '和', '了', '有', '我', '你', '他', '她', '它',
                       'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
                       'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
                       'could', 'should', 'may', 'might', 'must', 'can', 'to', 'of',
                       'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as'];
    return stopWords.includes(word.toLowerCase());
  }

  /**
   * Build reasoning string for the prediction.
   */
  private buildReasoning(
    context: TaskContext,
    baseline: number,
    multiplier: number,
    similarTasks: string[]
  ): string {
    const lines: string[] = [];

    lines.push(`1. 任务类型: ${context.taskType}，基准时间 ${this.formatTime(baseline)}`);

    if (context.keyFactors.length > 0) {
      lines.push(`2. 关键因素: ${context.keyFactors.join(', ')}`);
      lines.push(`3. 应用乘数: ×${multiplier.toFixed(1)} → ${this.formatTime(baseline * multiplier)}`);
    }

    if (similarTasks.length > 0) {
      lines.push(`4. 找到 ${similarTasks.length} 个相似任务作为参考`);
    } else {
      lines.push(`4. 未找到相似任务，使用默认估计`);
    }

    lines.push(`5. 综合判断: ${this.formatTime(baseline * multiplier)}`);

    return lines.join('\n');
  }

  /**
   * Determine confidence level.
   */
  private determineConfidence(similarTasksCount: number, factorsCount: number): 'low' | 'medium' | 'high' {
    if (similarTasksCount >= 3 && factorsCount >= 2) {
      return 'high';
    }
    if (similarTasksCount >= 1 || factorsCount >= 1) {
      return 'medium';
    }
    return 'low';
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
   * Maybe update rules based on prediction accuracy.
   */
  private async maybeUpdateRules(prediction: ETAPrediction, actualSeconds: number): Promise<void> {
    const ratio = actualSeconds / prediction.estimatedSeconds;

    // Only update rules if there's significant deviation
    if (ratio < 0.6 || ratio > 1.6) {
      const deviation = ratio > 1 ? '低估' : '高估';
      const factor = ratio > 1 ? `${ratio.toFixed(1)}x` : `${(1/ratio).toFixed(1)}x`;

      logger.info({
        deviation,
        ratio,
        predicted: prediction.estimatedSeconds,
        actual: actualSeconds,
      }, 'Significant estimation deviation detected');

      // Note: In a full implementation, we would analyze the prediction
      // and update rules accordingly. For now, we just log it.
    }
  }

  /**
   * Generate a prediction card for display.
   */
  buildPredictionCard(prediction: ETAPrediction, taskDescription: string): Record<string, unknown> {
    const confidenceEmoji = {
      'high': '🎯',
      'medium': '📊',
      'low': '❓',
    }[prediction.confidence];

    const confidenceColor = {
      'high': 'green',
      'medium': 'blue',
      'low': 'grey',
    }[prediction.confidence];

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `${confidenceEmoji} ETA 预测` },
        template: confidenceColor,
      },
      elements: [
        { tag: 'markdown', content: `**任务**: ${taskDescription.slice(0, 100)}${taskDescription.length > 100 ? '...' : ''}` },
        { tag: 'markdown', content: `**预计时间**: ${prediction.estimatedTime}` },
        { tag: 'markdown', content: `**置信度**: ${confidenceEmoji} ${prediction.confidence}` },
        { tag: 'hr' },
        { tag: 'markdown', content: `**推理过程**:\n\`\`\`\n${prediction.reasoning}\n\`\`\`` },
      ],
    };
  }
}

/**
 * Global ETA prediction service instance.
 */
export const etaPredictionService = new ETAPredictionService();
