/**
 * TasteManager — per-project user taste (preference) management.
 *
 * Manages taste rules that capture user preferences (code style, interaction
 * preferences, technical choices) so the Agent can automatically follow them
 * without the user needing to repeat corrections.
 *
 * Phase 1: Manual taste management (add/remove/list rules via /taste commands).
 * Future phases: Auto-detection from correction patterns, CLAUDE.md extraction.
 *
 * Storage: `{storageDir}/taste.yaml` (human-readable, manually editable).
 *
 * @see Issue #2335 (auto-summarize user taste to avoid repeated corrections)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type {
  TasteCategory,
  TasteData,
  TasteManagerOptions,
  TasteResult,
  TasteRule,
  TasteSource,
} from './taste-types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** File name for taste persistence */
const TASTE_FILENAME = 'taste.yaml';

/** Maximum rules per category */
const MAX_RULES_PER_CATEGORY = 50;

/** Maximum rule description length */
const MAX_RULE_LENGTH = 500;

/** Valid categories */
const VALID_CATEGORIES: TasteCategory[] = ['code_style', 'interaction', 'technical', 'custom'];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages per-project taste rules with YAML persistence.
 *
 * Lifecycle:
 * 1. Construct with `TasteManagerOptions`
 * 2. Call `load()` to read persisted taste data (or start empty)
 * 3. Use `add()`, `remove()`, `list()` to manage rules
 * 4. Call `buildContextString()` to get formatted taste for agent prompt
 */
export class TasteManager {
  private readonly storageDir: string;
  private readonly tastePath: string;
  private data: TasteData;

  constructor(options: TasteManagerOptions) {
    this.storageDir = options.storageDir;
    this.tastePath = join(this.storageDir, TASTE_FILENAME);
    this.data = { taste: {} };
  }

  // ───────────────────────────────────────────
  // Load / Save
  // ───────────────────────────────────────────

  /**
   * Load taste data from disk.
   *
   * If the file doesn't exist, starts with empty data.
   * Invalid YAML is handled gracefully — starts empty with a warning.
   */
  load(): TasteResult<void> {
    if (!existsSync(this.tastePath)) {
      this.data = { taste: {} };
      return { ok: true, data: undefined };
    }

    try {
      const raw = readFileSync(this.tastePath, 'utf8');
      const parsed = yaml.load(raw) as unknown;

      if (!this.validateSchema(parsed)) {
        this.data = { taste: {} };
        return { ok: false, error: 'taste.yaml 格式无效，已重置为空' };
      }

      this.data = parsed as TasteData;
      return { ok: true, data: undefined };
    } catch (err) {
      this.data = { taste: {} };
      return {
        ok: false,
        error: `读取 taste.yaml 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Save current taste data to disk as YAML.
   *
   * Creates the storage directory if it doesn't exist.
   */
  save(): TasteResult<void> {
    try {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }

      const content = yaml.dump(this.data, {
        lineWidth: -1, // Don't wrap lines
        quotingType: '"',
        forceQuotes: false,
      });

      writeFileSync(this.tastePath, content, 'utf8');
      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `保存 taste.yaml 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ───────────────────────────────────────────
  // Core CRUD
  // ───────────────────────────────────────────

  /**
   * Add a new taste rule.
   *
   * @param rule - The preference description
   * @param category - Category for grouping
   * @param source - How this rule was added (default: manual)
   * @returns TasteResult with the added TasteRule
   */
  add(rule: string, category: TasteCategory, source: TasteSource = 'manual'): TasteResult<TasteRule> {
    // Validate inputs
    const ruleError = this.validateRule(rule);
    if (ruleError) {
      return { ok: false, error: ruleError };
    }

    const categoryError = this.validateCategory(category);
    if (categoryError) {
      return { ok: false, error: categoryError };
    }

    // Check for duplicates
    if (this.isDuplicate(rule, category)) {
      return { ok: false, error: '该偏好规则已存在' };
    }

    // Check limit
    const existing = this.data.taste[category] ?? [];
    if (existing.length >= MAX_RULES_PER_CATEGORY) {
      return { ok: false, error: `类别 "${category}" 已达上限 (${MAX_RULES_PER_CATEGORY} 条)` };
    }

    const tasteRule: TasteRule = {
      rule: rule.trim(),
      category,
      source,
      addedAt: new Date().toISOString(),
    };

    if (!this.data.taste[category]) {
      this.data.taste[category] = [];
    }
    const rules = this.data.taste[category] as TasteRule[];
    rules.push(tasteRule);

    // Persist immediately
    const saveResult = this.save();
    if (!saveResult.ok) {
      // Rollback
      rules.pop();
      return saveResult as TasteResult<TasteRule>;
    }

    return { ok: true, data: tasteRule };
  }

  /**
   * Remove a taste rule by its text content (exact match in category).
   *
   * @param rule - The exact rule text to remove
   * @param category - Category to remove from
   * @returns TasteResult indicating success
   */
  remove(rule: string, category: TasteCategory): TasteResult<void> {
    const categoryError = this.validateCategory(category);
    if (categoryError) {
      return { ok: false, error: categoryError };
    }

    const rules = this.data.taste[category];
    if (!rules || rules.length === 0) {
      return { ok: false, error: `类别 "${category}" 中没有规则` };
    }

    const index = rules.findIndex(r => r.rule === rule.trim());
    if (index === -1) {
      return { ok: false, error: `未找到规则: "${rule}"` };
    }

    // eslint-disable-next-line prefer-destructuring
    const removed = rules.splice(index, 1)[0];

    // Clean up empty category
    if (rules.length === 0) {
      delete this.data.taste[category];
    }

    // Persist
    const saveResult = this.save();
    if (!saveResult.ok) {
      // Rollback
      if (!this.data.taste[category]) {
        this.data.taste[category] = [];
      }
      const catRules = this.data.taste[category] as TasteRule[];
      catRules.splice(index, 0, removed);
      return saveResult;
    }

    return { ok: true, data: undefined };
  }

  /**
   * List all taste rules, optionally filtered by category.
   *
   * @param category - Optional category filter
   * @returns Array of TasteRule
   */
  list(category?: TasteCategory): TasteRule[] {
    if (category) {
      return this.data.taste[category] ?? [];
    }

    // Return all rules across all categories
    const allRules: TasteRule[] = [];
    for (const cat of Object.values(this.data.taste)) {
      if (Array.isArray(cat)) {
        allRules.push(...cat);
      }
    }
    return allRules;
  }

  /**
   * Clear all taste rules (optionally filtered by category).
   *
   * @param category - Optional category to clear; if omitted, clears all
   */
  clear(category?: TasteCategory): TasteResult<void> {
    if (category) {
      const catRules = this.data.taste[category];
      if (!catRules || catRules.length === 0) {
        return { ok: false, error: `类别 "${category}" 中没有规则` };
      }
      delete this.data.taste[category];
    } else {
      this.data = { taste: {} };
    }

    return this.save();
  }

  // ───────────────────────────────────────────
  // Context Building
  // ───────────────────────────────────────────

  /**
   * Build a formatted taste context string for agent prompt injection.
   *
   * Returns a human-readable summary of all taste rules, grouped by category,
   * suitable for inclusion in the agent's system prompt or user message context.
   *
   * Returns empty string if no rules exist.
   */
  buildContextString(): string {
    const allRules = this.list();
    if (allRules.length === 0) {
      return '';
    }

    const categoryLabels: Record<TasteCategory, string> = {
      code_style: '代码风格',
      interaction: '交互偏好',
      technical: '技术选择',
      custom: '自定义',
    };

    const lines: string[] = ['[Project Taste — 用户偏好]'];
    lines.push('以下为用户已设定的偏好规则，请在后续交互中严格遵循：');
    lines.push('');

    for (const [cat, catRules] of Object.entries(this.data.taste)) {
      if (!Array.isArray(catRules) || catRules.length === 0) {continue;}

      const label = categoryLabels[cat as TasteCategory] ?? cat;
      lines.push(`**${label}**:`);

      for (const rule of catRules) {
        const sourceTag = rule.source === 'auto' ? '（自动检测）' : '';
        const countTag = rule.correctionCount ? `（被纠正 ${rule.correctionCount} 次）` : '';
        lines.push(`  - ${rule.rule}${sourceTag}${countTag}`);
      }
      lines.push('');
    }

    lines.push('遵循用户偏好时，可标注 "（基于你的偏好：xxx）" 让用户知晓。');

    return lines.join('\n');
  }

  // ───────────────────────────────────────────
  // Query Methods
  // ───────────────────────────────────────────

  /**
   * Get the total number of taste rules.
   */
  getRuleCount(): number {
    return this.list().length;
  }

  /**
   * Check if any taste rules exist.
   */
  hasRules(): boolean {
    return this.getRuleCount() > 0;
  }

  /**
   * Get the taste file path (for testing/debugging).
   */
  getTastePath(): string {
    return this.tastePath;
  }

  // ───────────────────────────────────────────
  // Internal Helpers
  // ───────────────────────────────────────────

  /**
   * Validate a rule string.
   */
  private validateRule(rule: string): string | null {
    if (!rule || rule.trim().length === 0) {
      return '偏好规则不能为空';
    }
    if (rule.trim().length > MAX_RULE_LENGTH) {
      return `偏好规则不能超过 ${MAX_RULE_LENGTH} 个字符`;
    }
    return null;
  }

  /**
   * Validate a category.
   */
  private validateCategory(category: string): string | null {
    if (!VALID_CATEGORIES.includes(category as TasteCategory)) {
      return `无效类别 "${category}"，有效值: ${VALID_CATEGORIES.join(', ')}`;
    }
    return null;
  }

  /**
   * Check if a rule already exists in a category.
   */
  private isDuplicate(rule: string, category: TasteCategory): boolean {
    const existing = this.data.taste[category] ?? [];
    return existing.some(r => r.rule === rule.trim());
  }

  /**
   * Validate the top-level schema of taste data.
   */
  private validateSchema(data: unknown): data is TasteData {
    if (typeof data !== 'object' || data === null) {return false;}

    const obj = data as Record<string, unknown>;
    if (typeof obj.taste !== 'object' || obj.taste === null) {return false;}

    const taste = obj.taste as Record<string, unknown>;
    for (const [, val] of Object.entries(taste)) {
      if (!Array.isArray(val)) {return false;}
      for (const rule of val as unknown[]) {
        if (typeof rule !== 'object' || rule === null) {return false;}
        const r = rule as Record<string, unknown>;
        if (typeof r.rule !== 'string') {return false;}
        if (typeof r.category !== 'string') {return false;}
      }
    }

    return true;
  }
}
