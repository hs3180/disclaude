/**
 * ETA Predictor - Predicts task completion time based on historical data.
 *
 * Issue #1234: Task ETA Prediction System
 *
 * Provides ETA predictions based on:
 * - Historical task type statistics
 * - Similar task matching
 * - Default fallback values
 *
 * @module agents/eta-predictor
 */

import { createLogger } from '../utils/logger.js';
import { taskHistoryStorage, type TaskRecord, type TaskTypeStats } from './task-history.js';

const logger = createLogger('ETAPredictor');

/**
 * ETA prediction result.
 */
export interface ETAPrediction {
  /** Estimated completion time in seconds */
  estimatedSeconds: number;
  /** Confidence level 0-1 */
  confidence: number;
  /** What the prediction is based on */
  basedOn: 'historical' | 'similar_tasks' | 'default';
  /** Additional info about the prediction */
  details?: {
    /** Number of historical samples used */
    sampleCount?: number;
    /** Average duration of similar tasks */
    avgDuration?: number;
    /** Task type matched */
    taskType?: string;
  };
}

/**
 * Configuration for ETAPredictor.
 */
export interface ETAPredictorConfig {
  /** Default ETA when no historical data (seconds) */
  defaultETA: number;
  /** Minimum confidence when using historical data */
  minConfidence: number;
  /** Weight for task type matching */
  taskTypeWeight: number;
  /** Minimum samples needed for reliable prediction */
  minSamples: number;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: ETAPredictorConfig = {
  defaultETA: 120, // 2 minutes
  minConfidence: 0.3,
  taskTypeWeight: 0.7,
  minSamples: 3,
};

/**
 * ETA Predictor Service.
 *
 * Predicts task completion time based on historical execution data.
 *
 * @example
 * ```typescript
 * const predictor = new ETAPredictor();
 *
 * const prediction = await predictor.predictETA({
 *   taskType: 'refactoring',
 *   description: 'Refactor authentication module',
 * });
 *
 * console.log(`ETA: ${prediction.estimatedSeconds}s (confidence: ${prediction.confidence})`);
 * ```
 */
export class ETAPredictor {
  private readonly config: ETAPredictorConfig;

  constructor(config: Partial<ETAPredictorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Predict ETA for a task.
   *
   * @param params - Prediction parameters
   * @returns ETA prediction result
   */
  async predictETA(params: {
    taskType: string;
    description: string;
  }): Promise<ETAPrediction> {
    const { taskType, description } = params;

    logger.debug({ taskType }, 'Predicting ETA');

    try {
      // Try to get historical stats for task type
      const stats = await taskHistoryStorage.getTaskTypeStats(taskType);

      if (stats) {
        // Use historical data
        const prediction = this.predictFromStats(stats);
        logger.info({
          taskType,
          estimatedSeconds: prediction.estimatedSeconds,
          confidence: prediction.confidence,
          basedOn: prediction.basedOn,
        }, 'ETA predicted from historical data');
        return prediction;
      }

      // Try similar task matching
      const similarTasks = await this.findSimilarTasks(taskType, description);
      if (similarTasks.length >= this.config.minSamples) {
        const prediction = this.predictFromSimilarTasks(similarTasks, taskType);
        logger.info({
          taskType,
          estimatedSeconds: prediction.estimatedSeconds,
          confidence: prediction.confidence,
          basedOn: prediction.basedOn,
          sampleCount: similarTasks.length,
        }, 'ETA predicted from similar tasks');
        return prediction;
      }

      // Fall back to default
      const prediction = this.getDefaultPrediction(taskType);
      logger.info({
        taskType,
        estimatedSeconds: prediction.estimatedSeconds,
        basedOn: prediction.basedOn,
      }, 'Using default ETA (no historical data)');
      return prediction;

    } catch (error) {
      logger.error({ err: error, taskType }, 'ETA prediction failed, using default');
      return this.getDefaultPrediction(taskType);
    }
  }

  /**
   * Predict ETA from task type statistics.
   */
  private predictFromStats(stats: TaskTypeStats): ETAPrediction {
    // Calculate confidence based on sample count and estimation accuracy
    const sampleConfidence = Math.min(1, stats.sampleCount / 10); // Max at 10 samples
    const accuracyConfidence = 1 - Math.abs(1 - stats.avgErrorRatio);
    const confidence = (sampleConfidence + accuracyConfidence) / 2;

    return {
      estimatedSeconds: Math.round(stats.avgDuration),
      confidence: Math.max(this.config.minConfidence, confidence),
      basedOn: 'historical',
      details: {
        sampleCount: stats.sampleCount,
        avgDuration: stats.avgDuration,
        taskType: stats.taskType,
      },
    };
  }

  /**
   * Predict ETA from similar tasks.
   */
  private predictFromSimilarTasks(tasks: TaskRecord[], taskType: string): ETAPrediction {
    // Calculate average duration
    const totalDuration = tasks.reduce((sum, t) => sum + t.actualSeconds, 0);
    const avgDuration = totalDuration / tasks.length;

    // Calculate confidence based on sample count and variance
    const variance = this.calculateVariance(tasks.map(t => t.actualSeconds));
    const normalizedVariance = variance / (avgDuration * avgDuration);
    const sampleConfidence = Math.min(1, tasks.length / 5); // Max at 5 samples
    const varianceConfidence = Math.max(0, 1 - normalizedVariance);
    const confidence = (sampleConfidence * 0.5 + varianceConfidence * 0.5);

    return {
      estimatedSeconds: Math.round(avgDuration),
      confidence: Math.max(this.config.minConfidence, confidence),
      basedOn: 'similar_tasks',
      details: {
        sampleCount: tasks.length,
        avgDuration,
        taskType,
      },
    };
  }

  /**
   * Find similar tasks based on task type and description keywords.
   */
  private async findSimilarTasks(taskType: string, description: string): Promise<TaskRecord[]> {
    const allTasks = await taskHistoryStorage.getSimilarTasks(taskType, 20);

    if (allTasks.length === 0) {
      return [];
    }

    // Extract keywords from description
    const keywords = this.extractKeywords(description);

    // Score tasks by keyword similarity
    const scoredTasks = allTasks.map(task => {
      const taskKeywords = this.extractKeywords(task.userMessage);
      const score = this.calculateKeywordOverlap(keywords, taskKeywords);
      return { task, score };
    });

    // Sort by score and return top matches
    scoredTasks.sort((a, b) => b.score - a.score);

    // Return tasks with minimum score threshold
    const minScore = 0.3;
    return scoredTasks
      .filter(s => s.score >= minScore)
      .slice(0, 10)
      .map(s => s.task);
  }

  /**
   * Extract keywords from text.
   */
  private extractKeywords(text: string): Set<string> {
    // Remove common words and extract meaningful terms
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'to', 'of',
      'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
      '的', '是', '在', '有', '和', '了', '不', '这', '我', '他', '她',
      '它', '们', '要', '会', '能', '可', '以', '就', '也', '都', '还',
    ]);

    const words = text.toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s]/g, ' ') // Keep alphanumeric and Chinese
      .split(/\s+/)
      .filter(word => word.length > 1 && !stopWords.has(word));

    return new Set(words);
  }

  /**
   * Calculate keyword overlap score (Jaccard similarity).
   */
  private calculateKeywordOverlap(set1: Set<string>, set2: Set<string>): number {
    if (set1.size === 0 || set2.size === 0) {
      return 0;
    }

    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    return intersection.size / union.size;
  }

  /**
   * Calculate variance of numbers.
   */
  private calculateVariance(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    return numbers.reduce((sum, n) => sum + Math.pow(n - mean, 2), 0) / numbers.length;
  }

  /**
   * Get default prediction when no historical data available.
   */
  private getDefaultPrediction(taskType: string): ETAPrediction {
    // Provide task-type-specific defaults
    const defaults: Record<string, number> = {
      'refactoring': 300,    // 5 minutes
      'feature': 240,        // 4 minutes
      'bugfix': 180,         // 3 minutes
      'testing': 120,        // 2 minutes
      'documentation': 90,   // 1.5 minutes
      'explanation': 30,     // 30 seconds
      'read': 20,            // 20 seconds
      'general': 120,        // 2 minutes
    };

    const eta = defaults[taskType] ?? this.config.defaultETA;

    return {
      estimatedSeconds: eta,
      confidence: 0.2, // Low confidence for defaults
      basedOn: 'default',
      details: {
        taskType,
      },
    };
  }

  /**
   * Get prediction summary for display.
   */
  formatPrediction(prediction: ETAPrediction): string {
    const time = this.formatTime(prediction.estimatedSeconds);
    const confidence = `${Math.round(prediction.confidence * 100)}%`;
    const basedOn = {
      'historical': '历史数据',
      'similar_tasks': '相似任务',
      'default': '默认估计',
    }[prediction.basedOn];

    let details = '';
    if (prediction.details?.sampleCount) {
      details = ` (${prediction.details.sampleCount} 个样本)`;
    }

    return `预计 ${time}，置信度 ${confidence}，基于 ${basedOn}${details}`;
  }

  /**
   * Format time in human-readable format.
   */
  private formatTime(seconds: number): string {
    if (seconds < 60) {
      return `${Math.round(seconds)} 秒`;
    }
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (minutes < 60) {
      return secs > 0 ? `${minutes} 分 ${secs} 秒` : `${minutes} 分钟`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
  }
}

/**
 * Global ETA predictor instance.
 */
export const etaPredictor = new ETAPredictor();
