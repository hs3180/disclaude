/**
 * Type definitions for the Taste module.
 *
 * Implements the user taste auto-summarization system — per-workspace
 * persistent user preferences that the agent follows automatically.
 *
 * Phase 1: Workspace-level taste (workspace/.disclaude/taste.json).
 * Future: Per-project taste when project system is fully merged.
 *
 * @see Issue #2335 (parent — auto-summarize user taste)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Rule Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Category of a taste rule.
 *
 * Groups related preferences for organized display and injection.
 */
export type TasteCategory =
  | 'code_style'      // Code formatting and naming preferences
  | 'interaction'     // Communication style preferences
  | 'technical'       // Technology/framework choices
  | 'project_norm'    // Project-specific conventions
  | 'general';        // Unclassified preferences

/**
 * How the taste rule was detected.
 *
 * - `auto`: Automatically detected from repeated corrections
 * - `claude_md`: Extracted from CLAUDE.md content
 * - `manual`: Explicitly set by the user
 */
export type TasteDetectionSource = 'auto' | 'claude_md' | 'manual';

/**
 * A single taste rule representing a user preference.
 *
 * Each rule captures what the user prefers, how it was detected,
 * and metadata about its strength (correction count).
 */
export interface TasteRule {
  /** The preference description (e.g., "使用 const/let，禁止 var") */
  rule: string;

  /** Category for grouping */
  category: TasteCategory;

  /** How this rule was detected */
  source: TasteDetectionSource;

  /** Number of times this correction pattern was observed (for auto-detected rules) */
  count: number;

  /** ISO 8601 timestamp of the last time this rule was observed/updated */
  lastSeen: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Schema for the taste persistence file.
 *
 * Stored at `{workspace}/.disclaude/taste.json` using atomic write.
 *
 * Uses the same write-then-rename pattern as projects.json to
 * prevent corruption on crash/interruption.
 */
export interface TasteFile {
  /** Schema version for future migration support */
  version: 1;

  /** Array of taste rules */
  rules: TasteRule[];

  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

/**
 * Result type for taste operations.
 *
 * Follows the same pattern as ProjectResult for consistency.
 */
export type TasteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
