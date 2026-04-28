/**
 * Type definitions for the TasteManager module.
 *
 * Implements user taste (preference) persistence — automatically learned
 * user preferences that are injected into Agent prompts to avoid repeated
 * corrections.
 *
 * @see Issue #2335
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Categories
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Categories for taste rules.
 *
 * Each category maps to a different aspect of user preference.
 */
export type TasteCategory =
  | 'code_style'         // Code formatting and naming conventions
  | 'interaction'        // Communication style preferences
  | 'tech_preference'    // Technology and tool choices
  | 'project_convention' // Project-specific rules and conventions
  | 'general';           // Catch-all for other preferences

/**
 * All valid taste categories for iteration.
 */
export const TASTE_CATEGORIES: readonly TasteCategory[] = [
  'code_style',
  'interaction',
  'tech_preference',
  'project_convention',
  'general',
] as const;

/**
 * Human-readable labels for taste categories.
 */
export const TASTE_CATEGORY_LABELS: Record<TasteCategory, string> = {
  code_style: '代码风格',
  interaction: '交互偏好',
  tech_preference: '技术选择',
  project_convention: '项目规范',
  general: '通用偏好',
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Rule
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Source of a taste rule.
 *
 * - `auto`: Automatically detected from user corrections
 * - `manual`: Explicitly added by user via command
 * - `claude_md`: Extracted from project CLAUDE.md
 */
export type TasteSource = 'auto' | 'manual' | 'claude_md';

/**
 * A single taste rule representing a user preference.
 *
 * Taste rules are accumulated over time and injected into Agent context
 * to ensure the Agent respects the user's established preferences.
 */
export interface TasteRule {
  /** Unique identifier (auto-generated) */
  id: string;

  /** Category of this preference */
  category: TasteCategory;

  /** Human-readable description of the preference */
  content: string;

  /** How this rule was discovered */
  source: TasteSource;

  /** Number of times this correction was observed (for auto-detected rules) */
  count: number;

  /** ISO 8601 timestamp when the rule was first created */
  createdAt: string;

  /** ISO 8601 timestamp when the rule was last reinforced */
  lastSeen: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Schema for the taste persistence file.
 *
 * Stored in `{workspace}/.disclaude/taste.json`.
 * Uses the same write-then-rename atomic pattern as projects.json.
 */
export interface TastePersistData {
  /** Schema version for future migrations */
  version: 1;

  /** Array of taste rules */
  rules: TasteRule[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Manager Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a TasteManager instance.
 */
export interface TasteManagerOptions {
  /** Workspace root directory */
  workspaceDir: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Unified result type for TasteManager operations.
 *
 * Consistent with ProjectResult used in ProjectManager.
 */
export type TasteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
