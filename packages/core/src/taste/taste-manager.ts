/**
 * TasteManager — core logic for user taste (preference) persistence.
 *
 * Manages taste rules in memory with atomic persistence to
 * `{workspace}/.disclaude/taste.json`.
 *
 * Taste rules represent learned user preferences that are injected
 * into Agent context to prevent repeated corrections.
 *
 * Design:
 * - In-memory state with atomic file persistence (write-then-rename)
 * - JSON format consistent with projects.json
 * - CRUD operations for taste rules
 * - Per-workspace isolation (taste stored in workspace root)
 *
 * @see Issue #2335
 */

import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TASTE_CATEGORY_LABELS,
  type TasteCategory,
  type TasteManagerOptions,
  type TastePersistData,
  type TasteResult,
  type TasteRule,
  type TasteSource,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Validation Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Maximum length for a taste rule content */
const MAX_CONTENT_LENGTH = 500;

/** Maximum number of taste rules per workspace */
const MAX_RULES_COUNT = 100;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages user taste rules with in-memory state and atomic persistence.
 *
 * Lifecycle:
 * 1. Construct with `TasteManagerOptions`
 * 2. Data is automatically loaded from disk in constructor
 * 3. Use `addRule()`, `removeRule()`, `updateRule()` for mutations
 * 4. Use `formatTasteContext()` to get formatted string for Agent injection
 */
export class TasteManager {
  /** Path to .disclaude directory */
  private readonly dataDir: string;
  /** Path to taste.json */
  private readonly persistPath: string;
  /** Path to temporary file used during atomic write */
  private readonly persistTmpPath: string;

  /** In-memory taste rules, keyed by id */
  private rules: Map<string, TasteRule> = new Map();

  constructor(options: TasteManagerOptions) {
    this.dataDir = join(options.workspaceDir, '.disclaude');
    this.persistPath = join(this.dataDir, 'taste.json');
    this.persistTmpPath = join(this.dataDir, 'taste.json.tmp');

    // Load persisted data on construction
    this.loadPersistedData();
  }

  // ───────────────────────────────────────────
  // Core CRUD Operations
  // ───────────────────────────────────────────

  /**
   * Add a new taste rule.
   *
   * @param category - Taste category
   * @param content - Human-readable preference description
   * @param source - How this rule was discovered (default: 'manual')
   * @returns TasteResult with the created TasteRule
   */
  addRule(
    category: TasteCategory,
    content: string,
    source: TasteSource = 'manual',
  ): TasteResult<TasteRule> {
    // Validate inputs
    const contentError = this.validateContent(content);
    if (contentError) {
      return { ok: false, error: contentError };
    }

    // Check duplicate content
    const existing = this.findByContent(content);
    if (existing) {
      // Reinforce existing rule instead of creating duplicate
      return this.reinforceRule(existing.id);
    }

    // Check max rules count
    if (this.rules.size >= MAX_RULES_COUNT) {
      return { ok: false, error: `偏好规则数量已达上限 (${MAX_RULES_COUNT})` };
    }

    const now = new Date().toISOString();
    const rule: TasteRule = {
      id: this.generateId(),
      category,
      content: content.trim(),
      source,
      count: 1,
      createdAt: now,
      lastSeen: now,
    };

    this.rules.set(rule.id, rule);
    this.persist();

    return { ok: true, data: { ...rule } };
  }

  /**
   * Remove a taste rule by id.
   *
   * @param id - Rule identifier
   * @returns TasteResult with the removed TasteRule
   */
  removeRule(id: string): TasteResult<TasteRule> {
    const rule = this.rules.get(id);
    if (!rule) {
      return { ok: false, error: `规则 "${id}" 不存在` };
    }

    this.rules.delete(id);
    this.persist();

    return { ok: true, data: { ...rule } };
  }

  /**
   * Reinforce an existing rule (increment count, update lastSeen).
   *
   * Used when a preference is observed again, increasing its weight.
   *
   * @param id - Rule identifier
   * @returns TasteResult with the updated TasteRule
   */
  reinforceRule(id: string): TasteResult<TasteRule> {
    const rule = this.rules.get(id);
    if (!rule) {
      return { ok: false, error: `规则 "${id}" 不存在` };
    }

    rule.count += 1;
    rule.lastSeen = new Date().toISOString();

    this.persist();

    return { ok: true, data: { ...rule } };
  }

  /**
   * Update a rule's content or category.
   *
   * @param id - Rule identifier
   * @param updates - Partial updates to apply
   * @returns TasteResult with the updated TasteRule
   */
  updateRule(
    id: string,
    updates: Partial<Pick<TasteRule, 'content' | 'category'>>,
  ): TasteResult<TasteRule> {
    const rule = this.rules.get(id);
    if (!rule) {
      return { ok: false, error: `规则 "${id}" 不存在` };
    }

    if (updates.content !== undefined) {
      const contentError = this.validateContent(updates.content);
      if (contentError) {
        return { ok: false, error: contentError };
      }
      rule.content = updates.content.trim();
    }

    if (updates.category !== undefined) {
      rule.category = updates.category;
    }

    this.persist();

    return { ok: true, data: { ...rule } };
  }

  // ───────────────────────────────────────────
  // Query Methods
  // ───────────────────────────────────────────

  /**
   * Get a rule by id.
   *
   * @param id - Rule identifier
   * @returns The TasteRule, or undefined if not found
   */
  getRule(id: string): TasteRule | undefined {
    return this.rules.get(id);
  }

  /**
   * List all rules, optionally filtered by category or source.
   *
   * @param filter - Optional filter criteria
   * @returns Array of TasteRules sorted by lastSeen (most recent first)
   */
  listRules(filter?: { category?: TasteCategory; source?: TasteSource }): TasteRule[] {
    let result = Array.from(this.rules.values());

    if (filter?.category) {
      result = result.filter(r => r.category === filter.category);
    }
    if (filter?.source) {
      result = result.filter(r => r.source === filter.source);
    }

    return result.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  /**
   * Get total number of rules.
   */
  getRuleCount(): number {
    return this.rules.size;
  }

  /**
   * Clear all rules.
   */
  clearAll(): void {
    this.rules.clear();
    this.persist();
  }

  // ───────────────────────────────────────────
  // Context Formatting
  // ───────────────────────────────────────────

  /**
   * Format taste rules as a context string for Agent prompt injection.
   *
   * Groups rules by category and formats them as readable Markdown.
   * Returns empty string if no rules exist.
   *
   * @returns Formatted taste context string
   */
  formatTasteContext(): string {
    if (this.rules.size === 0) {
      return '';
    }

    const categoryGroups = new Map<TasteCategory, TasteRule[]>();

    for (const rule of this.rules.values()) {
      const existing = categoryGroups.get(rule.category) ?? [];
      existing.push(rule);
      categoryGroups.set(rule.category, existing);
    }

    const lines: string[] = [];
    lines.push('以下是你从用户交互中学习到的偏好规则，请在后续交互中严格遵守：');
    lines.push('');

    for (const [category, rules] of categoryGroups.entries()) {
      const label = TASTE_CATEGORY_LABELS[category] ?? category;
      lines.push(`**${label}**:`);

      // Sort rules by count (highest first) within category
      const sorted = [...rules].sort((a, b) => b.count - a.count);
      for (const rule of sorted) {
        const sourceTag = rule.source === 'auto' ? `（被纠正 ${rule.count} 次）` : '';
        lines.push(`- ${rule.content} ${sourceTag}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ───────────────────────────────────────────
  // Persistence
  // ───────────────────────────────────────────

  /**
   * Get the persist file path (for testing/debugging).
   */
  getPersistPath(): string {
    return this.persistPath;
  }

  /**
   * Persist current in-memory state to disk using atomic write-then-rename.
   *
   * @returns TasteResult indicating success or failure
   */
  persist(): TasteResult<void> {
    try {
      // Ensure .disclaude/ directory exists
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      const data: TastePersistData = {
        version: 1,
        rules: Array.from(this.rules.values()),
      };

      const json = JSON.stringify(data, null, 2);
      writeFileSync(this.persistTmpPath, json, 'utf8');

      try {
        renameSync(this.persistTmpPath, this.persistPath);
      } catch (renameErr) {
        try {
          unlinkSync(this.persistTmpPath);
        } catch {
          // Ignore cleanup failure
        }
        return {
          ok: false,
          error: `偏好数据写入失败: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
        };
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `偏好数据持久化失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Load persisted data from disk and restore in-memory state.
   *
   * Gracefully handles missing/corrupted files:
   * - File not found → silently skip (first run)
   * - Invalid JSON → log error, skip
   * - Invalid schema → skip invalid entries
   */
  loadPersistedData(): TasteResult<void> {
    if (!existsSync(this.persistPath)) {
      return { ok: true, data: undefined };
    }

    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as unknown;

      if (!this.validateSchema(data)) {
        return { ok: false, error: 'taste.json 格式无效，已跳过恢复' };
      }

      const persisted = data as TastePersistData;

      for (const rule of persisted.rules) {
        if (this.isValidRule(rule)) {
          this.rules.set(rule.id, { ...rule });
        }
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `读取 taste.json 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ───────────────────────────────────────────
  // Internal Helpers
  // ───────────────────────────────────────────

  /**
   * Generate a unique rule id.
   */
  private generateId(): string {
    return `taste_${randomUUID().slice(0, 8)}`;
  }

  /**
   * Find a rule by exact content match.
   */
  private findByContent(content: string): TasteRule | undefined {
    const trimmed = content.trim();
    for (const rule of this.rules.values()) {
      if (rule.content === trimmed) {
        return rule;
      }
    }
    return undefined;
  }

  /**
   * Validate rule content.
   */
  private validateContent(content: string): string | null {
    if (!content || content.trim().length === 0) {
      return '偏好规则内容不能为空';
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return `偏好规则内容不能超过 ${MAX_CONTENT_LENGTH} 个字符`;
    }
    return null;
  }

  /**
   * Validate top-level schema of persisted data.
   */
  private validateSchema(data: unknown): data is TastePersistData {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const obj = data as Record<string, unknown>;
    if (obj.version !== 1) {
      return false;
    }
    if (!Array.isArray(obj.rules)) {
      return false;
    }
    return true;
  }

  /**
   * Validate a single rule entry from persisted data.
   */
  private isValidRule(rule: unknown): rule is TasteRule {
    if (typeof rule !== 'object' || rule === null) {
      return false;
    }
    const r = rule as Record<string, unknown>;
    return (
      typeof r.id === 'string' && r.id.length > 0 &&
      typeof r.category === 'string' && r.category.length > 0 &&
      typeof r.content === 'string' && r.content.length > 0 &&
      typeof r.source === 'string' &&
      typeof r.count === 'number' &&
      typeof r.createdAt === 'string' && r.createdAt.length > 0 &&
      typeof r.lastSeen === 'string' && r.lastSeen.length > 0
    );
  }
}
