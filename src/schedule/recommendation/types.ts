/**
 * Types for schedule recommendation system.
 *
 * Based on Issue #265: 智能定时任务推荐
 * Analyzes user interaction patterns and recommends scheduled tasks.
 */

import type { ChatMessage } from '../../core/message-history.js';

/**
 * Time pattern types detected from user interactions.
 */
export type TimePatternType = 'daily' | 'weekly' | 'hourly' | 'cron';

/**
 * Detected time pattern from user interactions.
 */
export interface TimePattern {
  /** Type of time pattern */
  type: TimePatternType;
  /** Time of day (e.g., "09:00" for daily, null for hourly) */
  time?: string;
  /** Day of week (0-6, 0=Sunday) for weekly patterns */
  dayOfWeek?: number;
  /** Hour interval for hourly patterns */
  hourInterval?: number;
  /** Cron expression for complex patterns */
  cronExpression?: string;
  /** Human-readable description */
  description: string;
}

/**
 * User interaction pattern detected from analysis.
 */
export interface InteractionPattern {
  /** Unique pattern ID */
  id: string;
  /** Chat ID where pattern was detected */
  chatId: string;
  /** User ID who created the pattern */
  userId?: string;
  /** Intent/category of the task (e.g., "code-summary", "weekly-report") */
  intent: string;
  /** Original prompt template */
  promptTemplate: string;
  /** Number of occurrences */
  occurrences: number;
  /** Detected time pattern */
  timePattern: TimePattern;
  /** Confidence score (0-1) */
  confidence: number;
  /** Timestamps of occurrences */
  timestamps: number[];
  /** When this pattern was first detected */
  createdAt: string;
  /** When this pattern was last updated */
  updatedAt: string;
}

/**
 * Schedule recommendation for a user.
 */
export interface ScheduleRecommendation {
  /** Unique recommendation ID */
  id: string;
  /** Chat ID to send recommendation to */
  chatId: string;
  /** User ID to recommend to */
  userId?: string;
  /** Associated pattern ID */
  patternId: string;
  /** Recommended schedule configuration */
  schedule: {
    type: TimePatternType;
    time?: string;
    dayOfWeek?: number;
    cronExpression?: string;
  };
  /** Task information */
  task: {
    type: string;
    prompt: string;
    description: string;
    suggestedName: string;
  };
  /** Recommendation reason */
  reason: {
    occurrences: number;
    timePattern: string;
    confidence: number;
  };
  /** Recommendation status */
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  /** When recommendation was created */
  createdAt: string;
  /** When recommendation expires */
  expiresAt: string;
  /** When user responded (if applicable) */
  respondedAt?: string;
}

/**
 * Configuration for recommendation system.
 */
export interface RecommendationConfig {
  /** Enable recommendation system */
  enabled: boolean;
  /** Analysis interval in hours */
  analysisIntervalHours: number;
  /** Number of days to look back for analysis */
  lookbackDays: number;
  /** Minimum occurrences to consider a pattern */
  minOccurrences: number;
  /** Minimum confidence score to make recommendation */
  minConfidence: number;
  /** Maximum recommendations per analysis */
  maxRecommendations: number;
  /** Days to wait before re-recommending after rejection */
  cooldownDays: number;
  /** Hours until recommendation expires */
  expirationHours: number;
}

/**
 * Default configuration values.
 */
export const DEFAULT_RECOMMENDATION_CONFIG: RecommendationConfig = {
  enabled: true,
  analysisIntervalHours: 24,
  lookbackDays: 30,
  minOccurrences: 3,
  minConfidence: 0.7,
  maxRecommendations: 3,
  cooldownDays: 7,
  expirationHours: 48,
};

/**
 * Result of pattern analysis.
 */
export interface PatternAnalysisResult {
  /** Detected patterns */
  patterns: InteractionPattern[];
  /** Analysis timestamp */
  analyzedAt: string;
  /** Chat ID analyzed */
  chatId: string;
  /** Number of messages analyzed */
  messageCount: number;
  /** Time range of analyzed messages */
  timeRange: {
    start: string;
    end: string;
  };
}

/**
 * Intent classification for user messages.
 */
export interface IntentClassification {
  /** Intent category */
  intent: string;
  /** Confidence of classification */
  confidence: number;
  /** Keywords that matched */
  keywords: string[];
}

/**
 * Known intent patterns for classification.
 */
export const KNOWN_INTENTS: Record<string, string[]> = {
  'code-summary': ['代码变更', 'code change', 'commit', 'summary', '总结', '汇报'],
  'weekly-report': ['周报', 'weekly report', 'week', '本周', '上周'],
  'daily-standup': ['日报', 'daily', '每天', 'standup', '晨会'],
  'status-check': ['状态', 'status', '检查', 'check', '监控', 'monitor'],
  'issue-check': ['issue', '工单', '问题', 'bug'],
  'pr-review': ['pr', 'pull request', 'review', '审查', '合并'],
  'test-run': ['测试', 'test', '运行', 'run'],
  'deployment': ['部署', 'deploy', '发布', 'release'],
};

/**
 * Options for pattern analyzer.
 */
export interface PatternAnalyzerOptions {
  /** Message history manager */
  messageHistoryManager: import('../../core/message-history.js').IMessageHistoryManager;
  /** Configuration */
  config?: Partial<RecommendationConfig>;
}

/**
 * Options for recommendation store.
 */
export interface RecommendationStoreOptions {
  /** Directory for storing recommendations */
  dataDir: string;
}

/**
 * Options for recommendation engine.
 */
export interface RecommendationEngineOptions {
  /** Pattern analyzer */
  patternAnalyzer: import('./pattern-analyzer.js').PatternAnalyzer;
  /** Recommendation store */
  recommendationStore: import('./recommendation-store.js').RecommendationStore;
  /** Schedule manager for creating tasks */
  scheduleManager: import('../schedule-manager.js').ScheduleManager;
  /** Configuration */
  config?: Partial<RecommendationConfig>;
}
