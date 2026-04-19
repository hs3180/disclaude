/**
 * Type definitions for the TasteManager module.
 *
 * Implements per-project user taste (preference) persistence and injection.
 *
 * Phase 1: Manual taste management (add/remove/list rules).
 * Future: Auto-detection from chat patterns.
 *
 * @see Issue #2335 (auto-summarize user taste to avoid repeated corrections)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Core Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Category of taste rules.
 *
 * Groups related preferences for organized display and injection.
 */
export type TasteCategory = 'code_style' | 'interaction' | 'technical' | 'custom';

/**
 * Source of a taste rule.
 *
 * - `manual`: User explicitly added via /taste add
 * - `auto`: Auto-detected from correction patterns (future)
 * - `claude_md`: Extracted from CLAUDE.md directives (future)
 */
export type TasteSource = 'manual' | 'auto' | 'claude_md';

/**
 * A single taste rule representing a user preference.
 *
 * Each rule captures a specific preference the user has expressed,
 * along with metadata about when/how it was added.
 */
export interface TasteRule {
  /** The preference description (e.g., "使用 const/let，禁止 var") */
  rule: string;

  /** Category for grouping */
  category: TasteCategory;

  /** How this rule was added */
  source: TasteSource;

  /** ISO 8601 timestamp when the rule was added */
  addedAt: string;

  /** Number of times this preference was corrected (for auto-detected rules) */
  correctionCount?: number;

  /** ISO 8601 timestamp of last correction (for auto-detected rules) */
  lastSeen?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Full schema for taste.yaml persistence.
 *
 * Stored at `{projectWorkingDir}/taste.yaml` within a project instance,
 * or at `{workspaceDir}/taste.yaml` for the default project.
 *
 * Uses YAML format for human readability and easy manual editing.
 */
export interface TasteData {
  /** Taste rules organized by category */
  taste: Partial<Record<TasteCategory, TasteRule[]>>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Manager Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a TasteManager instance.
 */
export interface TasteManagerOptions {
  /** Directory where taste.yaml is stored */
  storageDir: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type (re-export pattern from ProjectManager)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Unified result type for TasteManager operations.
 */
export type TasteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
