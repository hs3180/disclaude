/**
 * Schedule Recommendation System
 *
 * Analyzes user interaction patterns and recommends scheduled tasks.
 * Based on Issue #265: 智能定时任务推荐
 *
 * @module schedule/recommendation
 */

// Core components
export { PatternAnalyzer } from './pattern-analyzer.js';
export { RecommendationStore } from './recommendation-store.js';
export { RecommendationEngine } from './recommendation-engine.js';

// Types
export {
  // Interfaces
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

  // Constants
  DEFAULT_RECOMMENDATION_CONFIG,
  KNOWN_INTENTS,

  // Type
  type TimePatternType,
} from './types.js';
