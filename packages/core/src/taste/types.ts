/**
 * Type definitions for the Taste module — auto-summarized user preferences.
 *
 * Detects and persists user preferences (taste) from conversation patterns,
 * injecting them into Agent context to avoid repeated corrections.
 *
 * @see https://github.com/hs3180/disclaude/issues/2335
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Category & Rule Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Categories of taste rules.
 *
 * Each category captures a different dimension of user preference.
 */
export type TasteCategory =
  | 'code_style'      // e.g., "use const/let, no var", "camelCase function names"
  | 'interaction'     // e.g., "be concise", "use Chinese commit messages"
  | 'tech_preference' // e.g., "prefer TypeScript", "use pnpm not npm"
  | 'project_norm';   // e.g., "tests in __tests__/ directory"

/**
 * A single taste rule — one observed user preference.
 *
 * Taste rules are auto-detected from conversation patterns (user corrections)
 * or manually specified by the user.
 */
export interface TasteRule {
  /** Human-readable preference description */
  rule: string;

  /** Category for grouping and display */
  category: TasteCategory;

  /** Detection source */
  source: TasteSource;
}

/**
 * How the taste rule was detected.
 */
export interface TasteSource {
  /** Origin of the rule */
  origin: 'auto' | 'manual' | 'claude_md';

  /** Number of times the user corrected this pattern (auto-detected only) */
  correctionCount?: number;

  /** ISO 8601 timestamp of the last observation */
  lastSeen: string;

  /** Optional example from the conversation that triggered detection */
  example?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Full schema for the taste persistence file.
 *
 * Stored at `{workspace}/.disclaude/taste.yaml`.
 * Uses write-then-rename pattern for atomic updates.
 *
 * When the Project system (#1916) is ready, taste files will be
 * moved to `workspace/projects/{name}/taste.yaml`.
 */
export interface TasteData {
  /** Schema version for future migrations */
  version: 1;

  /** All taste rules, keyed by a unique identifier */
  rules: Record<string, TasteRule>;

  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Detection Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * A detected correction pattern from conversation analysis.
 *
 * Produced by `detectTasteFromLogs()` and consumed by
 * `mergeTasteRules()` to update the taste file.
 */
export interface DetectedCorrection {
  /** The preference rule (e.g., "use const/let, no var") */
  rule: string;

  /** Best guess at the category */
  category: TasteCategory;

  /** Example quote from the conversation */
  example: string;

  /** Number of times this correction appeared */
  count: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type (re-use project pattern)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Result type for taste operations.
 */
export type TasteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
