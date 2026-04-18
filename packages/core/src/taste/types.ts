/**
 * Type definitions for the Taste module.
 *
 * Implements user preference auto-summarization to avoid repeated corrections.
 * Taste rules are detected from chat history and stored persistently.
 *
 * @see Issue #2335
 * @module taste/types
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Unified result type for Taste operations.
 *
 * Success: `{ ok: true, data: T }` — operation completed successfully.
 * Failure: `{ ok: false, error: string }` — validation or runtime error.
 */
export type TasteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Rule Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Category of a taste rule.
 *
 * - `code_style`: Code formatting and naming conventions
 * - `interaction`: Communication and interaction preferences
 * - `technical`: Technology stack and tool choices
 */
export type TasteCategory = 'code_style' | 'interaction' | 'technical';

/**
 * Source of a taste rule.
 *
 * - `auto`: Automatically detected from chat history
 * - `manual`: Manually added by user
 * - `claude_md`: Extracted from CLAUDE.md
 */
export type TasteSource = 'auto' | 'manual' | 'claude_md';

/**
 * A single taste rule representing a user preference.
 *
 * Rules are activated when `count >= 2` (detected at least twice).
 * Each rule records the source, frequency, and example messages.
 */
export interface TasteRule {
  /** The preference rule as a concise statement */
  rule: string;

  /** How this rule was discovered */
  source: TasteSource;

  /** Number of times this pattern was detected */
  count: number;

  /** ISO date string of most recent detection */
  last_seen: string;

  /** Example user messages that triggered this rule (max 3) */
  examples: string[];
}

/**
 * Complete taste profile for a user/project.
 *
 * Stored as `workspace/taste.yaml` and loaded on demand.
 */
export interface TasteProfile {
  /** ISO date string of last profile update */
  last_updated: string;

  /** Taste rules grouped by category */
  taste: Partial<Record<TasteCategory, TasteRule[]>>;
}

/**
 * Summary of a taste profile for display purposes.
 */
export interface TasteSummary {
  /** Total number of rules across all categories */
  totalRules: number;

  /** Number of rules per category */
  categoryCounts: Partial<Record<TasteCategory, number>>;

  /** Number of active rules (count >= 2) */
  activeRules: number;

  /** Date of last update */
  lastUpdated: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Detection Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * A detected correction pattern from chat history analysis.
 *
 * Represents a raw detection before it becomes a taste rule.
 */
export interface DetectedPattern {
  /** The generalized preference rule */
  rule: string;

  /** Suggested category */
  category: TasteCategory;

  /** Number of times detected */
  count: number;

  /** Example messages */
  examples: string[];

  /** Date of most recent occurrence */
  lastSeen: string;
}
