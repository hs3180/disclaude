/**
 * Type definitions for the schedule module.
 *
 * Includes types for:
 * - Background analysis configuration and results
 * - Pattern detection and storage
 *
 * @see Issue #357 - Intelligent Scheduled Task Recommendation System
 */

/**
 * Configuration for the background analyzer.
 */
export interface BackgroundAnalyzerConfig {
  /** Cron expression for analysis interval (default: "0 3 * * *" - daily at 3am) */
  analysisInterval: string;
  /** Number of days to look back for pattern detection (default: 30) */
  lookbackDays: number;
  /** Minimum number of occurrences to consider a pattern (default: 3) */
  minOccurrences: number;
  /** Minimum confidence threshold (0-1) for recommendations (default: 0.7) */
  minConfidence: number;
  /** Whether the background analyzer is enabled */
  enabled: boolean;
}

/**
 * Default configuration for the background analyzer.
 */
export const DEFAULT_BACKGROUND_ANALYZER_CONFIG: BackgroundAnalyzerConfig = {
  analysisInterval: '0 3 * * *',
  lookbackDays: 30,
  minOccurrences: 3,
  minConfidence: 0.7,
  enabled: false,
};

/**
 * A detected pattern from user interaction history.
 */
export interface DetectedPattern {
  /** Unique identifier for this pattern */
  id: string;
  /** Type of task detected (e.g., "report-generation", "status-check") */
  taskType: string;
  /** Number of times this pattern was detected */
  occurrences: number;
  /** Suggested cron expression for the schedule */
  suggestedSchedule: string;
  /** Human-readable schedule description */
  scheduleDescription: string;
  /** Confidence level (0-1) */
  confidence: number;
  /** Sample prompts that matched this pattern */
  samplePrompts: string[];
  /** Chat ID where the pattern was detected */
  chatId: string;
  /** Timestamp when the pattern was first detected */
  firstDetectedAt: string;
  /** Timestamp when the pattern was last updated */
  lastUpdated: string;
  /** Recommended prompt for the scheduled task */
  recommendedPrompt: string;
  /** Pattern status */
  status: PatternStatus;
}

/**
 * Status of a detected pattern.
 */
export type PatternStatus = 'pending' | 'confirmed' | 'rejected' | 'expired';

/**
 * Analysis result for a single chat.
 */
export interface ChatAnalysisResult {
  /** Chat ID that was analyzed */
  chatId: string;
  /** Patterns detected in this chat */
  patterns: DetectedPattern[];
  /** Timestamp when analysis was performed */
  analyzedAt: string;
  /** Number of messages analyzed */
  messageCount: number;
  /** Time range of analyzed messages */
  timeRange: {
    start: string;
    end: string;
  };
}

/**
 * Complete analysis result containing results from all chats.
 */
export interface AnalysisResult {
  /** All chat analysis results */
  chats: ChatAnalysisResult[];
  /** Timestamp when analysis was performed */
  analyzedAt: string;
  /** Configuration used for this analysis */
  config: BackgroundAnalyzerConfig;
  /** Summary statistics */
  summary: {
    totalChats: number;
    totalPatterns: number;
    highConfidencePatterns: number;
  };
}

/**
 * Message entry parsed from the message log.
 */
export interface ParsedMessageEntry {
  /** Message ID */
  messageId: string;
  /** Sender ID */
  senderId: string;
  /** Message timestamp */
  timestamp: Date;
  /** Message content */
  content: string;
  /** Message type */
  messageType: string;
  /** Direction (incoming/outgoing) */
  direction: 'incoming' | 'outgoing';
}

/**
 * Options for pattern store operations.
 */
export interface PatternStoreOptions {
  /** Directory for storing pattern data */
  dataDir: string;
}

/**
 * Options for background analyzer.
 */
export interface BackgroundAnalyzerOptions {
  /** Analyzer configuration */
  config: BackgroundAnalyzerConfig;
  /** Pattern store for persisting results */
  patternStore: PatternStore;
  /** Message logger for reading chat history */
  messageLogger: import('../feishu/message-logger.js').MessageLogger;
  /** Callback when patterns are detected */
  onPatternsDetected?: (result: ChatAnalysisResult) => Promise<void>;
}
