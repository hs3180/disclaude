/**
 * TasteManager — auto-summarized user taste (preferences) persistence.
 *
 * Manages taste rules learned from user corrections, stored in
 * `{workspace}/.disclaude/taste.yaml`. Rules are organized by category
 * and injected into agent prompts for automatic compliance.
 *
 * Design:
 * - In-memory cache with atomic YAML persistence
 * - Category-organized rules with auto/manual/claude_md sources
 * - Weighted by correction count (more corrections = higher priority)
 * - Graceful handling of missing/corrupted files
 *
 * @see Issue #2335 (feat: auto-summarize user taste)
 */

import {
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  TASTE_CATEGORIES,
  TASTE_SOURCES,
  type TasteResult,
  type TasteCategory,
  type TasteRule,
  type TasteData,
  type TasteRuleEntry,
  type TasteManagerOptions,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Maximum allowed length for a taste rule description */
const MAX_DESCRIPTION_LENGTH = 200;

/** Maximum number of rules per category */
const MAX_RULES_PER_CATEGORY = 20;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages user taste rules with in-memory cache and YAML persistence.
 *
 * Lifecycle:
 * 1. Construct with `TasteManagerOptions`
 * 2. Data is loaded automatically from taste.yaml (or starts empty)
 * 3. Use `addRule()`, `removeRule()`, `listRules()` to manage rules
 * 4. `formatForPrompt()` generates the agent context injection string
 *
 * Zero-config: if no taste.yaml exists, all operations return empty results.
 */
export class TasteManager {
  private readonly workspaceDir: string;

  /** Path to .disclaude directory */
  private readonly dataDir: string;

  /** Path to taste.yaml */
  private readonly tastePath: string;

  /** Path to temporary file for atomic write */
  private readonly tasteTmpPath: string;

  /** In-memory cache of taste data */
  private data: TasteData;

  constructor(options: TasteManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.dataDir = join(options.workspaceDir, '.disclaude');
    this.tastePath = join(this.dataDir, 'taste.yaml');
    this.tasteTmpPath = join(this.dataDir, 'taste.yaml.tmp');
    this.data = { taste: {} };
    this.load();
  }

  // ───────────────────────────────────────────
  // Core Methods
  // ───────────────────────────────────────────

  /**
   * Add a taste rule.
   *
   * If a rule with the same category and description already exists,
   * increments the correction count and updates lastSeen timestamp.
   *
   * @param category - Taste category
   * @param description - Human-readable preference description
   * @param source - How this rule was created (default: 'auto')
   * @returns TasteResult with the added/updated rule
   */
  addRule(
    category: TasteCategory,
    description: string,
    source: 'auto' | 'manual' | 'claude_md' = 'auto',
  ): TasteResult<TasteRule> {
    // Validate inputs
    const categoryError = this.validateCategory(category);
    if (categoryError) {
      return { ok: false, error: categoryError };
    }

    const descError = this.validateDescription(description);
    if (descError) {
      return { ok: false, error: descError };
    }

    const sourceError = this.validateSource(source);
    if (sourceError) {
      return { ok: false, error: sourceError };
    }

    // Initialize category array if needed
    if (!this.data.taste[category]) {
      this.data.taste[category] = [];
    }

    const rules = this.data.taste[category];
    const now = new Date().toISOString();

    // Check for duplicate description (case-insensitive)
    const existing = rules.find(
      (r) => r.description.toLowerCase() === description.toLowerCase(),
    );

    if (existing) {
      // Update existing rule
      existing.correctionCount = (existing.correctionCount ?? 0) + 1;
      existing.lastSeen = now;
      existing.source = source;
      this.persist();
      return { ok: true, data: existing };
    }

    // Check capacity
    if (rules.length >= MAX_RULES_PER_CATEGORY) {
      // Remove the oldest rule with lowest correction count
      const sorted = [...rules].sort((a, b) => {
        const countA = a.correctionCount ?? 0;
        const countB = b.correctionCount ?? 0;
        if (countA !== countB) {return countA - countB;}
        return a.lastSeen.localeCompare(b.lastSeen);
      });
      const idx = rules.indexOf(sorted[0]);
      if (idx >= 0) {
        rules.splice(idx, 1);
      }
    }

    const rule: TasteRule = {
      description,
      source,
      correctionCount: source === 'auto' ? 1 : undefined,
      lastSeen: now,
      createdAt: now,
    };

    rules.push(rule);
    this.persist();

    return { ok: true, data: rule };
  }

  /**
   * Remove a specific taste rule by category and description.
   *
   * @param category - Taste category
   * @param description - Exact description to remove
   * @returns TasteResult indicating success or failure
   */
  removeRule(
    category: TasteCategory,
    description: string,
  ): TasteResult<void> {
    const rules = this.data.taste[category];
    if (!rules) {
      return { ok: false, error: `分类 "${category}" 中没有规则` };
    }

    const idx = rules.findIndex(
      (r) => r.description.toLowerCase() === description.toLowerCase(),
    );

    if (idx === -1) {
      return { ok: false, error: `未找到规则: "${description}"` };
    }

    rules.splice(idx, 1);

    // Clean up empty category
    if (rules.length === 0) {
      delete this.data.taste[category];
    }

    this.persist();
    return { ok: true, data: undefined };
  }

  /**
   * Remove a taste rule by its index in a category.
   *
   * @param category - Taste category
   * @param index - Zero-based index of the rule to remove
   * @returns TasteResult with the removed rule
   */
  removeRuleByIndex(
    category: TasteCategory,
    index: number,
  ): TasteResult<TasteRule> {
    const rules = this.data.taste[category];
    if (!rules) {
      return { ok: false, error: `分类 "${category}" 中没有规则` };
    }

    if (index < 0 || index >= rules.length) {
      return { ok: false, error: `索引 ${index} 超出范围 (0-${rules.length - 1})` };
    }

    const [removed] = rules.splice(index, 1);

    // Clean up empty category
    if (rules.length === 0) {
      delete this.data.taste[category];
    }

    this.persist();
    return { ok: true, data: removed };
  }

  /**
   * Clear all rules in a specific category, or all rules.
   *
   * @param category - Category to clear, or undefined to clear all
   * @returns TasteResult with count of removed rules
   */
  clear(category?: TasteCategory): TasteResult<number> {
    if (category) {
      const rules = this.data.taste[category];
      if (!rules) {
        return { ok: false, error: `分类 "${category}" 中没有规则` };
      }
      const count = rules.length;
      delete this.data.taste[category];
      this.persist();
      return { ok: true, data: count };
    }

    // Clear all
    let total = 0;
    for (const rules of Object.values(this.data.taste)) {
      total += rules?.length ?? 0;
    }
    this.data = { taste: {} };
    this.persist();
    return { ok: true, data: total };
  }

  // ───────────────────────────────────────────
  // Query Methods
  // ───────────────────────────────────────────

  /**
   * List all taste rules, optionally filtered by category.
   *
   * @param category - Optional category filter
   * @returns Array of taste rule entries with category info
   */
  listRules(category?: TasteCategory): TasteRuleEntry[] {
    const results: TasteRuleEntry[] = [];

    if (category) {
      const rules = this.data.taste[category] ?? [];
      for (const rule of rules) {
        results.push({ category, rule });
      }
    } else {
      for (const cat of TASTE_CATEGORIES) {
        const rules = this.data.taste[cat] ?? [];
        for (const rule of rules) {
          results.push({ category: cat, rule });
        }
      }
    }

    return results;
  }

  /**
   * Get the total number of rules across all categories.
   */
  getRuleCount(): number {
    let count = 0;
    for (const rules of Object.values(this.data.taste)) {
      count += rules?.length ?? 0;
    }
    return count;
  }

  /**
   * Check if any taste rules exist.
   */
  hasRules(): boolean {
    return this.getRuleCount() > 0;
  }

  /**
   * Get the taste data directory path.
   */
  getDataDir(): string {
    return this.dataDir;
  }

  /**
   * Get the taste file path.
   */
  getTastePath(): string {
    return this.tastePath;
  }

  // ───────────────────────────────────────────
  // Prompt Formatting
  // ───────────────────────────────────────────

  /**
   * Format taste rules as a system prompt section for agent injection.
   *
   * Returns a formatted string listing all rules grouped by category,
   * ready to be injected into the agent's context.
   *
   * Returns empty string if no rules exist.
   */
  formatForPrompt(): string {
    if (!this.hasRules()) {
      return '';
    }

    const sections: string[] = [];

    for (const cat of TASTE_CATEGORIES) {
      const rules = this.data.taste[cat];
      if (!rules || rules.length === 0) {continue;}

      // Sort by correction count (highest first)
      const sorted = [...rules].sort((a, b) => {
        return (b.correctionCount ?? 0) - (a.correctionCount ?? 0);
      });

      const lines = sorted.map((r) => {
        let suffix = '';
        if (r.source === 'auto' && r.correctionCount && r.correctionCount > 1) {
          suffix = `（被纠正 ${r.correctionCount} 次）`;
        } else if (r.source === 'claude_md') {
          suffix = '（来自 CLAUDE.md）';
        }
        return `- ${r.description}${suffix}`;
      });

      const catLabel = cat === 'code_style' ? '代码风格'
        : cat === 'interaction' ? '交互偏好'
        : cat === 'technical' ? '技术选择'
        : '项目规范';

      sections.push(`**${catLabel}**:\n${lines.join('\n')}`);
    }

    if (sections.length === 0) {return '';}

    return [
      '## User Taste (auto-learned preferences)',
      '',
      '以下规则是从用户交互中自动学习到的偏好，请严格遵守：',
      '',
      sections.join('\n\n'),
    ].join('\n');
  }

  // ───────────────────────────────────────────
  // Persistence
  // ───────────────────────────────────────────

  /**
   * Get the current in-memory data (for testing/debugging).
   */
  getData(): TasteData {
    return JSON.parse(JSON.stringify(this.data));
  }

  /**
   * Load taste data from YAML file.
   *
   * Gracefully handles:
   * - Missing file → starts with empty data
   * - Invalid YAML → logs error, uses empty data
   * - Invalid schema → skips invalid entries
   */
  private load(): void {
    if (!existsSync(this.tastePath)) {
      return; // First run — no taste data
    }

    try {
      const raw = readFileSync(this.tastePath, 'utf8');
      const parsed = this.parseYaml(raw);

      if (!this.validateSchema(parsed)) {
        return; // Invalid schema — use empty data
      }

      this.data = parsed as TasteData;
    } catch {
      // Corrupted or unreadable file — don't crash
    }
  }

  /**
   * Persist current in-memory state to taste.yaml.
   *
   * Uses atomic write-then-rename pattern for safety.
   */
  private persist(): TasteResult<void> {
    try {
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      const yaml = this.serializeYaml(this.data);

      writeFileSync(this.tasteTmpPath, yaml, 'utf8');

      try {
        renameSync(this.tasteTmpPath, this.tastePath);
      } catch (renameErr) {
        try { unlinkSync(this.tasteTmpPath); } catch { /* ignore */ }
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

  // ───────────────────────────────────────────
  // YAML Serialization (simple, zero-dependency)
  // ───────────────────────────────────────────

  /**
   * Parse a simple YAML structure into a JavaScript object.
   *
   * Supports only the subset needed for taste.yaml:
   * - Key-value pairs
   * - Nested objects
   * - Arrays of objects (with `- ` prefix)
   * - Quoted and unquoted strings
   *
   * NOT a full YAML parser — intentionally simple for zero dependencies.
   */
  private parseYaml(raw: string): unknown {
    const result: Record<string, Record<string, unknown>[]> = {};
    const lines = raw.split('\n');
    let currentCategory: string | null = null;
    let currentRules: Record<string, unknown>[] = [];

    for (const line of lines) {
      const trimmed = line.trimEnd();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {continue;}

      // Top-level key (taste:)
      if (!trimmed.startsWith(' ') && trimmed.endsWith(':')) {
        // Flush previous category
        if (currentCategory && currentRules.length > 0) {
          result[currentCategory] = currentRules;
        }
        currentCategory = trimmed.slice(0, -1);
        currentRules = [];
        continue;
      }

      // Category key (e.g., "  code_style:")
      const stripped = trimmed.trimStart();
      const indent = trimmed.length - stripped.length;
      if (indent === 2 && stripped.endsWith(':')) {
        // Flush previous category
        if (currentCategory && currentRules.length > 0) {
          result[currentCategory] = currentRules;
        }
        currentCategory = stripped.slice(0, -1);
        currentRules = [];
        continue;
      }

      // Array item start (e.g., "    - description: ...")
      const arrayMatch = stripped.match(/^- (\w+):\s*(.*)$/);
      if (arrayMatch) {
        currentRules.push({ [arrayMatch[1]]: this.parseValue(arrayMatch[2]) });
        continue;
      }

      // Array item property (e.g., "      source: auto")
      if (indent >= 4 && currentRules.length > 0) {
        const propMatch = stripped.match(/^(\w+):\s*(.*)$/);
        if (propMatch) {
          const lastRule = currentRules[currentRules.length - 1];
          lastRule[propMatch[1]] = this.parseValue(propMatch[2]);
        }
        continue;
      }
    }

    // Flush final category
    if (currentCategory && currentRules.length > 0) {
      result[currentCategory] = currentRules;
    }

    return { taste: result };
  }

  /**
   * Parse a YAML value (string, number, boolean).
   */
  private parseValue(value: string): string | number | boolean {
    const trimmed = value.trim();

    // Remove surrounding quotes
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }

    // Boolean
    if (trimmed === 'true') {return true;}
    if (trimmed === 'false') {return false;}

    // Number
    if (/^\d+$/.test(trimmed)) {return parseInt(trimmed, 10);}

    return trimmed;
  }

  /**
   * Serialize TasteData to YAML string.
   *
   * Simple, deterministic output format:
   * ```yaml
   * # User taste rules (auto-learned preferences)
   * taste:
   *   code_style:
   *     - description: "使用 const/let，禁止 var"
   *       source: auto
   *       correctionCount: 3
   *       lastSeen: "2026-04-14T10:00:00.000Z"
   *       createdAt: "2026-04-14T08:00:00.000Z"
   * ```
   */
  private serializeYaml(data: TasteData): string {
    const lines: string[] = [
      '# User taste rules (auto-learned preferences)',
      '# @see Issue #2335',
      'taste:',
    ];

    for (const cat of TASTE_CATEGORIES) {
      const rules = data.taste[cat];
      if (!rules || rules.length === 0) {continue;}

      lines.push(`  ${cat}:`);

      for (const rule of rules) {
        lines.push(`    - description: ${this.quoteString(rule.description)}`);
        lines.push(`      source: ${rule.source}`);
        if (rule.correctionCount !== undefined) {
          lines.push(`      correctionCount: ${rule.correctionCount}`);
        }
        lines.push(`      lastSeen: ${this.quoteString(rule.lastSeen)}`);
        lines.push(`      createdAt: ${this.quoteString(rule.createdAt)}`);
      }
    }

    return `${lines.join('\n')  }\n`;
  }

  /**
   * Quote a string value for YAML output.
   */
  private quoteString(value: string): string {
    if (/[:#\n'"{}[\],&*?|>!%@`]/.test(value) || value.includes('  ')) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }

  // ───────────────────────────────────────────
  // Validation
  // ───────────────────────────────────────────

  private validateCategory(category: string): string | null {
    if (!TASTE_CATEGORIES.includes(category as TasteCategory)) {
      return `无效的分类: "${category}"，有效值: ${TASTE_CATEGORIES.join(', ')}`;
    }
    return null;
  }

  private validateDescription(description: string): string | null {
    if (!description || description.trim().length === 0) {
      return '偏好描述不能为空';
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return `偏好描述不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符`;
    }
    return null;
  }

  private validateSource(source: string): string | null {
    if (!TASTE_SOURCES.includes(source as 'auto' | 'manual' | 'claude_md')) {
      return `无效的来源: "${source}"，有效值: ${TASTE_SOURCES.join(', ')}`;
    }
    return null;
  }

  private validateSchema(data: unknown): data is TasteData {
    if (typeof data !== 'object' || data === null) {return false;}
    const obj = data as Record<string, unknown>;
    if (typeof obj.taste !== 'object' || obj.taste === null) {return false;}
    return true;
  }
}
