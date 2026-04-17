/**
 * TasteManager — manages auto-summarized user taste (preferences).
 *
 * Persists user preferences learned from corrections to disk,
 * providing CRUD operations and taste prompt generation.
 *
 * Design:
 * - Atomic persistence using write-then-rename (same pattern as ProjectManager)
 * - Graceful handling of missing/corrupted files
 * - Per-project isolation via projectWorkingDir option
 * - Schema versioning for future migrations
 *
 * @see Issue #2335 (feat: auto-summarize user taste to avoid repeated corrections)
 */

import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TASTE_CATEGORIES,
  type TasteCategory,
  type TasteData,
  type TasteManagerOptions,
  type TasteRule,
  type TasteSource,
} from './taste-types.js';
import type { ProjectResult } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Minimum correction count before auto-creating a taste rule */
const AUTO_DETECTION_THRESHOLD = 2;

/** Maximum number of taste rules per project (prevents unbounded growth) */
const MAX_RULES = 100;

/** Maximum description length */
const MAX_DESCRIPTION_LENGTH = 500;

/** Characters forbidden in descriptions (control chars) */
const FORBIDDEN_DESC_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages user taste rules — persistent preferences learned from corrections.
 *
 * Lifecycle:
 * 1. Construct with `TasteManagerOptions`
 * 2. Call `load()` to restore persisted state (or starts empty)
 * 3. Use `addRule()`, `updateRule()`, `removeRule()` to manage rules
 * 4. Call `buildTastePrompt()` to generate the taste section for agent context
 * 5. Changes are persisted to disk on every mutation
 */
export class TasteManager {
  private readonly dataDir: string;
  private readonly persistPath: string;
  private readonly persistTmpPath: string;

  /** In-memory taste rules */
  private rules: Map<string, TasteRule> = new Map();

  /** Whether persisted data has been loaded */
  private loaded = false;

  constructor(options: TasteManagerOptions) {
    // If projectWorkingDir is provided, use it; otherwise use workspace root
    const baseDir = options.projectWorkingDir ?? options.workspaceDir;
    this.dataDir = join(baseDir, '.disclaude');
    this.persistPath = join(this.dataDir, 'taste.json');
    this.persistTmpPath = join(this.dataDir, 'taste.json.tmp');
  }

  // ───────────────────────────────────────────
  // Initialization
  // ───────────────────────────────────────────

  /**
   * Load persisted taste data from disk.
   *
   * Safe to call multiple times (idempotent).
   * Gracefully handles missing or corrupted files.
   */
  load(): ProjectResult<void> {
    if (this.loaded) {
      return { ok: true, data: undefined };
    }

    if (!existsSync(this.persistPath)) {
      this.loaded = true;
      return { ok: true, data: undefined };
    }

    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as unknown;

      if (!this.validateSchema(data)) {
        this.loaded = true;
        return { ok: false, error: 'taste.json 格式无效，已跳过恢复' };
      }

      const tasteData = data as TasteData;

      for (const [id, rule] of Object.entries(tasteData.rules)) {
        if (this.validateRule(rule)) {
          this.rules.set(id, rule);
        }
      }

      this.loaded = true;
      return { ok: true, data: undefined };
    } catch (err) {
      this.loaded = true;
      return {
        ok: false,
        error: `读取 taste.json 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ───────────────────────────────────────────
  // CRUD Operations
  // ───────────────────────────────────────────

  /**
   * Add a new taste rule.
   *
   * Generates a unique ID and persists to disk.
   *
   * @param category - The preference category
   * @param description - Human-readable description of the preference
   * @param source - How the rule was detected (default: 'manual')
   * @returns ProjectResult with the created TasteRule
   */
  addRule(
    category: TasteCategory,
    description: string,
    source: TasteSource = 'manual',
  ): ProjectResult<TasteRule> {
    this.ensureLoaded();

    // Validate
    const validationError = this.validateNewRule(category, description);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    // Check for duplicate descriptions (same category + description)
    const existingRule = this.findDuplicate(category, description);
    if (existingRule) {
      // Reinforce existing rule instead of creating duplicate
      return this.reinforceRule(existingRule.id);
    }

    const now = new Date().toISOString();
    const rule: TasteRule = {
      id: randomUUID(),
      category,
      description: description.trim(),
      source,
      count: source === 'manual' ? 1 : AUTO_DETECTION_THRESHOLD,
      createdAt: now,
      lastSeen: now,
    };

    this.rules.set(rule.id, rule);
    this.persist();

    return { ok: true, data: rule };
  }

  /**
   * Update an existing taste rule's description.
   *
   * @param id - Rule ID to update
   * @param description - New description
   * @returns ProjectResult with the updated TasteRule
   */
  updateRule(id: string, description: string): ProjectResult<TasteRule> {
    this.ensureLoaded();

    const rule = this.rules.get(id);
    if (!rule) {
      return { ok: false, error: `规则 "${id}" 不存在` };
    }

    const descError = this.validateDescription(description);
    if (descError) {
      return { ok: false, error: descError };
    }

    rule.description = description.trim();
    rule.lastSeen = new Date().toISOString();

    this.persist();
    return { ok: true, data: { ...rule } };
  }

  /**
   * Remove a taste rule by ID.
   *
   * @param id - Rule ID to remove
   * @returns ProjectResult indicating success or failure
   */
  removeRule(id: string): ProjectResult<void> {
    this.ensureLoaded();

    if (!this.rules.has(id)) {
      return { ok: false, error: `规则 "${id}" 不存在` };
    }

    this.rules.delete(id);
    this.persist();

    return { ok: true, data: undefined };
  }

  /**
   * Reinforce an existing rule (increment count).
   *
   * Called when a taste signal matching an existing rule is detected.
   *
   * @param id - Rule ID to reinforce
   * @returns ProjectResult with the updated TasteRule
   */
  reinforceRule(id: string): ProjectResult<TasteRule> {
    this.ensureLoaded();

    const rule = this.rules.get(id);
    if (!rule) {
      return { ok: false, error: `规则 "${id}" 不存在` };
    }

    rule.count++;
    rule.lastSeen = new Date().toISOString();

    this.persist();
    return { ok: true, data: { ...rule } };
  }

  /**
   * Clear all taste rules.
   *
   * @returns ProjectResult indicating success
   */
  clear(): ProjectResult<void> {
    this.ensureLoaded();
    this.rules.clear();
    this.persist();
    return { ok: true, data: undefined };
  }

  // ───────────────────────────────────────────
  // Query Operations
  // ───────────────────────────────────────────

  /**
   * Get a single rule by ID.
   *
   * @param id - Rule ID
   * @returns The TasteRule, or undefined if not found
   */
  getRule(id: string): TasteRule | undefined {
    this.ensureLoaded();
    return this.rules.get(id);
  }

  /**
   * List all taste rules, optionally filtered by category.
   *
   * @param category - Optional category filter
   * @returns Array of TasteRules sorted by count (descending)
   */
  listRules(category?: TasteCategory): TasteRule[] {
    this.ensureLoaded();

    let rules = Array.from(this.rules.values());

    if (category) {
      rules = rules.filter(r => r.category === category);
    }

    return rules.sort((a, b) => b.count - a.count);
  }

  /**
   * Get the total number of rules.
   */
  getRuleCount(): number {
    this.ensureLoaded();
    return this.rules.size;
  }

  /**
   * Find a rule that matches the given category and similar description.
   *
   * Uses exact match for description comparison.
   *
   * @param category - Category to match
   * @param description - Description to match
   * @returns Matching rule, or undefined
   */
  findDuplicate(category: TasteCategory, description: string): TasteRule | undefined {
    const normalized = description.trim().toLowerCase();
    for (const rule of this.rules.values()) {
      if (rule.category === category && rule.description.toLowerCase() === normalized) {
        return rule;
      }
    }
    return undefined;
  }

  // ───────────────────────────────────────────
  // Prompt Generation
  // ───────────────────────────────────────────

  /**
   * Build the taste section for agent context injection.
   *
   * Generates a formatted string listing all taste rules,
   * grouped by category, for inclusion in the agent's system prompt.
   *
   * Returns empty string if no rules exist.
   *
   * @returns Formatted taste section, or empty string
   */
  buildTastePrompt(): string {
    this.ensureLoaded();

    if (this.rules.size === 0) {
      return '';
    }

    const categoryLabels: Record<string, string> = {
      code_style: '代码风格',
      interaction: '交互偏好',
      tech_choice: '技术选择',
      project_norm: '项目规范',
      custom: '自定义',
    };

    // Group rules by category
    const grouped = new Map<string, TasteRule[]>();
    for (const rule of this.rules.values()) {
      const existing = grouped.get(rule.category) ?? [];
      existing.push(rule);
      grouped.set(rule.category, existing);
    }

    const lines: string[] = [
      '## User Taste (auto-learned preferences)',
      '',
      '以下是用户反复纠正的偏好规则。**必须严格遵守**这些规则，避免用户再次纠正：',
      '',
    ];

    for (const [category, rules] of grouped) {
      const label = categoryLabels[category] ?? category;
      lines.push(`### ${label}`);
      lines.push('');

      // Sort by count descending within category
      const sorted = rules.sort((a, b) => b.count - a.count);
      for (const rule of sorted) {
        const sourceTag = rule.source === 'auto'
          ? `（被纠正 ${rule.count} 次）`
          : rule.source === 'claude_md'
            ? '（来自 CLAUDE.md）'
            : '（手动设置）';
        lines.push(`- ${rule.description} ${sourceTag}`);
      }
      lines.push('');
    }

    lines.push('**注意**：遵循这些规则时不需要特别标注来源，自然地应用即可。');

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
   * Persist current state to disk using atomic write-then-rename.
   */
  private persist(): ProjectResult<void> {
    try {
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      const data: TasteData = {
        version: 1,
        rules: {},
        updatedAt: new Date().toISOString(),
      };

      for (const [id, rule] of this.rules.entries()) {
        data.rules[id] = { ...rule };
      }

      const json = JSON.stringify(data, null, 2);
      writeFileSync(this.persistTmpPath, json, 'utf8');

      try {
        renameSync(this.persistTmpPath, this.persistPath);
      } catch (renameErr) {
        try { unlinkSync(this.persistTmpPath); } catch { /* ignore */ }
        return {
          ok: false,
          error: `taste 持久化写入失败: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
        };
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `taste 持久化失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ───────────────────────────────────────────
  // Validation
  // ───────────────────────────────────────────

  /**
   * Validate the schema of persisted data.
   */
  private validateSchema(data: unknown): data is TasteData {
    if (typeof data !== 'object' || data === null) {return false;}
    const obj = data as Record<string, unknown>;

    if (obj.version !== 1) {return false;}
    if (typeof obj.rules !== 'object' || obj.rules === null || Array.isArray(obj.rules)) {return false;}
    if (typeof obj.updatedAt !== 'string') {return false;}

    return true;
  }

  /**
   * Validate a single taste rule from persisted data.
   */
  private validateRule(rule: unknown): rule is TasteRule {
    if (typeof rule !== 'object' || rule === null) {return false;}
    const r = rule as Record<string, unknown>;

    return (
      typeof r.id === 'string' &&
      typeof r.category === 'string' &&
      TASTE_CATEGORIES.includes(r.category) &&
      typeof r.description === 'string' &&
      r.description.length > 0 &&
      typeof r.source === 'string' &&
      ['auto', 'manual', 'claude_md'].includes(r.source) &&
      typeof r.count === 'number' &&
      typeof r.createdAt === 'string' &&
      typeof r.lastSeen === 'string'
    );
  }

  /**
   * Validate a new rule before creation.
   */
  private validateNewRule(category: string, description: string): string | null {
    if (!TASTE_CATEGORIES.includes(category)) {
      return `无效的偏好类别 "${category}"。有效类别: ${TASTE_CATEGORIES.join(', ')}`;
    }

    const descError = this.validateDescription(description);
    if (descError) {return descError;}

    if (this.rules.size >= MAX_RULES) {
      return `偏好规则数量已达上限 (${MAX_RULES})，请先删除不需要的规则`;
    }

    return null;
  }

  /**
   * Validate a description string.
   */
  private validateDescription(description: string): string | null {
    if (!description || description.trim().length === 0) {
      return '偏好描述不能为空';
    }
    if (FORBIDDEN_DESC_CHARS.test(description)) {
      return '偏好描述不能包含控制字符';
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return `偏好描述不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符`;
    }
    return null;
  }

  /**
   * Ensure data is loaded before operations.
   */
  private ensureLoaded(): void {
    if (!this.loaded) {
      this.load();
    }
  }
}
