/**
 * Task Complexity Types - Type definitions for task complexity assessment.
 *
 * Issue #857: Phase 1 - Task Complexity Assessment
 *
 * This module defines the types used for assessing task complexity,
 * which is used to determine when to auto-start Task Agent with ETA/progress.
 *
 * @module utils/task-complexity-types
 */

/**
 * Complexity score range (1-10).
 * - 1-3: Simple tasks (quick responses, simple queries)
 * - 4-6: Medium tasks (code changes, analysis)
 * - 7-10: Complex tasks (multi-file refactoring, long-running operations)
 */
export type ComplexityScore = number;

/**
 * Result of task complexity assessment.
 */
export interface TaskComplexity {
  /** Complexity score (1-10) */
  score: ComplexityScore;
  /** Estimated number of steps to complete */
  estimatedSteps: number;
  /** Estimated time in seconds */
  estimatedTimeSeconds: number;
  /** Reasoning for the complexity assessment */
  reasoning: string;
  /** Factors that contributed to the assessment */
  factors: ComplexityFactor[];
}

/**
 * A factor that contributes to complexity assessment.
 */
export interface ComplexityFactor {
  /** Factor name */
  name: string;
  /** Factor weight in the assessment */
  weight: number;
  /** Description of how this factor contributed */
  description: string;
}

/**
 * Input for complexity assessment.
 */
export interface ComplexityInput {
  /** User message text */
  text: string;
  /** Number of attachments */
  attachmentCount?: number;
  /** Whether the message has code blocks */
  hasCodeBlocks?: boolean;
  /** Whether the message mentions multiple files */
  mentionsMultipleFiles?: boolean;
  /** Chat history context length (if available) */
  chatHistoryLength?: number;
}

/**
 * Complexity level classification.
 */
export enum ComplexityLevel {
  /** Simple tasks - immediate response expected */
  SIMPLE = 'simple',
  /** Medium tasks - some processing time needed */
  MEDIUM = 'medium',
  /** Complex tasks - Task Agent should be considered */
  COMPLEX = 'complex',
}

/**
 * Thresholds for complexity classification.
 */
export interface ComplexityThresholds {
  /** Score threshold for simple tasks (below this is simple) */
  simpleThreshold: number;
  /** Score threshold for complex tasks (above this is complex) */
  complexThreshold: number;
  /** Minimum score */
  minScore: number;
  /** Maximum score */
  maxScore: number;
}

/**
 * Default complexity thresholds.
 */
export const DEFAULT_COMPLEXITY_THRESHOLDS: ComplexityThresholds = {
  simpleThreshold: 3,
  complexThreshold: 6,
  minScore: 1,
  maxScore: 10,
};

/**
 * Get complexity level from score.
 */
export function getComplexityLevel(
  score: number,
  thresholds: ComplexityThresholds = DEFAULT_COMPLEXITY_THRESHOLDS
): ComplexityLevel {
  if (score <= thresholds.simpleThreshold) {
    return ComplexityLevel.SIMPLE;
  }
  if (score >= thresholds.complexThreshold) {
    return ComplexityLevel.COMPLEX;
  }
  return ComplexityLevel.MEDIUM;
}

/**
 * Format complexity for display.
 */
export function formatComplexity(complexity: TaskComplexity): string {
  const level = getComplexityLevel(complexity.score);
  const levelEmoji = {
    [ComplexityLevel.SIMPLE]: '🟢',
    [ComplexityLevel.MEDIUM]: '🟡',
    [ComplexityLevel.COMPLEX]: '🔴',
  };

  const timeStr = complexity.estimatedTimeSeconds < 60
    ? `${complexity.estimatedTimeSeconds}秒`
    : `${Math.ceil(complexity.estimatedTimeSeconds / 60)}分钟`;

  return `${levelEmoji[level]} 复杂度: ${complexity.score}/10 (${level}) | 预估: ${timeStr} | 步骤: ${complexity.estimatedSteps}`;
}
