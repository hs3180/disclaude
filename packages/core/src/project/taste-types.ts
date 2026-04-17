/**
 * Type definitions for the TasteManager module.
 *
 * Implements auto-summarized user taste (preferences) system —
 * persistent per-project rules learned from user corrections.
 *
 * @see Issue #2335 (feat: auto-summarize user taste)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type (re-exported from types.ts)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type { ProjectResult } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Categories
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Predefined categories for taste rules.
 *
 * Each category represents a different aspect of user preference.
 * Custom categories are also allowed via the `custom` category.
 */
export type TasteCategory =
  | 'code_style'      // Coding style preferences (e.g., const/let vs var, naming conventions)
  | 'interaction'     // Interaction style preferences (e.g., concise replies, language)
  | 'tech_choice'     // Technology choices (e.g., TypeScript over JavaScript, pnpm over npm)
  | 'project_norm'    // Project-specific norms (e.g., test directory, commit message language)
  | 'custom';         // User-defined custom category

/**
 * All allowed taste category values (for validation).
 */
export const TASTE_CATEGORIES: readonly string[] = [
  'code_style',
  'interaction',
  'tech_choice',
  'project_norm',
  'custom',
] as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Source
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * How a taste rule was detected.
 *
 * - `auto`: Automatically detected from repeated user corrections (≥2 occurrences)
 * - `manual`: Manually added by user via /taste command
 * - `claude_md`: Extracted from CLAUDE.md file content
 */
export type TasteSource = 'auto' | 'manual' | 'claude_md';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Rule
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * A single taste rule representing a user preference.
 *
 * Taste rules are learned from user corrections and injected into
 * the agent's context to avoid repeated corrections.
 *
 * Weight is determined by correction count:
 * - 2 corrections → weight 2 (moderate)
 * - 3+ corrections → weight 3+ (strict)
 * - Manual rules → weight 5 (highest priority)
 */
export interface TasteRule {
  /** Unique identifier for this rule */
  id: string;

  /** The preference category */
  category: TasteCategory;

  /** Human-readable description of the preference */
  description: string;

  /** How this rule was detected */
  source: TasteSource;

  /** Number of times this preference was observed/reinforced */
  count: number;

  /** ISO 8601 timestamp of when this rule was first created */
  createdAt: string;

  /** ISO 8601 timestamp of when this rule was last observed */
  lastSeen: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Data (Persistence Schema)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Full schema for taste persistence file.
 *
 * Stored in `{workspace}/.disclaude/taste.json` (global)
 * or `{workspace}/projects/{name}/.disclaude/taste.json` (per-project).
 *
 * Uses write-then-rename pattern for atomic persistence
 * (same pattern as ProjectManager).
 */
export interface TasteData {
  /** Schema version for future migrations */
  version: 1;

  /** Map of rule ID → taste rule */
  rules: Record<string, TasteRule>;

  /** ISO 8601 timestamp of last modification */
  updatedAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Manager Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a TasteManager instance.
 */
export interface TasteManagerOptions {
  /** Workspace root directory (parent of `.disclaude/`) */
  workspaceDir: string;

  /**
   * Optional project-specific subdirectory.
   * When provided, taste is stored under the project's workingDir.
   * When omitted, taste is stored at workspace root level.
   */
  projectWorkingDir?: string;
}
