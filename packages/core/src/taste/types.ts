/**
 * Type definitions for the TasteManager module.
 *
 * Manages user taste (preference) data — auto-learned or manually set rules
 * that the Agent should follow in subsequent interactions.
 *
 * @see Issue #2335 (auto-summarize user taste)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Unified result type for TasteManager operations.
 *
 * Success: `{ ok: true, data: T }` — operation completed successfully.
 * Failure: `{ ok: false, error: string }` — validation or runtime error.
 */
export type TasteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Taste Rule Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Predefined taste categories.
 *
 * Users can group taste rules by category for organized management.
 * Custom categories are also supported via `TasteCategory.custom()`.
 */
export class TasteCategory {
  private constructor(
    public readonly value: string,
    public readonly displayName: string,
  ) {}

  static readonly CODE_STYLE = new TasteCategory('code_style', '代码风格');
  static readonly INTERACTION = new TasteCategory('interaction', '交互习惯');
  static readonly TECH_CHOICE = new TasteCategory('tech_choice', '技术偏好');
  static readonly PROJECT_CONVENTION = new TasteCategory('project_convention', '项目规范');
  static readonly OTHER = new TasteCategory('other', '其他');

  /**
   * Create a custom taste category.
   *
   * @param value - Category identifier (e.g. "writing_style")
   * @param displayName - Human-readable name (e.g. "写作风格")
   */
  static custom(value: string, displayName: string): TasteCategory {
    return new TasteCategory(value, displayName);
  }

  /** All built-in categories */
  static readonly ALL: readonly TasteCategory[] = [
    TasteCategory.CODE_STYLE,
    TasteCategory.INTERACTION,
    TasteCategory.TECH_CHOICE,
    TasteCategory.PROJECT_CONVENTION,
    TasteCategory.OTHER,
  ];

  toString(): string {
    return this.value;
  }
}

/**
 * Source of a taste rule.
 *
 * - `auto_detected`: Automatically extracted from repeated user corrections
 * - `claude_md`: Imported from the project's CLAUDE.md file
 * - `manual`: Manually added by the user
 */
export type TasteSource = 'auto_detected' | 'claude_md' | 'manual';

/**
 * A single taste rule.
 *
 * Represents one preference that the Agent should follow.
 * Rules are grouped by category and have metadata about their source.
 */
export interface TasteRule {
  /** Unique identifier for this rule */
  id: string;

  /** The preference description (e.g. "使用 const/let，禁止 var") */
  content: string;

  /** Category grouping */
  category: string;

  /** How this rule was discovered */
  source: TasteSource;

  /**
   * How many times the user has corrected this (auto_detected only).
   * Higher count = higher priority for the Agent to follow.
   */
  count?: number;

  /** ISO 8601 timestamp of last observation (auto_detected only) */
  lastSeen?: string;

  /** ISO 8601 creation timestamp */
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Full schema for `{workingDir}/taste.json`.
 *
 * Stored in the project's working directory.
 * Uses write-then-rename pattern for atomic persistence.
 */
export interface TastePersistData {
  /** All taste rules */
  rules: TasteRule[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constructor Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a TasteManager instance.
 */
export interface TasteManagerOptions {
  /**
   * Directory where taste.json is stored.
   * Typically the project's workingDir (e.g. `workspace/projects/my-project/`).
   */
  workingDir: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Add Rule Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for adding a new taste rule.
 */
export interface AddTasteRuleOptions {
  /** The preference description */
  content: string;

  /** Category (defaults to 'other') */
  category?: string;

  /** Source (defaults to 'manual') */
  source?: TasteSource;

  /** Correction count (for auto_detected, defaults to 1) */
  count?: number;

  /** Rule ID (auto-generated if not provided) */
  id?: string;
}
