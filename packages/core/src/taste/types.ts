/**
 * Type definitions for the TasteManager module.
 *
 * Implements auto-summarized user taste (preferences) persistence,
 * allowing the Agent to learn from repeated user corrections.
 *
 * @see Issue #2335 (feat: auto-summarize user taste)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Unified result type for TasteManager operations.
 *
 * Success: `{ ok: true, data: T }`
 * Failure: `{ ok: false, error: string }`
 */
export type TasteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Rule Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Source of a taste rule — how it was created.
 */
export type TasteSource = 'auto' | 'manual' | 'claude_md';

/**
 * Category of a taste rule.
 *
 * Groups related preferences for organized display.
 */
export type TasteCategory = 'code_style' | 'interaction' | 'technical' | 'project_norms';

/**
 * A single taste rule representing a user preference.
 *
 * Taste rules are learned from:
 * - Auto-detection: When user corrects the agent repeatedly
 * - Manual entry: When user explicitly adds a rule
 * - CLAUDE.md: When preferences are extracted from project CLAUDE.md
 */
export interface TasteRule {
  /** Human-readable description of the preference */
  description: string;

  /** How this rule was created */
  source: TasteSource;

  /** Number of times user corrected this pattern (for auto-detected rules) */
  correctionCount?: number;

  /** ISO 8601 timestamp of last correction/update */
  lastSeen: string;

  /** ISO 8601 timestamp of first detection */
  createdAt: string;
}

/**
 * Complete taste data stored in taste.yaml.
 *
 * Organized by categories for easy browsing and management.
 */
export interface TasteData {
  /** Map of category → array of taste rules */
  taste: Partial<Record<TasteCategory, TasteRule[]>>;
}

/**
 * Flattened taste rule for display/list operations.
 */
export interface TasteRuleEntry {
  /** Category the rule belongs to */
  category: TasteCategory;
  /** The taste rule */
  rule: TasteRule;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Manager Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a TasteManager instance.
 */
export interface TasteManagerOptions {
  /** Workspace root directory (where .disclaude/ lives) */
  workspaceDir: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Category Display Names
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Human-readable category labels for display.
 */
export const CATEGORY_LABELS: Record<TasteCategory, string> = {
  code_style: '代码风格',
  interaction: '交互习惯',
  technical: '技术偏好',
  project_norms: '项目规范',
};

/**
 * All valid taste categories.
 */
export const TASTE_CATEGORIES: TasteCategory[] = [
  'code_style',
  'interaction',
  'technical',
  'project_norms',
];

/**
 * Valid taste sources.
 */
export const TASTE_SOURCES: TasteSource[] = ['auto', 'manual', 'claude_md'];
