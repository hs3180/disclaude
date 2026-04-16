/**
 * Type definitions for the TasteManager module.
 *
 * Implements the auto-taste detection system for user preference learning.
 * Taste rules are auto-detected from repeated corrections and persisted
 * as YAML in project directories.
 *
 * @see Issue #2335 — auto-summarize user taste to avoid repeated corrections
 * @see docs/proposals/unified-project-context.md (parent: #1916)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Category Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Taste rule categories for classification.
 *
 * Categories group related taste rules for display and filtering.
 * New categories can be added as needed without breaking existing data.
 */
export type TasteCategory =
  | 'code_style'
  | 'tech_choice'
  | 'interaction'
  | 'project_convention'
  | 'other';

/** Human-readable labels for each taste category (Chinese). */
export const TASTE_CATEGORY_LABELS: Record<TasteCategory, string> = {
  code_style: '代码风格',
  tech_choice: '技术选择',
  interaction: '交互习惯',
  project_convention: '项目规范',
  other: '其他',
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Source Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Origin of a taste rule — how it was created.
 *
 * - `auto`: Detected from repeated user corrections (AI-inferred)
 * - `manual`: Manually added by user via /taste add or direct editing
 * - `claude_md`: Extracted from project CLAUDE.md preference statements
 */
export type TasteSource = 'auto' | 'manual' | 'claude_md';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Rule
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * A single taste rule representing a user preference.
 *
 * Each rule captures:
 * - What the preference is (description)
 * - How often the user has corrected it (correctionCount)
 * - When it was last observed (lastSeenAt)
 * - Where it came from (source)
 *
 * Example:
 * ```yaml
 * - description: "使用 const/let，禁止 var"
 *   category: code_style
 *   source: auto
 *   correctionCount: 3
 *   lastSeenAt: "2026-04-14T10:30:00Z"
 *   createdAt: "2026-04-10T08:00:00Z"
 * ```
 */
export interface TasteRule {
  /** Human-readable description of the preference */
  description: string;

  /** Category for grouping and display */
  category: TasteCategory;

  /** Origin of this taste rule */
  source: TasteSource;

  /** Number of times user has corrected this (0 for manual/claude_md) */
  correctionCount: number;

  /** ISO 8601 timestamp of last correction/observation */
  lastSeenAt: string;

  /** ISO 8601 timestamp of when the rule was created */
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Full schema for the taste persistence file.
 *
 * Stored as YAML at `{projectDir}/taste.yaml`.
 * When no project context is active, falls back to `{workspaceDir}/.disclaude/taste.yaml`.
 *
 * Uses write-then-rename pattern for atomic persistence.
 */
export interface TasteData {
  /** Version of the taste data format (for future migrations) */
  version: number;

  /** All taste rules */
  rules: TasteRule[];
}

/** Current version of the taste data format. */
export const TASTE_VERSION = 1;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constructor Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a TasteManager instance.
 */
export interface TasteManagerOptions {
  /** Path to the taste.yaml file (absolute) */
  filePath: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Helper Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for adding a new taste rule.
 */
export interface AddTasteRuleOptions {
  /** Description of the preference */
  description: string;

  /** Category for grouping */
  category?: TasteCategory;

  /** Origin of the taste rule */
  source?: TasteSource;
}

/**
 * Options for recording a correction signal.
 */
export interface RecordCorrectionOptions {
  /** Description of the correction (must match existing rule) */
  description: string;

  /** Optional category hint for new rules */
  category?: TasteCategory;
}

/**
 * Options for listing taste rules.
 */
export interface ListTasteRulesOptions {
  /** Filter by category (undefined = all categories) */
  category?: TasteCategory;

  /** Filter by source (undefined = all sources) */
  source?: TasteSource;
}
