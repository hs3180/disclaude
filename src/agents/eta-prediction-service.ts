/**
 * ETA Prediction Service - Predicts task completion time using Markdown-based rules.
 *
 * Issue #1234: Task ETA Estimation System
 *
 * Key Design Principle: Uses Markdown-based rules and records instead of structured data.
 * This service:
 * - Reads estimation rules from eta-rules.md
 * - References historical task records from task-records.md
 * - Generates predictions with transparent reasoning process
 *
 * @module agents/eta-prediction-service
 */

import { createLogger } from '../utils/logger.js';
import { etaTaskRecords, type ETATaskRecord } from './eta-records.js';
import { etaRules, type TaskTypeBaseline, type ETAEstimationRule } from './eta-rules.js';

const logger = createLogger('ETAPrediction');

/**
 * ETA prediction result.
 */
export interface ETAPrediction {
  /** Estimated time in seconds */
  estimatedSeconds: number;
  /** Human-readable estimated time */
  estimatedTime: string;
  /** Confidence level (0-1) */
  confidence: number;
  /** What the prediction is based on */
  basedOn: 'historical' | 'similar_tasks' | 'rules' | 'default';
  /** Detailed reasoning process */
  reasoning: string[];
  /** References used for the prediction */
  references: string[];
}

/**
 * Task context for ETA prediction.
 */
export interface TaskContext {
  /** Task description/title */
  description: string;
  /** Task type classification */
  taskType: string;
  /** Keywords extracted from the task */
  keywords?: string[];
  /** Complexity score (1-10), optional */
  complexityScore?: number;
}

/**
 * ETA Prediction Service.
 *
 * Provides ETA predictions based on Markdown-stored rules and historical records.
 */
export class ETAPredictionService {
  /**
   * Predict ETA for a task.
   *
   * @param context - Task context for prediction
   * @returns ETA prediction with reasoning
   */
  async predict(context: TaskContext): Promise<ETAPrediction> {
    logger.info({ description: context.description.slice(0, 50), taskType: context.taskType }, 'Predicting ETA');

    const reasoning: string[] = [];
    const references: string[] = [];

    // Step 1: Find similar historical tasks
    const keywords = context.keywords || this.extractKeywords(context.description);
    const similarTasks = await etaTaskRecords.findSimilarTasks(keywords, 5);

    if (similarTasks.length >= 3) {
      // Use historical data if we have enough similar tasks
      const prediction = this.predictFromHistory(similarTasks, context);
      prediction.reasoning.forEach(r => reasoning.push(r));
      references.push(`task-records.md: ${similarTasks.length} similar tasks`);
      return {
        ...prediction,
        reasoning,
        references,
      };
    }

    // Step 2: Get baseline for task type
    const baseline = await etaRules.getBaselineForType(context.taskType);
    reasoning.push(`任务类型: ${context.taskType}${baseline ? `，基准时间 ${baseline.baselineTime}` : ''}`);

    // Step 3: Find applicable estimation rules
    const applicableRules = await etaRules.findApplicableRules(context.description);
    if (applicableRules.length > 0) {
      reasoning.push(`适用规则: ${applicableRules.map(r => r.condition).join(', ')}`);
      applicableRules.forEach(r => references.push(`eta-rules.md: "${r.condition}" 规则`));
    }

    // Step 4: Reference similar tasks if available
    if (similarTasks.length > 0) {
      reasoning.push(`参考相似任务: ${similarTasks.map(t => `"${t.title.slice(0, 20)}..."`).join(', ')}`);
      references.push(`task-records.md: ${similarTasks.length} 个相似任务`);
    }

    // Step 5: Calculate prediction
    const prediction = this.calculatePrediction(baseline, applicableRules, similarTasks, context);

    // Add final reasoning
    reasoning.push(`综合判断: ${prediction.estimatedTime}`);

    return {
      ...prediction,
      reasoning,
      references,
    };
  }

  /**
   * Predict from historical data.
   */
  private predictFromHistory(tasks: ETATaskRecord[], context: TaskContext): Omit<ETAPrediction, 'reasoning' | 'references'> {
    const reasoning: string[] = [];

    // Calculate average from successful tasks
    const successfulTasks = tasks.filter(t => t.success);
    const avgActual = successfulTasks.length > 0
      ? successfulTasks.reduce((sum, t) => sum + t.actualSeconds, 0) / successfulTasks.length
      : tasks.reduce((sum, t) => sum + t.actualSeconds, 0) / tasks.length;

    reasoning.push(`基于 ${tasks.length} 个相似历史任务`);
    reasoning.push(`历史平均时间: ${this.formatTime(avgActual)}`);

    // Calculate confidence based on sample size and variance
    const variance = tasks.reduce((sum, t) => sum + Math.pow(t.actualSeconds - avgActual, 2), 0) / tasks.length;
    const stdDev = Math.sqrt(variance);
    const confidence = Math.max(0.5, Math.min(0.95, 1 - (stdDev / avgActual) * 0.5));

    return {
      estimatedSeconds: Math.round(avgActual),
      estimatedTime: this.formatTime(avgActual),
      confidence,
      basedOn: 'historical',
    };
  }

  /**
   * Calculate prediction from rules and baselines.
   */
  private calculatePrediction(
    baseline: TaskTypeBaseline | undefined,
    rules: ETAEstimationRule[],
    similarTasks: ETATaskRecord[],
    context: TaskContext
  ): Omit<ETAPrediction, 'reasoning' | 'references'> {
    // Start with baseline or default
    let baseSeconds = baseline
      ? (baseline.minSeconds + baseline.maxSeconds) / 2
      : 1800; // Default 30 minutes

    // Apply rules
    let totalMultiplier = 1;
    for (const rule of rules) {
      totalMultiplier *= rule.multiplier;
    }

    // Apply complexity adjustment if provided
    if (context.complexityScore) {
      const complexityFactor = 0.5 + (context.complexityScore / 10) * 1; // 0.5 to 1.5
      totalMultiplier *= complexityFactor;
    }

    let estimatedSeconds = Math.round(baseSeconds * totalMultiplier);

    // Adjust based on similar tasks if available
    if (similarTasks.length > 0) {
      const avgSimilar = similarTasks.reduce((sum, t) => sum + t.actualSeconds, 0) / similarTasks.length;
      // Weight: 70% rules-based, 30% historical
      estimatedSeconds = Math.round(estimatedSeconds * 0.7 + avgSimilar * 0.3);
    }

    // Determine confidence
    let confidence = 0.5;
    if (baseline) confidence += 0.15;
    if (rules.length > 0) confidence += 0.1 * Math.min(rules.length, 3);
    if (similarTasks.length > 0) confidence += 0.05 * Math.min(similarTasks.length, 4);
    confidence = Math.min(0.9, confidence);

    // Determine basedOn
    let basedOn: ETAPrediction['basedOn'] = 'default';
    if (baseline || rules.length > 0) {
      basedOn = 'rules';
    }
    if (similarTasks.length > 0) {
      basedOn = 'similar_tasks';
    }

    return {
      estimatedSeconds,
      estimatedTime: this.formatTime(estimatedSeconds),
      confidence,
      basedOn,
    };
  }

  /**
   * Record a completed task for future predictions.
   */
  async recordTask(record: ETATaskRecord): Promise<void> {
    await etaTaskRecords.recordTask(record);
    logger.info({ title: record.title }, 'Recorded completed task for ETA learning');

    // Check if we should update rules based on significant estimation error
    const errorRatio = record.actualSeconds / Math.max(record.estimatedSeconds, 1);
    if (errorRatio > 1.5 || errorRatio < 0.5) {
      // Significant estimation error - consider adding a rule
      const lesson = record.review || `任务 "${record.title}" 估计偏差较大 (${errorRatio.toFixed(2)}x)`;
      await etaRules.recordLesson(record.date, lesson);
      logger.info({ errorRatio }, 'Recorded lesson due to significant estimation error');
    }
  }

  /**
   * Generate an experience report based on task records.
   */
  async generateExperienceReport(): Promise<string> {
    const recentTasks = await etaTaskRecords.getRecentTasks(20);
    const rules = await etaRules.getEstimationRules();
    const baselines = await etaRules.getTaskTypeBaselines();

    const lines: string[] = [
      '# ETA 预估经验报告',
      '',
      `生成时间: ${new Date().toISOString()}`,
      '',
      '## 统计概览',
      '',
      `- 历史任务数: ${recentTasks.length}`,
      `- 可用规则数: ${rules.length}`,
      `- 任务类型基准: ${baselines.length} 种`,
      '',
    ];

    if (recentTasks.length > 0) {
      const successful = recentTasks.filter(t => t.success);
      const avgError = successful.length > 0
        ? successful.reduce((sum, t) => sum + Math.abs(t.actualSeconds - t.estimatedSeconds), 0) / successful.length
        : 0;

      lines.push('### 估计准确度');
      lines.push('');
      lines.push(`- 成功率: ${((successful.length / recentTasks.length) * 100).toFixed(1)}%`);
      lines.push(`- 平均误差: ${this.formatTime(avgError)}`);
      lines.push('');

      // Analyze estimation patterns
      const underestimated = successful.filter(t => t.actualSeconds > t.estimatedSeconds * 1.2);
      const overestimated = successful.filter(t => t.actualSeconds < t.estimatedSeconds * 0.8);

      lines.push('### 偏差分析');
      lines.push('');
      lines.push(`- 低估任务: ${underestimated.length} 个 (${((underestimated.length / successful.length) * 100).toFixed(1)}%)`);
      lines.push(`- 高估任务: ${overestimated.length} 个 (${((overestimated.length / successful.length) * 100).toFixed(1)}%)`);
      lines.push('');

      // Suggest improvements
      if (underestimated.length > overestimated.length * 2) {
        lines.push('### 建议');
        lines.push('');
        lines.push('⚠️ 系统倾向于低估任务时间。建议：');
        lines.push('- 在估计时增加 20-30% 的缓冲时间');
        lines.push('- 考虑添加更多针对复杂场景的规则');
      }
    }

    return lines.join('\n');
  }

  /**
   * Extract keywords from task description.
   */
  private extractKeywords(description: string): string[] {
    // Simple keyword extraction - split by common delimiters and filter
    const words = description
      .toLowerCase()
      .split(/[\s,，.。!！?？;；:：""''「」【】()[\]（）]+/)
      .filter(w => w.length > 2);

    // Remove common stop words
    const stopWords = new Set(['的', '是', '在', '和', '了', '有', '我', '不', '这', '要', '会', '对']);
    return words.filter(w => !stopWords.has(w));
  }

  /**
   * Format seconds to human-readable time.
   */
  private formatTime(seconds: number): string {
    if (seconds < 60) {
      return `${Math.round(seconds)}秒`;
    }
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (minutes < 60) {
      return secs > 0 ? `${minutes}分钟${secs}秒` : `${minutes}分钟`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}小时${mins}分钟` : `${hours}小时`;
  }
}

/**
 * Global ETA prediction service instance.
 */
export const etaPredictionService = new ETAPredictionService();
