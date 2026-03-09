/**
 * ETA Prediction Service - Predicts task completion time based on historical data.
 *
 * Issue #1234: Task ETA Estimation System
 *
 * Provides ETA predictions using:
 * - Historical task type statistics
 * - Similar task matching
 * - Fallback defaults for new task types
 *
 * @module agents/eta-prediction-service
 */

import { createLogger } from '../utils/logger.js';
import { taskHistoryStorage, type TaskRecord, type TaskTypeStats } from './task-history.js';

const logger = createLogger('ETAPrediction');

/**
 * ETA prediction result.
 */
export interface ETAPrediction {
  /** Estimated completion time in seconds */
  estimatedSeconds: number;
  /** Confidence level 0-1 */
  confidence: number;
  /** Source of the prediction */
  basedOn: 'historical' | 'similar_tasks' | 'default';
  /** Debug info about the prediction */
  debugInfo?: {
    sampleCount?: number;
    avgDuration?: number;
    matchedTasks?: number;
  };
}

/**
 * Prediction input parameters.
 */
export interface ETAPredictionInput {
  /** User message describing the task */
  userMessage: string;
  /** Task type (inferred or specified) */
  taskType: string;
  /** Optional complexity score (1-10) */
  complexityScore?: number;
}

/**
 * Summary report for a task type.
 */
export interface TaskTypeSummary {
  /** Task type name */
  taskType: string;
  /** Number of samples */
  sampleCount: number;
  /** Average duration in seconds */
  avgDuration: number;
  /** Min duration */
  minDuration: number;
  /** Max duration */
  maxDuration: number;
  /** Estimation accuracy (0-1) */
  accuracy: number;
  /** Common patterns identified */
  patterns: string[];
  /** Recommendations */
  recommendations: string[];
}

/**
 * ETA Prediction Service.
 *
 * Provides time estimates for tasks based on historical execution data.
 */
export class ETAPredictionService {
  private readonly storage: TaskHistoryStorage;

  /** Default ETA when no data available (in seconds) */
  private readonly DEFAULT_ETA = 120;

  constructor(storage?: TaskHistoryStorage) {
    this.storage = storage ?? taskHistoryStorage;
  }

  /** Default confidence when using fallback */
  private readonly DEFAULT_CONFIDENCE = 0.3;

  /** Minimum confidence for historical prediction */
  private readonly MIN_CONFIDENCE_FOR_HISTORICAL = 0.6;

  /** Weight for historical data vs similar tasks */
  private readonly HISTORICAL_WEIGHT = 0.7;

  /**
   * Predict ETA for a task.
   *
   * @param input - Prediction input parameters
   * @returns ETA prediction result
   */
  async predict(input: ETAPredictionInput): Promise<ETAPrediction> {
    const { userMessage, taskType, complexityScore } = input;

    logger.debug({ taskType, complexityScore }, 'Predicting ETA');

    try {
      // 1. Try historical stats first
      const historicalResult = await this.predictFromHistory(taskType);
      if (historicalResult && historicalResult.confidence >= this.MIN_CONFIDENCE_FOR_HISTORICAL) {
        logger.info({
          taskType,
          estimatedSeconds: historicalResult.estimatedSeconds,
          confidence: historicalResult.confidence,
          basedOn: 'historical',
        }, 'ETA predicted from historical data');

        return historicalResult;
      }

      // 2. Try similar task matching
      const similarResult = await this.predictFromSimilarTasks(taskType, userMessage);
      if (similarResult) {
        logger.info({
          taskType,
          estimatedSeconds: similarResult.estimatedSeconds,
          confidence: similarResult.confidence,
          basedOn: 'similar_tasks',
        }, 'ETA predicted from similar tasks');

        return similarResult;
      }

      // 3. Combine historical with similar if both available
      if (historicalResult && similarResult) {
        return this.combinePredictions(historicalResult, similarResult);
      }

      // 4. Fallback to default with complexity adjustment
      return this.getDefaultPrediction(complexityScore);
    } catch (error) {
      logger.error({ err: error, taskType }, 'ETA prediction failed, using default');
      return this.getDefaultPrediction(complexityScore);
    }
  }

  /**
   * Get summary report for a task type.
   *
   * @param taskType - Task type to summarize
   * @returns Summary report or undefined if not enough data
   */
  async getTaskTypeSummary(taskType: string): Promise<TaskTypeSummary | undefined> {
    const stats = await this.storage.getTaskTypeStats(taskType);
    const tasks = await this.storage.getSimilarTasks(taskType, 20);

    if (!stats && tasks.length === 0) {
      return undefined;
    }

    // Calculate additional stats
    const durations = tasks.map(t => t.actualSeconds);
    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);
    const accuracy = stats ? Math.max(0, 1 - Math.abs(1 - stats.avgErrorRatio)) : 0;

    // Identify patterns
    const patterns = this.identifyPatterns(tasks);

    // Generate recommendations
    const recommendations = this.generateRecommendations(stats, tasks);

    return {
      taskType,
      sampleCount: stats?.sampleCount ?? tasks.length,
      avgDuration: stats?.avgDuration ?? this.calculateAverage(durations),
      minDuration,
      maxDuration,
      accuracy,
      patterns,
      recommendations,
    };
  }

  /**
   * Get summary reports for all task types with sufficient data.
   *
   * @returns Map of task type to summary report
   */
  async getAllSummaries(): Promise<Map<string, TaskTypeSummary>> {
    const reliableTypes = await this.storage.getReliableTaskTypes();
    const summaries = new Map<string, TaskTypeSummary>();

    for (const taskType of reliableTypes) {
      const summary = await this.getTaskTypeSummary(taskType);
      if (summary) {
        summaries.set(taskType, summary);
      }
    }

    return summaries;
  }

  /**
   * Generate a comprehensive experience report.
   *
   * @returns Formatted experience report
   */
  async generateExperienceReport(): Promise<string> {
    const summaries = await this.getAllSummaries();

    if (summaries.size === 0) {
      return '# Task Execution Experience Report\n\nNo historical data available yet. Keep executing tasks to build up experience.';
    }

    const lines: string[] = [
      '# Task Execution Experience Report',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Summary Statistics',
      '',
    ];

    // Overall stats
    let totalTasks = 0;
    let totalAvgDuration = 0;

    for (const summary of summaries.values()) {
      totalTasks += summary.sampleCount;
      totalAvgDuration += summary.avgDuration;
    }

    lines.push(`- **Total Task Types**: ${summaries.size}`);
    lines.push(`- **Total Tasks Recorded**: ${totalTasks}`);
    lines.push(`- **Average Duration**: ${Math.round(totalAvgDuration / summaries.size)}s`);
    lines.push('');

    // Per-type details
    lines.push('## Task Type Details');
    lines.push('');

    for (const [taskType, summary] of summaries) {
      lines.push(`### ${taskType}`);
      lines.push('');
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Sample Count | ${summary.sampleCount} |`);
      lines.push(`| Average Duration | ${Math.round(summary.avgDuration)}s |`);
      lines.push(`| Min Duration | ${summary.minDuration}s |`);
      lines.push(`| Max Duration | ${summary.maxDuration}s |`);
      lines.push(`| Estimation Accuracy | ${Math.round(summary.accuracy * 100)}% |`);
      lines.push('');

      if (summary.patterns.length > 0) {
        lines.push('**Patterns**:');
        for (const pattern of summary.patterns) {
          lines.push(`- ${pattern}`);
        }
        lines.push('');
      }

      if (summary.recommendations.length > 0) {
        lines.push('**Recommendations**:');
        for (const rec of summary.recommendations) {
          lines.push(`- ${rec}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Predict ETA from historical statistics.
   */
  private async predictFromHistory(taskType: string): Promise<ETAPrediction | null> {
    const stats = await this.storage.getTaskTypeStats(taskType);

    if (!stats) {
      return null;
    }

    // Confidence based on sample count and estimation accuracy
    const sampleConfidence = Math.min(1, stats.sampleCount / 10);
    const accuracyConfidence = Math.max(0, 1 - Math.abs(1 - stats.avgErrorRatio));
    const confidence = sampleConfidence * 0.4 + accuracyConfidence * 0.6;

    return {
      estimatedSeconds: Math.round(stats.avgDuration),
      confidence,
      basedOn: 'historical',
      debugInfo: {
        sampleCount: stats.sampleCount,
        avgDuration: stats.avgDuration,
      },
    };
  }

  /**
   * Predict ETA from similar tasks using keyword matching.
   */
  private async predictFromSimilarTasks(
    taskType: string,
    userMessage: string,
  ): Promise<ETAPrediction | null> {
    const tasks = await this.storage.getSimilarTasks(taskType, 10);

    if (tasks.length === 0) {
      return null;
    }

    // Extract keywords from user message
    const keywords = this.extractKeywords(userMessage);

    // Score each task by keyword similarity
    const scoredTasks = tasks.map(task => ({
      task,
      score: this.calculateSimilarityScore(keywords, task.userMessage),
    }));

    // Sort by score and take top matches
    scoredTasks.sort((a, b) => b.score - a.score);
    const topMatches = scoredTasks.filter(t => t.score > 0.3).slice(0, 5);

    if (topMatches.length === 0) {
      // Use all tasks if no good matches
      const avgDuration = this.calculateAverage(tasks.map(t => t.actualSeconds));
      return {
        estimatedSeconds: Math.round(avgDuration),
        confidence: 0.4,
        basedOn: 'similar_tasks',
        debugInfo: {
          matchedTasks: tasks.length,
          avgDuration,
        },
      };
    }

    // Weighted average based on similarity score
    let totalWeight = 0;
    let weightedDuration = 0;

    for (const { task, score } of topMatches) {
      totalWeight += score;
      weightedDuration += task.actualSeconds * score;
    }

    const avgDuration = weightedDuration / totalWeight;
    const confidence = Math.min(0.7, 0.3 + (topMatches.length / 10) * 0.4);

    return {
      estimatedSeconds: Math.round(avgDuration),
      confidence,
      basedOn: 'similar_tasks',
      debugInfo: {
        matchedTasks: topMatches.length,
        avgDuration,
      },
    };
  }

  /**
   * Combine historical and similar task predictions.
   */
  private combinePredictions(
    historical: ETAPrediction,
    similar: ETAPrediction,
  ): ETAPrediction {
    const historicalWeight = this.HISTORICAL_WEIGHT * historical.confidence;
    const similarWeight = (1 - this.HISTORICAL_WEIGHT) * similar.confidence;
    const totalWeight = historicalWeight + similarWeight;

    const estimatedSeconds = Math.round(
      (historical.estimatedSeconds * historicalWeight +
        similar.estimatedSeconds * similarWeight) / totalWeight,
    );

    const confidence = (historical.confidence + similar.confidence) / 2;

    return {
      estimatedSeconds,
      confidence,
      basedOn: 'historical',
      debugInfo: {
        sampleCount: historical.debugInfo?.sampleCount,
        matchedTasks: similar.debugInfo?.matchedTasks,
        avgDuration: estimatedSeconds,
      },
    };
  }

  /**
   * Get default prediction based on complexity.
   */
  private getDefaultPrediction(complexityScore?: number): ETAPrediction {
    // Base estimate on complexity score
    const baseSeconds = complexityScore
      ? complexityScore * 30 // 30 seconds per complexity point
      : this.DEFAULT_ETA;

    return {
      estimatedSeconds: baseSeconds,
      confidence: this.DEFAULT_CONFIDENCE,
      basedOn: 'default',
    };
  }

  /**
   * Extract keywords from a message.
   */
  private extractKeywords(message: string): Set<string> {
    // Remove common words and punctuation
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
      'into', 'through', 'during', 'before', 'after', 'above', 'below',
      'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'why',
      'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
      'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so', 'than',
      'too', 'very', 'just', 'also', 'now', 'here', 'there', 'this', 'that',
    ]);

    const words = message.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));

    return new Set(words);
  }

  /**
   * Calculate similarity score between keywords and a message.
   */
  private calculateSimilarityScore(keywords: Set<string>, message: string): number {
    const messageWords = new Set(
      message.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/),
    );

    let matches = 0;
    for (const keyword of keywords) {
      if (messageWords.has(keyword)) {
        matches++;
      }
    }

    return keywords.size > 0 ? matches / keywords.size : 0;
  }

  /**
   * Calculate average of an array of numbers.
   */
  private calculateAverage(values: number[]): number {
    if (values.length === 0) {return 0;}
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /**
   * Identify patterns from task history.
   */
  private identifyPatterns(tasks: TaskRecord[]): string[] {
    const patterns: string[] = [];

    if (tasks.length < 3) {
      return patterns;
    }

    // Check for common key factors
    const factorCounts = new Map<string, number>();
    for (const task of tasks) {
      for (const factor of task.keyFactors) {
        factorCounts.set(factor, (factorCounts.get(factor) ?? 0) + 1);
      }
    }

    for (const [factor, count] of factorCounts) {
      if (count >= tasks.length * 0.5) {
        patterns.push(`Common factor: "${factor}" (${count}/${tasks.length} tasks)`);
      }
    }

    // Check for estimation patterns
    const avgEstimate = this.calculateAverage(tasks.map(t => t.estimatedSeconds));
    const avgActual = this.calculateAverage(tasks.map(t => t.actualSeconds));

    if (avgActual > avgEstimate * 1.3) {
      patterns.push('Tasks tend to take longer than estimated (30%+ over)');
    } else if (avgActual < avgEstimate * 0.7) {
      patterns.push('Tasks tend to complete faster than estimated');
    }

    // Check success rate
    const successRate = tasks.filter(t => t.success).length / tasks.length;
    if (successRate < 0.8) {
      patterns.push(`Success rate: ${Math.round(successRate * 100)}% (below 80%)`);
    }

    return patterns;
  }

  /**
   * Generate recommendations based on historical data.
   */
  private generateRecommendations(
    stats: TaskTypeStats | undefined,
    tasks: TaskRecord[],
  ): string[] {
    const recommendations: string[] = [];

    if (tasks.length < 5) {
      recommendations.push('Need more samples for reliable predictions (current: ' + tasks.length + ', target: 10+)');
    }

    if (stats) {
      // Estimation accuracy recommendations
      if (stats.avgErrorRatio > 1.3) {
        recommendations.push('Consider adding 30% buffer to time estimates');
      } else if (stats.avgErrorRatio < 0.7) {
        recommendations.push('Time estimates may be too conservative');
      }

      // Sample size recommendations
      if (stats.sampleCount < 10) {
        recommendations.push('Collect more samples to improve prediction accuracy');
      }
    }

    // Success rate recommendations
    const failedTasks = tasks.filter(t => !t.success);
    if (failedTasks.length > tasks.length * 0.2) {
      recommendations.push('High failure rate detected - review task execution process');
    }

    return recommendations;
  }
}

/**
 * Global ETA prediction service instance.
 */
export const etaPredictionService = new ETAPredictionService();
