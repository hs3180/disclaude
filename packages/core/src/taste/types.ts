/**
 * Type definitions for the TasteManager module.
 *
 * Auto-summarizes user preferences (taste) to avoid repeated corrections.
 * Each chatId maintains an independent set of taste rules.
 *
 * @see Issue #2335 — feat(project): auto-summarize user taste
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Unified result type for TasteManager operations.
 *
 * Consistent with ProjectResult pattern from project/types.ts.
 */
export type TasteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Rule Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Category of a taste rule.
 *
 * Groups preferences into logical areas for display and management.
 */
export type TasteCategory = 'code_style' | 'interaction' | 'tech_preference' | 'project_norm' | 'other';

/**
 * Source of a taste rule.
 *
 * - `auto`: Detected automatically from repeated user corrections
 * - `manual`: Explicitly added by the user via /taste add
 * - `claude_md`: Extracted from CLAUDE.md frontmatter or content
 */
export type TasteSource = 'auto' | 'manual' | 'claude_md';

/**
 * A single taste rule.
 *
 * Represents one user preference that the agent should follow.
 */
export interface TasteRule {
  /** Unique identifier within a chatId (e.g., "r-1") */
  id: string;

  /** Category for grouping */
  category: TasteCategory;

  /** The preference description (e.g., "使用 const/let，禁止 var") */
  rule: string;

  /** How this rule was discovered */
  source: TasteSource;

  /** Number of times the user corrected this behavior (for auto-detected) */
  correctionCount: number;

  /** ISO 8601 timestamp of last correction/occurrence */
  lastSeen: string;

  /** ISO 8601 timestamp of first detection */
  createdAt: string;
}

/**
 * Taste data for a single chatId.
 *
 * Stored as an entry in the persistence file.
 */
export interface ChatTasteData {
  /** All taste rules for this chat */
  rules: TasteRule[];
}

/**
 * Full schema for the taste persistence file.
 *
 * Stored in `{workspace}/.disclaude/taste.json`.
 * Uses the same atomic write-then-rename pattern as projects.json.
 */
export interface TastePersistData {
  /** Map of chatId → taste data */
  chats: Record<string, ChatTasteData>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constructor Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a TasteManager instance.
 */
export interface TasteManagerOptions {
  /** Workspace root directory (parent of `.disclaude/`) */
  workspaceDir: string;
}
