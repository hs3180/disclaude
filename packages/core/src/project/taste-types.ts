/**
 * Type definitions for the TasteManager module.
 *
 * Implements per-project user taste (preference) tracking for Issue #2335.
 * Taste data captures user preferences discovered through interactions,
 * such as code style, interaction habits, and technical choices.
 *
 * Storage: `{workspace}/projects/{projectName}/taste.json`
 *
 * @see Issue #2335 (auto-summarize user taste to avoid repeated corrections)
 */

import type { ProjectResult } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Categories
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Predefined categories for organizing taste entries.
 *
 * Each category represents a different aspect of user preferences.
 */
export type TasteCategory =
  | 'code_style'      // Code formatting and naming conventions
  | 'interaction'     // Communication and interaction preferences
  | 'technical'       // Technology stack and tool preferences
  | 'project_norms'   // Project-specific rules and conventions
  | 'custom';         // User-defined category

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Entry
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Source of a taste entry — how the preference was discovered.
 */
export type TasteSource =
  | 'auto'        // Automatically detected from user corrections
  | 'claude_md'   // Extracted from CLAUDE.md
  | 'manual';     // Manually added by user

/**
 * A single taste (preference) rule.
 *
 * Represents one user preference with metadata about its origin
 * and strength (based on how many times it was reinforced).
 */
export interface TasteEntry {
  /** The preference rule as a human-readable string */
  rule: string;

  /** Category this taste belongs to */
  category: TasteCategory;

  /** How the preference was discovered */
  source: TasteSource;

  /** Number of times this preference was reinforced (correction count for auto) */
  count: number;

  /** ISO 8601 timestamp of last reinforcement */
  lastSeen: string;

  /** Optional custom category name (when category is 'custom') */
  customCategory?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Full schema for `{workspace}/projects/{projectName}/taste.json`.
 *
 * Uses write-then-rename pattern (same as projects.json)
 * to prevent corruption on crash/interruption.
 */
export interface TastePersistData {
  /** Taste entries grouped by category */
  entries: Record<string, TasteEntry[]>;

  /** Schema version for future migrations */
  version: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a TasteManager instance.
 */
export interface TasteManagerOptions {
  /** Workspace root directory */
  workspaceDir: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager Public API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Public interface for TasteManager operations.
 *
 * Provides CRUD for per-project taste entries, persistence,
 * and prompt text generation for Agent context injection.
 */
export interface ITasteManager {
  /** Add a taste entry for a project */
  addEntry(projectName: string, entry: Omit<TasteEntry, 'count' | 'lastSeen'>): ProjectResult<TasteEntry>;

  /** Remove a specific taste entry by category and rule index */
  removeEntry(projectName: string, category: TasteCategory, index: number): ProjectResult<void>;

  /** List all taste entries for a project, optionally filtered by category */
  listEntries(projectName: string, category?: TasteCategory): TasteEntry[];

  /** Generate prompt text for Agent context injection */
  toPromptText(projectName: string): string;

  /** Clear all taste entries for a project */
  clear(projectName: string): ProjectResult<void>;

  /** Reinforce an existing taste entry (increment count, update lastSeen) */
  reinforce(projectName: string, category: TasteCategory, ruleIndex: number): ProjectResult<TasteEntry>;

  /** Load taste data from disk */
  load(projectName: string): ProjectResult<void>;

  /** Persist current taste data to disk */
  persist(projectName: string): ProjectResult<void>;
}
