/**
 * Type definitions for the Taste module — auto-summarized user preferences.
 *
 * Stores per-workspace user preferences (code style, interaction habits,
 * technical choices) so the Agent can follow them without repeated corrections.
 *
 * Phase 1 (this file): Core data model + file-based persistence + prompt injection.
 * Future phases: Auto-detection from chat patterns, /taste management commands,
 * per-project isolation via the Project system.
 *
 * @see Issue #2335 — auto-summarize user taste to avoid repeated corrections
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Rule Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * How a taste rule was created.
 *
 * - `manual`: User wrote the rule in taste.yaml or via /taste commands
 * - `auto`: Automatically detected from repeated user corrections
 * - `claude_md`: Extracted from the project's CLAUDE.md file
 */
export type TasteSource = 'manual' | 'auto' | 'claude_md';

/**
 * Category of a taste rule.
 *
 * Groups rules for display and prompt injection.
 */
export type TasteCategory = 'code_style' | 'interaction' | 'technical' | 'project_convention';

/**
 * A single user preference rule.
 *
 * Represents one actionable instruction the Agent should follow.
 * Rules accumulate from repeated user corrections or manual entry.
 *
 * @example
 * ```yaml
 * - category: code_style
 *   content: "Use const/let, never var"
 *   source: auto
 *   correctionCount: 3
 *   lastSeen: "2026-04-14"
 * ```
 */
export interface TasteRule {
  /** Category for grouping and prompt injection */
  category: TasteCategory;

  /** The actual preference instruction */
  content: string;

  /** How this rule was created */
  source: TasteSource;

  /** Number of times the user corrected this issue (auto-detected rules only) */
  correctionCount?: number;

  /** ISO 8601 date when this rule was last observed/enforced */
  lastSeen?: string;

  /** ISO 8601 date when this rule was first created */
  createdAt?: string;

  /**
   * Optional human-readable note explaining why this rule exists.
   * Useful for auto-detected rules to show the original correction.
   */
  note?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Profile (stored on disk)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Full taste profile for a workspace/project.
 *
 * Stored as `{workspaceDir}/taste.yaml`.
 *
 * @example
 * ```yaml
 * version: 1
 * rules:
 *   - category: code_style
 *     content: "Use const/let, never var"
 *     source: auto
 *     correctionCount: 3
 *     lastSeen: "2026-04-14"
 *   - category: interaction
 *     content: "Reply concisely, conclusion first then analysis"
 *     source: manual
 * ```
 */
export interface TasteProfile {
  /** Schema version for future migration support */
  version: 1;

  /** Ordered list of taste rules (injected in this order) */
  rules: TasteRule[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Store Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a TasteStore.
 */
export interface TasteStoreOptions {
  /** Workspace directory containing taste.yaml */
  workspaceDir: string;

  /** Custom filename (default: 'taste.yaml') */
  filename?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type (consistent with ProjectResult pattern)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Unified result type for TasteStore operations.
 */
export type TasteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
