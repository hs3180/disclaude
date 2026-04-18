/**
 * Type definitions for the TasteManager module.
 *
 * Implements the user taste auto-summarization system — per-chatId
 * persistent storage of user preferences to avoid repeated corrections.
 *
 * @see Issue #2335 (feat: auto-summarize user taste)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Unified result type for TasteManager operations.
 */
export type TasteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Entry Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Source of a taste rule.
 */
export type TasteSource = 'auto' | 'manual' | 'claude_md';

/**
 * Category of a taste rule.
 */
export type TasteCategory = 'code_style' | 'interaction' | 'tech_preference' | 'project_convention' | 'other';

/**
 * A single taste rule representing a user preference.
 *
 * Captures what the user prefers, how it was detected,
 * and metadata for weighting and management.
 */
export interface TasteEntry {
  /** Unique ID for this taste rule */
  id: string;
  /** Human-readable description of the preference */
  rule: string;
  /** Category for grouping and display */
  category: TasteCategory;
  /** How this taste was detected */
  source: TasteSource;
  /** Number of times user has corrected this issue (weight indicator) */
  correctionCount: number;
  /** ISO 8601 timestamp when first detected */
  firstSeen: string;
  /** ISO 8601 timestamp when last observed */
  lastSeen: string;
}

/**
 * Metadata tracking the taste system state.
 */
export interface TasteMeta {
  /** ISO 8601 timestamp of last update */
  updatedAt: string;
  /** Total number of taste rules */
  totalRules: number;
  /** Version of the taste schema for migration support */
  version: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Per-chatId taste data stored in taste.json.
 *
 * Path: `{workspace}/.disclaude/taste/{chatId}.json`
 *
 * Uses write-then-rename pattern for atomic persistence.
 */
export interface TasteFile {
  /** Schema version */
  version: number;
  /** Chat ID this taste belongs to */
  chatId: string;
  /** Taste rules */
  entries: TasteEntry[];
  /** Metadata */
  meta: TasteMeta;
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
// Query / Filter Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Filter options for querying taste entries.
 */
export interface TasteFilter {
  /** Filter by category */
  category?: TasteCategory;
  /** Filter by source */
  source?: TasteSource;
  /** Minimum correction count (weight filter) */
  minCorrections?: number;
}

/**
 * Options for adding a new taste entry.
 */
export interface AddTasteOptions {
  /** The taste rule description */
  rule: string;
  /** Category (default: 'other') */
  category?: TasteCategory;
  /** Source (default: 'manual') */
  source?: TasteSource;
  /** Initial correction count (default: 1) */
  correctionCount?: number;
}
