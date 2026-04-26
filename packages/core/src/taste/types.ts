/**
 * Type definitions for the TasteManager module.
 *
 * Implements the user taste (preference) auto-summarization system —
 * automatically learns and persists user preferences to avoid repeated
 * corrections across sessions.
 *
 * Design principles:
 * - Project-scoped: Taste is stored per-project, with workspace-level fallback
 * - Auto-detection: Observes repeated corrections and extracts rules
 * - Manual override: Users can explicitly add/edit/delete taste rules
 * - Transparent injection: Taste is injected into Agent system prompt
 *
 * @see Issue #2335 (parent — auto-summarize user taste)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Unified result type for TasteManager operations.
 *
 * Reuses the same pattern as ProjectResult for consistency.
 */
export type TasteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Entry Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Category of a taste rule.
 *
 * Groups related preferences for organized display and injection.
 */
export type TasteCategory =
  | 'code_style'
  | 'interaction'
  | 'technical'
  | 'project_convention'
  | 'other';

/**
 * Source of a taste rule — how it was originally detected.
 *
 * - `auto`: Automatically detected from repeated user corrections
 * - `manual`: Explicitly added by the user
 * - `claude_md`: Extracted from CLAUDE.md directives
 */
export type TasteSource = 'auto' | 'manual' | 'claude_md';

/**
 * A single taste (preference) rule.
 *
 * Represents one learned or manually-specified user preference
 * that the Agent should follow.
 */
export interface TasteEntry {
  /** The preference rule as a natural language statement */
  rule: string;

  /** Category for grouping (e.g., code_style, interaction) */
  category: TasteCategory;

  /** How this rule was originally detected */
  source: TasteSource;

  /** Number of times the user has corrected this issue (weight signal) */
  correctionCount: number;

  /** ISO 8601 timestamp of the last correction/update */
  lastSeen: string;

  /** ISO 8601 timestamp of first detection */
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Full schema for taste persistence file.
 *
 * Stored at `{dataDir}/taste.json` using atomic write-then-rename pattern.
 *
 * The `projectTastes` key supports per-project taste overrides:
 * - Key = project name
 * - Value = array of TasteEntry specific to that project
 *
 * Workspace-level tastes apply globally; project-specific tastes
 * are merged on top (project takes precedence).
 */
export interface TastePersistData {
  /** Workspace-level taste rules (apply to all projects) */
  workspace: TasteEntry[];

  /** Per-project taste overrides (keyed by project name) */
  projects: Record<string, TasteEntry[]>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Manager Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a TasteManager instance.
 */
export interface TasteManagerOptions {
  /** Data directory path (typically `{workspace}/.disclaude/`) */
  dataDir: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Auto-detection Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * A detected correction signal from conversation analysis.
 *
 * Used by the auto-detection system to identify repeated corrections.
 * Multiple signals with the same category/pattern can be consolidated
 * into a single TasteEntry.
 */
export interface CorrectionSignal {
  /** The category of the correction */
  category: TasteCategory;

  /** The extracted rule from the correction */
  rule: string;

  /** ISO 8601 timestamp when this correction was observed */
  timestamp: string;

  /** The original user message that triggered the correction */
  originalMessage: string;
}
