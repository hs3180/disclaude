/**
 * Pattern Analyzer - Analyzes user interaction patterns.
 *
 * Detects recurring tasks and time patterns from user message history.
 * Based on Issue #265: 智能定时任务推荐
 */

import { createLogger } from '../../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import type { IMessageHistoryManager, ChatMessage } from '../../core/message-history.js';
import {
  type InteractionPattern,
  type TimePattern,
  type PatternAnalysisResult,
  type IntentClassification,
  type RecommendationConfig,
  type PatternAnalyzerOptions,
  DEFAULT_RECOMMENDATION_CONFIG,
  KNOWN_INTENTS,
} from './types.js';

const logger = createLogger('PatternAnalyzer');

/**
 * Pattern Analyzer - Analyzes user interactions to detect recurring patterns.
 *
 * Usage:
 * ```typescript
 * const analyzer = new PatternAnalyzer({
 *   messageHistoryManager,
 *   config: { minOccurrences: 3 }
 * });
 *
 * const result = await analyzer.analyzeChatPatterns('oc_xxx');
 * ```
 */
export class PatternAnalyzer {
  private messageHistoryManager: IMessageHistoryManager;
  private config: RecommendationConfig;

  constructor(options: PatternAnalyzerOptions) {
    this.messageHistoryManager = options.messageHistoryManager;
    this.config = { ...DEFAULT_RECOMMENDATION_CONFIG, ...options.config };
    logger.info({ config: this.config }, 'PatternAnalyzer initialized');
  }

  /**
   * Analyze patterns for a specific chat.
   *
   * @param chatId - Chat ID to analyze
   * @returns Analysis result with detected patterns
   */
  async analyzeChatPatterns(chatId: string): Promise<PatternAnalysisResult> {
    const messages = this.messageHistoryManager.getHistory(chatId);
    const userMessages = messages.filter(m => m.role === 'user');

    const now = new Date();
    const lookbackDate = new Date(now.getTime() - this.config.lookbackDays * 24 * 60 * 60 * 1000);

    // Filter messages within lookback period
    const recentMessages = userMessages.filter(m => m.timestamp >= lookbackDate.getTime());

    logger.info(
      { chatId, totalMessages: userMessages.length, recentMessages: recentMessages.length },
      'Analyzing chat patterns'
    );

    // Group messages by intent
    const intentGroups = this.groupByIntent(recentMessages);

    // Detect patterns in each group
    const patterns: InteractionPattern[] = [];

    for (const [intent, msgs] of intentGroups) {
      if (msgs.length < this.config.minOccurrences) {
        continue;
      }

      const timePattern = this.detectTimePattern(msgs);
      if (!timePattern) {
        continue;
      }

      const confidence = this.calculateConfidence(msgs, timePattern);
      if (confidence < this.config.minConfidence) {
        continue;
      }

      const pattern = this.createPattern(chatId, intent, msgs, timePattern, confidence);
      patterns.push(pattern);
    }

    // Sort by confidence and limit
    patterns.sort((a, b) => b.confidence - a.confidence);
    const limitedPatterns = patterns.slice(0, this.config.maxRecommendations);

    const result: PatternAnalysisResult = {
      patterns: limitedPatterns,
      analyzedAt: now.toISOString(),
      chatId,
      messageCount: recentMessages.length,
      timeRange: {
        start: lookbackDate.toISOString(),
        end: now.toISOString(),
      },
    };

    logger.info(
      { chatId, patternsFound: limitedPatterns.length },
      'Pattern analysis completed'
    );

    return result;
  }

  /**
   * Group messages by detected intent.
   */
  private groupByIntent(messages: ChatMessage[]): Map<string, ChatMessage[]> {
    const groups = new Map<string, ChatMessage[]>();

    for (const message of messages) {
      const classification = this.classifyIntent(message.content);
      if (classification.intent && classification.confidence > 0.5) {
        const existing = groups.get(classification.intent) || [];
        existing.push(message);
        groups.set(classification.intent, existing);
      }
    }

    return groups;
  }

  /**
   * Classify the intent of a message.
   */
  classifyIntent(content: string): IntentClassification {
    const lowerContent = content.toLowerCase();

    // Check known intents
    for (const [intent, keywords] of Object.entries(KNOWN_INTENTS)) {
      const matchedKeywords = keywords.filter(kw =>
        lowerContent.includes(kw.toLowerCase())
      );

      if (matchedKeywords.length > 0) {
        return {
          intent,
          confidence: Math.min(0.5 + matchedKeywords.length * 0.2, 1),
          keywords: matchedKeywords,
        };
      }
    }

    // Use content hash as generic intent for unrecognized patterns
    // Group similar messages by extracting key patterns
    const genericIntent = this.extractGenericIntent(content);
    return {
      intent: genericIntent,
      confidence: 0.5,
      keywords: [],
    };
  }

  /**
   * Extract a generic intent identifier from content.
   * Uses simple heuristics to group similar tasks.
   */
  private extractGenericIntent(content: string): string {
    // Extract key action words
    const actionPatterns = [
      /帮我(.{2,10})/i,
      /请(.{2,10})/i,
      /检查(.{2,10})/i,
      /总结(.{2,10})/i,
      /分析(.{2,10})/i,
      /生成(.{2,10})/i,
      /运行(.{2,10})/i,
    ];

    for (const pattern of actionPatterns) {
      const match = content.match(pattern);
      if (match) {
        // Create a normalized intent from the matched pattern
        return `custom-${match[1].substring(0, 20).replace(/\s+/g, '-')}`;
      }
    }

    // Fallback to hash of first 50 chars
    const hash = this.simpleHash(content.substring(0, 50));
    return `custom-${hash}`;
  }

  /**
   * Simple string hash function.
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).substring(0, 8);
  }

  /**
   * Detect time pattern from message timestamps.
   */
  private detectTimePattern(messages: ChatMessage[]): TimePattern | null {
    if (messages.length < this.config.minOccurrences) {
      return null;
    }

    const timestamps = messages.map(m => m.timestamp).sort((a, b) => a - b);

    // Check for daily pattern (same time each day)
    const dailyPattern = this.detectDailyPattern(timestamps);
    if (dailyPattern) {
      return dailyPattern;
    }

    // Check for weekly pattern (same day of week)
    const weeklyPattern = this.detectWeeklyPattern(timestamps);
    if (weeklyPattern) {
      return weeklyPattern;
    }

    // Check for hourly pattern (regular intervals)
    const hourlyPattern = this.detectHourlyPattern(timestamps);
    if (hourlyPattern) {
      return hourlyPattern;
    }

    return null;
  }

  /**
   * Detect daily pattern (same time each day).
   */
  private detectDailyPattern(timestamps: number[]): TimePattern | null {
    const hours: number[] = [];

    for (const ts of timestamps) {
      const date = new Date(ts);
      hours.push(date.getHours());
    }

    // Check if most occurrences are within the same hour
    const hourCounts = new Map<number, number>();
    for (const hour of hours) {
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
    }

    let maxHour = 0;
    let maxCount = 0;
    for (const [hour, count] of hourCounts) {
      if (count > maxCount) {
        maxCount = count;
        maxHour = hour;
      }
    }

    // At least 60% of occurrences should be in the same hour window
    if (maxCount >= timestamps.length * 0.6 && maxCount >= this.config.minOccurrences) {
      const timeStr = `${maxHour.toString().padStart(2, '0')}:00`;
      return {
        type: 'daily',
        time: timeStr,
        cronExpression: `0 ${maxHour} * * *`,
        description: `每天 ${timeStr}`,
      };
    }

    return null;
  }

  /**
   * Detect weekly pattern (same day of week).
   */
  private detectWeeklyPattern(timestamps: number[]): TimePattern | null {
    const dayOfWeek: number[] = [];
    const hours: number[] = [];

    for (const ts of timestamps) {
      const date = new Date(ts);
      dayOfWeek.push(date.getDay());
      hours.push(date.getHours());
    }

    // Check if most occurrences are on the same day of week
    const dayCounts = new Map<number, number>();
    for (const day of dayOfWeek) {
      dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
    }

    let maxDay = 0;
    let maxCount = 0;
    for (const [day, count] of dayCounts) {
      if (count > maxCount) {
        maxCount = count;
        maxDay = day;
      }
    }

    // At least 60% of occurrences should be on the same day
    if (maxCount >= timestamps.length * 0.6 && maxCount >= this.config.minOccurrences) {
      // Get the most common hour
      const hourCounts = new Map<number, number>();
      for (let i = 0; i < timestamps.length; i++) {
        if (dayOfWeek[i] === maxDay) {
          hourCounts.set(hours[i], (hourCounts.get(hours[i]) || 0) + 1);
        }
      }

      let maxHour = 12;
      let maxHourCount = 0;
      for (const [hour, count] of hourCounts) {
        if (count > maxHourCount) {
          maxHourCount = count;
          maxHour = hour;
        }
      }

      const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const timeStr = `${maxHour.toString().padStart(2, '0')}:00`;

      return {
        type: 'weekly',
        dayOfWeek: maxDay,
        time: timeStr,
        cronExpression: `0 ${maxHour} * * ${maxDay}`,
        description: `每${dayNames[maxDay]} ${timeStr}`,
      };
    }

    return null;
  }

  /**
   * Detect hourly pattern (regular intervals).
   */
  private detectHourlyPattern(timestamps: number[]): TimePattern | null {
    if (timestamps.length < this.config.minOccurrences) {
      return null;
    }

    // Calculate intervals between occurrences
    const intervals: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      const intervalHours = (timestamps[i] - timestamps[i - 1]) / (1000 * 60 * 60);
      intervals.push(intervalHours);
    }

    // Check for consistent intervals
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

    // Check if intervals are consistent (within 20% of average)
    const consistentIntervals = intervals.filter(
      i => Math.abs(i - avgInterval) < avgInterval * 0.2
    );

    if (consistentIntervals.length >= intervals.length * 0.7 && avgInterval >= 1 && avgInterval <= 24) {
      const roundedInterval = Math.round(avgInterval);
      return {
        type: 'hourly',
        hourInterval: roundedInterval,
        cronExpression: `0 */${roundedInterval} * * *`,
        description: `每 ${roundedInterval} 小时`,
      };
    }

    return null;
  }

  /**
   * Calculate confidence score for a pattern.
   */
  private calculateConfidence(messages: ChatMessage[], timePattern: TimePattern): number {
    let score = 0;

    // Base score from occurrence count
    const count = messages.length;
    if (count >= 10) {
      score += 0.4;
    } else if (count >= 5) {
      score += 0.3;
    } else if (count >= 3) {
      score += 0.2;
    }

    // Score from time consistency
    const timestamps = messages.map(m => m.timestamp);

    switch (timePattern.type) {
      case 'daily': {
        // Check hour consistency
        const hours = timestamps.map(t => new Date(t).getHours());
        const hourVariance = this.calculateVariance(hours);
        score += Math.max(0, 0.3 - hourVariance * 0.02);
        break;
      }
      case 'weekly': {
        // Check day of week consistency
        const days = timestamps.map(t => new Date(t).getDay());
        const dayVariance = this.calculateVariance(days);
        score += Math.max(0, 0.3 - dayVariance * 0.05);
        break;
      }
      case 'hourly': {
        // Check interval consistency
        const intervals: number[] = [];
        for (let i = 1; i < timestamps.length; i++) {
          intervals.push((timestamps[i] - timestamps[i - 1]) / (1000 * 60 * 60));
        }
        const intervalVariance = this.calculateVariance(intervals);
        score += Math.max(0, 0.3 - intervalVariance * 0.01);
        break;
      }
    }

    // Score from recency
    const lastMessage = Math.max(...timestamps);
    const daysSinceLastMessage = (Date.now() - lastMessage) / (1000 * 60 * 60 * 24);
    if (daysSinceLastMessage < 1) {
      score += 0.2;
    } else if (daysSinceLastMessage < 3) {
      score += 0.15;
    } else if (daysSinceLastMessage < 7) {
      score += 0.1;
    }

    return Math.min(score, 1);
  }

  /**
   * Calculate variance of an array of numbers.
   */
  private calculateVariance(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Create an InteractionPattern object.
   */
  private createPattern(
    chatId: string,
    intent: string,
    messages: ChatMessage[],
    timePattern: TimePattern,
    confidence: number
  ): InteractionPattern {
    const timestamps = messages.map(m => m.timestamp);
    const latestMessage = messages[messages.length - 1];

    // Create prompt template from the most recent message
    const promptTemplate = latestMessage.content;

    return {
      id: `pattern-${uuidv4().slice(0, 8)}`,
      chatId,
      userId: latestMessage.userId,
      intent,
      promptTemplate,
      occurrences: messages.length,
      timePattern,
      confidence,
      timestamps,
      createdAt: new Date(timestamps[0]).toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<RecommendationConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'PatternAnalyzer config updated');
  }
}
