/**
 * ETA (Estimated Time of Arrival) System Types
 *
 * Defines types for the task time estimation system.
 * Based on Issue #1234 design principles:
 * - Non-structured Markdown storage
 * - Learning from historical tasks
 * - Transparent prediction with reasoning
 *
 * @module task/eta-types
 */

/**
 * Task type for ETA estimation.
 */
export type EtaTaskType =
  | 'bugfix'
  | 'feature-small'
  | 'feature-medium'
  | 'feature-large'
  | 'refactoring'
  | 'documentation'
  | 'testing'
  | 'integration'
  | 'research'
  | 'other';

/**
 * Task record for historical tracking.
 * Stored in .claude/task-records.md
 */
export interface EtaTaskRecord {
  /** Task title/description */
  title: string;
  /** Date of the task (YYYY-MM-DD) */
  date: string;
  /** Task type classification */
  type: EtaTaskType;
  /** Estimated time (minutes) */
  estimatedMinutes: number;
  /** Reasoning for the estimate */
  estimationBasis: string;
  /** Actual execution time (minutes) */
  actualMinutes: number;
  /** Post-completion review/lessons learned */
  review: string;
}

/**
 * Estimation rule for learning.
 * Stored in .claude/eta-rules.md
 */
export interface EtaRule {
  /** Rule name/title */
  name: string;
  /** Rule description */
  description: string;
  /** Multiplier for base time */
  multiplier: number;
  /** When this rule applies */
  condition: string;
  /** Source task that led to this rule */
  sourceTask?: string;
  /** Last updated date */
  updatedAt: string;
}

/**
 * Task type baseline timing.
 */
export interface EtaTaskBaseline {
  /** Task type */
  type: EtaTaskType;
  /** Base time range in minutes */
  baseTimeMinutes: [number, number];
  /** Notes about this baseline */
  notes: string;
}

/**
 * ETA prediction result.
 */
export interface EtaPrediction {
  /** Estimated time in minutes */
  estimatedMinutes: number;
  /** Confidence level: low, medium, high */
  confidence: 'low' | 'medium' | 'high';
  /** Reasoning process for the estimate */
  reasoning: string;
  /** Rules applied in the estimation */
  appliedRules: string[];
  /** Similar historical tasks referenced */
  referencedTasks: string[];
}

/**
 * Options for ETA tracker.
 */
export interface EtaTrackerOptions {
  /** Workspace directory for storing records */
  workspaceDir: string;
  /** Maximum number of historical records to keep */
  maxRecords?: number;
  /** Whether to auto-create files if missing */
  autoCreate?: boolean;
}

/**
 * Statistics about ETA accuracy.
 */
export interface EtaStats {
  /** Total number of recorded tasks */
  totalTasks: number;
  /** Average estimation error (percentage) */
  averageError: number;
  /** Tasks that were underestimated (percentage) */
  underestimatedRate: number;
  /** Tasks that were overestimated (percentage) */
  overestimatedRate: number;
  /** Most common task type */
  mostCommonType: EtaTaskType | null;
}
