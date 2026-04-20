/**
 * TasteManager — manages user taste (preference) data per project.
 *
 * Handles CRUD operations for taste rules with atomic JSON persistence.
 * Taste data is stored in `{workingDir}/taste.json`.
 *
 * Lifecycle:
 * 1. Construct with `TasteManagerOptions`
 * 2. Call `load()` to read from disk (or auto-load on construction)
 * 3. Use `addRule()`, `removeRule()`, `updateRule()`, `getRules()` to manage rules
 * 4. Call `persist()` to save (auto-called on mutations)
 * 5. Use `toGuidanceData()` to get formatted data for prompt injection
 *
 * @see Issue #2335 (auto-summarize user taste)
 */

import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  TasteResult,
  TasteRule,
  TastePersistData,
  TasteManagerOptions,
  AddTasteRuleOptions,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Validation Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Maximum number of taste rules per project */
const MAX_RULES = 100;

/** Maximum length for rule content */
const MAX_CONTENT_LENGTH = 500;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages taste rules for a single project working directory.
 *
 * Thread model: single-process, no locking needed.
 * Atomic persistence: write to `.tmp`, then rename.
 */
export class TasteManager {
  private readonly workingDir: string;
  private readonly tastePath: string;
  private readonly tasteTmpPath: string;
  private rules: Map<string, TasteRule> = new Map();

  constructor(options: TasteManagerOptions) {
    this.workingDir = options.workingDir;
    this.tastePath = join(options.workingDir, 'taste.json');
    this.tasteTmpPath = join(options.workingDir, 'taste.json.tmp');

    // Auto-load from disk
    this.load();
  }

  // ───────────────────────────────────────────
  // Read Operations
  // ───────────────────────────────────────────

  /**
   * Get all taste rules, sorted by category then by creation time.
   *
   * @returns Array of taste rules
   */
  getRules(): TasteRule[] {
    return Array.from(this.rules.values()).sort((a, b) => {
      if (a.category !== b.category) {
        return a.category.localeCompare(b.category);
      }
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  /**
   * Get rules filtered by category.
   *
   * @param category - Category to filter by
   * @returns Array of taste rules in the category
   */
  getRulesByCategory(category: string): TasteRule[] {
    return this.getRules().filter((r) => r.category === category);
  }

  /**
   * Get a single rule by ID.
   *
   * @param id - Rule ID
   * @returns The taste rule, or undefined if not found
   */
  getRule(id: string): TasteRule | undefined {
    return this.rules.get(id);
  }

  /**
   * Check if taste data exists on disk.
   *
   * @returns true if taste.json exists
   */
  hasData(): boolean {
    return existsSync(this.tastePath);
  }

  /**
   * Get the total number of rules.
   *
   * @returns Number of rules
   */
  getRuleCount(): number {
    return this.rules.size;
  }

  // ───────────────────────────────────────────
  // Write Operations
  // ───────────────────────────────────────────

  /**
   * Add a new taste rule.
   *
   * @param options - Rule options
   * @returns TasteResult with the created rule on success
   */
  addRule(options: AddTasteRuleOptions): TasteResult<TasteRule> {
    // Validate content
    if (!options.content || options.content.trim().length === 0) {
      return { ok: false, error: '偏好内容不能为空' };
    }
    if (options.content.length > MAX_CONTENT_LENGTH) {
      return { ok: false, error: `偏好内容不能超过 ${MAX_CONTENT_LENGTH} 个字符` };
    }

    // Check capacity
    if (this.rules.size >= MAX_RULES) {
      return { ok: false, error: `已达到最大规则数 ${MAX_RULES}，请先删除不需要的规则` };
    }

    // Check for duplicate content (case-insensitive)
    const normalizedContent = options.content.trim().toLowerCase();
    for (const existing of this.rules.values()) {
      if (existing.content.trim().toLowerCase() === normalizedContent) {
        return { ok: false, error: `已存在相同的偏好规则: "${existing.content}"` };
      }
    }

    const rule: TasteRule = {
      id: options.id ?? randomUUID(),
      content: options.content.trim(),
      category: options.category ?? 'other',
      source: options.source ?? 'manual',
      count: options.count ?? 1,
      createdAt: new Date().toISOString(),
    };

    // Set lastSeen for auto_detected rules
    if (rule.source === 'auto_detected') {
      rule.lastSeen = rule.createdAt;
    }

    this.rules.set(rule.id, rule);
    this.persist();

    return { ok: true, data: rule };
  }

  /**
   * Remove a taste rule by ID.
   *
   * @param id - Rule ID to remove
   * @returns TasteResult with the removed rule on success
   */
  removeRule(id: string): TasteResult<TasteRule> {
    const rule = this.rules.get(id);
    if (!rule) {
      return { ok: false, error: `规则 "${id}" 不存在` };
    }

    this.rules.delete(id);
    this.persist();

    return { ok: true, data: rule };
  }

  /**
   * Update a taste rule's content.
   *
   * @param id - Rule ID to update
   * @param content - New content
   * @returns TasteResult with the updated rule on success
   */
  updateRule(id: string, content: string): TasteResult<TasteRule> {
    const rule = this.rules.get(id);
    if (!rule) {
      return { ok: false, error: `规则 "${id}" 不存在` };
    }

    if (!content || content.trim().length === 0) {
      return { ok: false, error: '偏好内容不能为空' };
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return { ok: false, error: `偏好内容不能超过 ${MAX_CONTENT_LENGTH} 个字符` };
    }

    rule.content = content.trim();
    this.persist();

    return { ok: true, data: rule };
  }

  /**
   * Increment the correction count for an auto-detected rule.
   *
   * If the rule doesn't exist by content, creates it as auto_detected.
   * If it exists, increments count and updates lastSeen.
   *
   * @param content - The preference content
   * @param category - Category (defaults to 'other')
   * @returns TasteResult with the rule (existing or newly created)
   */
  recordCorrection(content: string, category?: string): TasteResult<TasteRule> {
    if (!content || content.trim().length === 0) {
      return { ok: false, error: '偏好内容不能为空' };
    }

    const normalizedContent = content.trim().toLowerCase();

    // Check for existing rule with same content
    for (const existing of this.rules.values()) {
      if (existing.content.trim().toLowerCase() === normalizedContent) {
        existing.count = (existing.count ?? 0) + 1;
        existing.lastSeen = new Date().toISOString();
        this.persist();
        return { ok: true, data: existing };
      }
    }

    // Create new auto-detected rule
    return this.addRule({
      content: content.trim(),
      category: category ?? 'other',
      source: 'auto_detected',
      count: 1,
    });
  }

  /**
   * Clear all taste rules.
   *
   * @returns TasteResult indicating success or failure
   */
  clearAll(): TasteResult<void> {
    this.rules.clear();
    this.persist();
    return { ok: true, data: undefined };
  }

  // ───────────────────────────────────────────
  // Guidance Export
  // ───────────────────────────────────────────

  /**
   * Get taste data formatted for prompt injection.
   *
   * Returns an array of { category, rules } groups, sorted by category.
   * Each rule includes metadata for context (count, source).
   *
   * @returns Array of taste groups for guidance builder
   */
  toGuidanceData(): { category: string; rules: TasteRule[] }[] {
    const rules = this.getRules();
    const grouped = new Map<string, TasteRule[]>();

    for (const rule of rules) {
      const list = grouped.get(rule.category) ?? [];
      list.push(rule);
      grouped.set(rule.category, list);
    }

    return Array.from(grouped.entries()).map(([category, rules]) => ({
      category,
      rules,
    }));
  }

  // ───────────────────────────────────────────
  // Persistence
  // ───────────────────────────────────────────

  /**
   * Persist current rules to disk using atomic write-then-rename.
   *
   * @returns TasteResult indicating success or failure
   */
  persist(): TasteResult<void> {
    try {
      // Ensure working directory exists
      if (!existsSync(this.workingDir)) {
        mkdirSync(this.workingDir, { recursive: true });
      }

      const data: TastePersistData = {
        rules: Array.from(this.rules.values()),
      };

      const json = JSON.stringify(data, null, 2);
      writeFileSync(this.tasteTmpPath, json, 'utf8');

      try {
        renameSync(this.tasteTmpPath, this.tastePath);
      } catch (renameErr) {
        try {
          unlinkSync(this.tasteTmpPath);
        } catch {
          // Ignore cleanup failure
        }
        return {
          ok: false,
          error: `持久化写入失败: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
        };
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `持久化失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Load taste rules from disk.
   *
   * Corrupted or invalid files are handled gracefully.
   *
   * @returns TasteResult indicating success or failure
   */
  load(): TasteResult<void> {
    if (!existsSync(this.tastePath)) {
      return { ok: true, data: undefined };
    }

    try {
      const raw = readFileSync(this.tastePath, 'utf8');
      const data = JSON.parse(raw) as unknown;

      if (!this.validatePersistSchema(data)) {
        return { ok: false, error: 'taste.json 格式无效，已跳过恢复' };
      }

      const persisted = data as TastePersistData;

      for (const rule of persisted.rules) {
        if (!this.validateRule(rule)) {
          continue;
        }
        this.rules.set(rule.id, rule);
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `读取 taste.json 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Get the taste.json file path (for testing/debugging).
   *
   * @returns Absolute path to taste.json
   */
  getPersistPath(): string {
    return this.tastePath;
  }

  // ───────────────────────────────────────────
  // Validation
  // ───────────────────────────────────────────

  /**
   * Validate the top-level schema of persisted data.
   */
  private validatePersistSchema(data: unknown): data is TastePersistData {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const obj = data as Record<string, unknown>;
    if (!Array.isArray(obj.rules)) {
      return false;
    }
    return true;
  }

  /**
   * Validate a single taste rule from persisted data.
   */
  private validateRule(rule: unknown): rule is TasteRule {
    if (typeof rule !== 'object' || rule === null) {
      return false;
    }
    const r = rule as Record<string, unknown>;
    return (
      typeof r.id === 'string' &&
      r.id.length > 0 &&
      typeof r.content === 'string' &&
      r.content.length > 0 &&
      typeof r.category === 'string' &&
      typeof r.source === 'string' &&
      typeof r.createdAt === 'string'
    );
  }
}
