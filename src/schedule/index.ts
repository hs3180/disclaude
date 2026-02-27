/**
 * Schedule module - Scheduled task management.
 *
 * This module provides:
 * - ScheduleManager: CRUD operations for scheduled tasks
 * - Scheduler: Cron-based task execution
 * - ScheduleFileScanner: Scans and parses schedule markdown files
 * - ScheduleFileWatcher: Hot reload for schedule files
 * - Recommendation: Smart task recommendation based on user patterns
 *
 * @see Issue #3 - Scheduled task feature
 * @see Issue #79 - Refactor to file-based configuration
 * @see Issue #89 - Blocking mechanism for scheduled tasks
 * @see Issue #123 - Remove MCP dependency, use basic tools directly
 * @see Issue #265 - Smart schedule recommendation
 */

export { ScheduleManager, type ScheduledTask, type CreateScheduleOptions, type ScheduleManagerOptions } from './schedule-manager.js';
export { Scheduler, type SchedulerOptions, type FeedbackChannelContext } from './scheduler.js';
export { ScheduleFileScanner, type ScheduleFileTask, type ScheduleFileScannerOptions } from './schedule-file-scanner.js';
export { ScheduleFileWatcher, type OnFileAdded, type OnFileChanged, type OnFileRemoved, type ScheduleFileWatcherOptions } from './schedule-file-watcher.js';

// Recommendation subsystem
export {
  PatternAnalyzer,
  RecommendationStore,
  RecommendationEngine,
  type TimePattern,
  type InteractionPattern,
  type ScheduleRecommendation,
  type RecommendationConfig,
  type PatternAnalysisResult,
  type IntentClassification,
  type PatternAnalyzerOptions,
  type RecommendationStoreOptions,
  type RecommendationEngineOptions,
  type RecommendationResult,
  type RecommendationActionPayload,
  DEFAULT_RECOMMENDATION_CONFIG,
  KNOWN_INTENTS,
  type TimePatternType,
} from './recommendation/index.js';
