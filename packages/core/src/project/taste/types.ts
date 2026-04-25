/**
 * Type definitions for the TasteManager module.
 *
 * Implements the user taste (preference) auto-summarization system
 * per Issue #2335. Stores per-project user preferences that the agent
 * automatically learns and follows.
 *
 * @see Issue #2335 — auto-summarize user taste to avoid repeated corrections
 */

import type { ProjectResult } from '../types.js';

// Re-export ProjectResult for convenience
export type { ProjectResult };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Category Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Predefined taste categories for organizing preferences.
 *
 * Each category captures a distinct dimension of user preference:
 * - `code_style`: Code formatting and naming conventions
 * - `interaction`: Communication style and response format preferences
 * - `tech_stack`: Technology and tool preferences
 * - `project_norm`: Project-specific conventions and rules
 * - `custom`: User-defined categories
 */
export type TasteCategory =
  | 'code_style'
  | 'interaction'
  | 'tech_stack'
  | 'project_norm'
  | 'custom';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Source Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * How a taste rule was originated.
 *
 * - `auto`: Automatically detected from repeated user corrections
 * - `claude_md`: Extracted from the project's CLAUDE.md file
 * - `manual`: Explicitly set by the user via CLI/API
 */
export type TasteSource = 'auto' | 'claude_md' | 'manual';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Rule
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * A single taste rule — one user preference with provenance metadata.
 *
 * Each rule captures:
 * - What the preference is (rule text)
 * - Where it came from (source)
 * - How often the user had to correct the agent (correctionCount)
 * - When it was last observed (lastSeen)
 * - An optional custom category name (for `custom` category)
 */
export interface TasteRule {
  /** The preference rule text (e.g., "Use const/let, never var") */
  rule: string;

  /** Category for grouping */
  category: TasteCategory;

  /** How this rule was originated */
  source: TasteSource;

  /** Number of times the user corrected the agent on this topic */
  correctionCount: number;

  /** ISO 8601 timestamp of when this rule was last observed/reinforced */
  lastSeen: string;

  /** Optional custom category name (only used when category is 'custom') */
  customCategoryName?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Data (Persistence Schema)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Full taste data for a project instance.
 *
 * Persisted as `taste.yaml` in the project's working directory.
 *
 * Schema versioning ensures forward compatibility when the format evolves.
 * Version bumps follow semver-major for breaking changes.
 */
export interface TasteData {
  /** Schema version for forward compatibility */
  version: 1;

  /** All taste rules for this project */
  rules: TasteRule[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a TasteManager instance.
 *
 * @param projectDir - The project's working directory where taste.yaml is stored
 */
export interface TasteManagerOptions {
  /** Project working directory (taste.yaml stored here) */
  projectDir: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Query Filters
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Filter criteria for querying taste rules.
 *
 * All fields are optional — omitting a field means "no filter on that dimension".
 * Multiple fields are combined with AND logic.
 */
export interface TasteFilter {
  /** Filter by category */
  category?: TasteCategory;

  /** Filter by source */
  source?: TasteSource;

  /** Only include rules with correctionCount >= this value */
  minCorrections?: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AddRule Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for adding a new taste rule.
 */
export interface AddRuleOptions {
  /** The preference rule text */
  rule: string;

  /** Category for grouping */
  category: TasteCategory;

  /** Source of this rule */
  source: TasteSource;

  /** Optional custom category name (only used when category is 'custom') */
  customCategoryName?: string;

  /**
   * Whether to increment correctionCount if rule already exists (deduplication).
   * Default: true for auto source, false for manual/claude_md.
   */
  incrementIfExists?: boolean;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Exported Formatted Taste
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * A taste rule formatted for agent prompt injection.
 *
 * Includes a human-readable summary suitable for inclusion in system prompts.
 */
export interface FormattedTasteRule {
  /** The preference rule text */
  rule: string;

  /** Category label (e.g., "Code Style", "Interaction") */
  categoryLabel: string;

  /** Provenance description (e.g., "auto-detected, corrected 3 times") */
  provenance: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Category Labels
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Human-readable labels for taste categories.
 */
export const CATEGORY_LABELS: Record<TasteCategory, string> = {
  code_style: 'Code Style',
  interaction: 'Interaction',
  tech_stack: 'Tech Stack',
  project_norm: 'Project Norms',
  custom: 'Custom',
};

/**
 * Human-readable labels for taste sources.
 */
export const SOURCE_LABELS: Record<TasteSource, string> = {
  auto: 'auto-detected',
  claude_md: 'from CLAUDE.md',
  manual: 'user-specified',
};
