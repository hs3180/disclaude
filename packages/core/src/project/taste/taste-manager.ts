/**
 * TasteManager — core in-memory + persistent logic for per-project user preferences.
 *
 * Manages user taste (preference) rules that the agent automatically learns
 * and follows. Taste rules are persisted as YAML in the project's working directory.
 *
 * Lifecycle:
 * 1. Construct with `TasteManagerOptions`
 * 2. Call `init()` to load existing taste data from disk
 * 3. Use `addRule()`, `removeRule()`, `listRules()` for CRUD operations
 * 4. Call `formatForPrompt()` to get agent-injectable taste summary
 * 5. Changes are auto-persisted on every mutation
 *
 * @see Issue #2335 — auto-summarize user taste to avoid repeated corrections
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  CATEGORY_LABELS,
  SOURCE_LABELS,
  type AddRuleOptions,
  type FormattedTasteRule,
  type TasteData,
  type TasteFilter,
  type TasteManagerOptions,
  type TasteRule,
} from './types.js';
import type { ProjectResult } from '../types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** File name for persisted taste data */
const TASTE_FILENAME = 'taste.yaml';

/** Maximum number of rules allowed per project */
const MAX_RULES = 100;

/** Maximum length of a single rule text */
const MAX_RULE_LENGTH = 500;

// AUTO_DETECT_THRESHOLD: reserved for future auto-detection feature (Issue #2335 Phase 2)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// YAML Serialization (minimal, no dependency)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Serialize TasteData to a human-readable YAML-like format.
 *
 * Uses a simple manual serializer to avoid adding a YAML dependency.
 * Format is designed to be human-readable and git-friendly.
 */
function serializeTasteYaml(data: TasteData): string {
  const lines: string[] = [
    '# User Taste / Preferences',
    '# Auto-managed by disclaude — edit manually or via /taste commands',
    `version: ${data.version}`,
    '',
    'rules:',
  ];

  if (data.rules.length === 0) {
    lines.push('  []');
  } else {
    for (const rule of data.rules) {
      lines.push(`  - rule: "${rule.rule.replace(/"/g, '\\"')}"`);
      lines.push(`    category: ${rule.category}`);
      lines.push(`    source: ${rule.source}`);
      lines.push(`    correctionCount: ${rule.correctionCount}`);
      lines.push(`    lastSeen: "${rule.lastSeen}"`);
      if (rule.customCategoryName) {
        lines.push(`    customCategoryName: "${rule.customCategoryName.replace(/"/g, '\\"')}"`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Parse the simple YAML format back into TasteData.
 *
 * This is a minimal parser for the exact format produced by serializeTasteYaml.
 * It handles the specific structure we produce and gracefully degrades on errors.
 */
function parseTasteYaml(raw: string): TasteData | null {
  try {
    const data: TasteData = {
      version: 1,
      rules: [],
    };

    const lines = raw.split('\n');
    let currentRule: Partial<TasteRule> | null = null;
    let inRules = false;

    for (const line of lines) {
      const trimmed = line.trimStart();

      // Skip comments and empty lines
      if (trimmed.startsWith('#') || trimmed === '') {
        continue;
      }

      // Parse version
      if (trimmed.startsWith('version:')) {
        const val = trimmed.split(':')[1]?.trim();
        data.version = parseInt(val ?? '1', 10);
        if (isNaN(data.version)) {
          data.version = 1;
        }
        continue;
      }

      // Detect rules section
      if (trimmed === 'rules:') {
        inRules = true;
        continue;
      }

      // Empty rules array
      if (inRules && trimmed === '[]') {
        break;
      }

      if (!inRules) {
        continue;
      }

      // New rule entry
      if (trimmed.startsWith('- rule:')) {
        if (currentRule && currentRule.rule !== undefined && currentRule.category !== undefined) {
          data.rules.push(finalizeRule(currentRule));
        }
        currentRule = {
          rule: extractQuotedValue(trimmed, '- rule:'),
        };
        continue;
      }

      // Rule properties
      if (currentRule !== null) {
        if (trimmed.startsWith('category:')) {
          currentRule.category = trimmed.split(':')[1]?.trim() as TasteRule['category'];
        } else if (trimmed.startsWith('source:')) {
          currentRule.source = trimmed.split(':')[1]?.trim() as TasteRule['source'];
        } else if (trimmed.startsWith('correctionCount:')) {
          const val = trimmed.split(':')[1]?.trim();
          currentRule.correctionCount = parseInt(val ?? '0', 10);
          if (isNaN(currentRule.correctionCount)) {
            currentRule.correctionCount = 0;
          }
        } else if (trimmed.startsWith('lastSeen:')) {
          currentRule.lastSeen = extractQuotedValue(trimmed, 'lastSeen:');
        } else if (trimmed.startsWith('customCategoryName:')) {
          currentRule.customCategoryName = extractQuotedValue(trimmed, 'customCategoryName:');
        }
      }
    }

    // Don't forget the last rule
    if (currentRule && currentRule.rule !== undefined && currentRule.category !== undefined) {
      data.rules.push(finalizeRule(currentRule));
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Extract a quoted value from a YAML line.
 * Handles both quoted ("value") and unquoted values.
 */
function extractQuotedValue(line: string, prefix: string): string {
  const afterPrefix = line.slice(line.indexOf(prefix) + prefix.length).trim();
  if (afterPrefix.startsWith('"') && afterPrefix.endsWith('"')) {
    return afterPrefix.slice(1, -1).replace(/\\"/g, '"');
  }
  return afterPrefix;
}

/**
 * Fill in defaults for a partially parsed rule.
 */
function finalizeRule(partial: Partial<TasteRule>): TasteRule {
  return {
    rule: partial.rule ?? '',
    category: partial.category ?? 'custom',
    source: partial.source ?? 'manual',
    correctionCount: partial.correctionCount ?? 0,
    lastSeen: partial.lastSeen ?? new Date().toISOString(),
    customCategoryName: partial.customCategoryName,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages per-project user taste (preference) rules.
 *
 * Taste rules capture user preferences that the agent should automatically
 * follow, avoiding repeated corrections across sessions.
 *
 * Persistence:
 * - Stored as `taste.yaml` in the project's working directory
 * - Auto-persisted on every mutation
 * - Atomic write (write to .tmp, then rename)
 *
 * Deduplication:
 * - Rules with identical text are merged (correctionCount incremented)
 * - Comparison is case-insensitive and whitespace-normalized
 */
export class TasteManager {
  private readonly projectDir: string;
  private readonly tastePath: string;
  private readonly tasteTmpPath: string;
  private rules: TasteRule[] = [];
  private initialized = false;

  constructor(options: TasteManagerOptions) {
    this.projectDir = options.projectDir;
    this.tastePath = join(options.projectDir, TASTE_FILENAME);
    this.tasteTmpPath = join(options.projectDir, `${TASTE_FILENAME}.tmp`);
  }

  // ───────────────────────────────────────────
  // Initialization
  // ───────────────────────────────────────────

  /**
   * Load taste data from disk.
   *
   * Safe to call multiple times (idempotent after first call).
   * Handles missing files (first run), corrupted files, and schema changes.
   */
  init(): ProjectResult<void> {
    this.initialized = true;

    if (!existsSync(this.tastePath)) {
      // First run — no taste data yet
      this.rules = [];
      return { ok: true, data: undefined };
    }

    try {
      const raw = readFileSync(this.tastePath, 'utf8');
      const data = parseTasteYaml(raw);

      if (!data) {
        // Corrupted file — start fresh
        this.rules = [];
        return { ok: false, error: 'taste.yaml 格式无效，已重置为空' };
      }

      // Validate rules
      this.rules = data.rules.filter((rule) =>
        typeof rule.rule === 'string' &&
        rule.rule.length > 0 &&
        typeof rule.category === 'string' &&
        typeof rule.source === 'string',
      );

      return { ok: true, data: undefined };
    } catch (err) {
      this.rules = [];
      return {
        ok: false,
        error: `读取 taste.yaml 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ───────────────────────────────────────────
  // CRUD Operations
  // ───────────────────────────────────────────

  /**
   * Add a new taste rule (or increment existing one if duplicate).
   *
   * Deduplication: if a rule with the same normalized text already exists,
   * its correctionCount is incremented and lastSeen is updated.
   *
   * @param options - Rule details
   * @returns ProjectResult with the added/updated TasteRule
   */
  addRule(options: AddRuleOptions): ProjectResult<TasteRule> {
    this.ensureInit();

    // Validate rule text
    if (!options.rule || options.rule.trim().length === 0) {
      return { ok: false, error: '规则文本不能为空' };
    }

    if (options.rule.length > MAX_RULE_LENGTH) {
      return { ok: false, error: `规则文本不能超过 ${MAX_RULE_LENGTH} 个字符` };
    }

    // Validate custom category
    if (options.category === 'custom' && !options.customCategoryName?.trim()) {
      return { ok: false, error: '自定义分类必须提供 customCategoryName' };
    }

    // Check for duplicate (case-insensitive, whitespace-normalized)
    const normalizedNew = normalizeRuleText(options.rule);
    const existingIndex = this.rules.findIndex(
      (r) => normalizeRuleText(r.rule) === normalizedNew,
    );

    if (existingIndex >= 0) {
      // Merge with existing rule
      const existing = this.rules[existingIndex];
      const shouldIncrement = options.incrementIfExists ??
        (options.source === 'auto');

      this.rules[existingIndex] = {
        ...existing,
        correctionCount: shouldIncrement ? existing.correctionCount + 1 : existing.correctionCount,
        lastSeen: new Date().toISOString(),
        // Keep the more authoritative source
        source: sourcePriority(existing.source) >= sourcePriority(options.source)
          ? existing.source
          : options.source,
      };

      this.persist();
      return { ok: true, data: this.rules[existingIndex] };
    }

    // Check max rules limit
    if (this.rules.length >= MAX_RULES) {
      return { ok: false, error: `已达到最大规则数量 (${MAX_RULES})` };
    }

    // Add new rule
    const newRule: TasteRule = {
      rule: options.rule.trim(),
      category: options.category,
      source: options.source,
      correctionCount: options.source === 'auto' ? 1 : 0,
      lastSeen: new Date().toISOString(),
      customCategoryName: options.customCategoryName?.trim(),
    };

    this.rules.push(newRule);
    this.persist();

    return { ok: true, data: newRule };
  }

  /**
   * Remove a taste rule by its index or exact text match.
   *
   * @param index - 0-based index of the rule to remove, or
   * @param ruleText - exact text to match (alternative to index)
   * @returns ProjectResult indicating success or failure
   */
  removeRule(index?: number, ruleText?: string): ProjectResult<void> {
    this.ensureInit();

    if (index !== undefined) {
      if (index < 0 || index >= this.rules.length) {
        return { ok: false, error: `索引 ${index} 超出范围 (0-${this.rules.length - 1})` };
      }
      this.rules.splice(index, 1);
      this.persist();
      return { ok: true, data: undefined };
    }

    if (ruleText !== undefined) {
      const normalized = normalizeRuleText(ruleText);
      const idx = this.rules.findIndex((r) => normalizeRuleText(r.rule) === normalized);
      if (idx < 0) {
        return { ok: false, error: '未找到匹配的规则' };
      }
      this.rules.splice(idx, 1);
      this.persist();
      return { ok: true, data: undefined };
    }

    return { ok: false, error: '必须提供 index 或 ruleText 参数' };
  }

  /**
   * List taste rules, optionally filtered.
   *
   * @param filter - Optional filter criteria
   * @returns Array of matching TasteRule (may be empty)
   */
  listRules(filter?: TasteFilter): TasteRule[] {
    this.ensureInit();

    let result = this.rules;

    if (filter?.category) {
      result = result.filter((r) => r.category === filter.category);
    }
    if (filter?.source) {
      result = result.filter((r) => r.source === filter.source);
    }
    if (filter?.minCorrections !== undefined && filter.minCorrections > 0) {
      result = result.filter((r) => r.correctionCount >= (filter.minCorrections ?? 0));
    }

    return result;
  }

  /**
   * Clear all taste rules.
   */
  clearRules(): ProjectResult<void> {
    this.ensureInit();
    this.rules = [];
    this.persist();
    return { ok: true, data: undefined };
  }

  // ───────────────────────────────────────────
  // Prompt Formatting
  // ───────────────────────────────────────────

  /**
   * Format all taste rules for injection into the agent's system prompt.
   *
   * Returns a human-readable summary organized by category,
   * with provenance information to help the agent understand the context.
   *
   * @returns Formatted string for prompt injection, or null if no rules
   */
  formatForPrompt(): string | null {
    this.ensureInit();

    if (this.rules.length === 0) {
      return null;
    }

    const formatted = this.getFormattedRules();

    // Group by category
    const grouped = new Map<string, FormattedTasteRule[]>();
    for (const rule of formatted) {
      const existing = grouped.get(rule.categoryLabel) ?? [];
      existing.push(rule);
      grouped.set(rule.categoryLabel, existing);
    }

    const lines: string[] = [
      '## User Preferences (auto-learned)',
      '',
      'The following preferences have been learned from this user. Follow them strictly:',
      '',
    ];

    for (const [category, rules] of grouped) {
      lines.push(`**${category}**:`);
      for (const rule of rules) {
        lines.push(`- ${rule.rule} (${rule.provenance})`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Get formatted taste rules with human-readable labels.
   *
   * @param filter - Optional filter criteria
   * @returns Array of FormattedTasteRule
   */
  getFormattedRules(filter?: TasteFilter): FormattedTasteRule[] {
    this.ensureInit();

    const rules = this.listRules(filter);

    return rules.map((rule) => ({
      rule: rule.rule,
      categoryLabel: rule.category === 'custom' && rule.customCategoryName
        ? rule.customCategoryName
        : CATEGORY_LABELS[rule.category],
      provenance: buildProvenance(rule),
    }));
  }

  // ───────────────────────────────────────────
  // Persistence
  // ───────────────────────────────────────────

  /**
   * Get the path to the taste.yaml file.
   */
  getTastePath(): string {
    return this.tastePath;
  }

  /**
   * Get the number of rules currently loaded.
   */
  getRuleCount(): number {
    return this.rules.length;
  }

  // ───────────────────────────────────────────
  // Internal Helpers
  // ───────────────────────────────────────────

  /**
   * Ensure init() has been called before operations.
   */
  private ensureInit(): void {
    if (!this.initialized) {
      this.init();
    }
  }

  /**
   * Persist current rules to disk using atomic write-then-rename.
   */
  private persist(): ProjectResult<void> {
    try {
      // Ensure project directory exists
      if (!existsSync(this.projectDir)) {
        mkdirSync(this.projectDir, { recursive: true });
      }

      const data: TasteData = {
        version: 1,
        rules: this.rules,
      };

      const yaml = serializeTasteYaml(data);
      writeFileSync(this.tasteTmpPath, yaml, 'utf8');

      try {
        renameSync(this.tasteTmpPath, this.tastePath);
      } catch (renameErr) {
        // Clean up .tmp file if rename fails
        try {
          unlinkSync(this.tasteTmpPath);
        } catch {
          // Ignore cleanup failure
        }
        return {
          ok: false,
          error: `taste.yaml 写入失败: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
        };
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `taste.yaml 持久化失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Module-level Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Normalize rule text for deduplication comparison.
 *
 * Lowercases and collapses whitespace for fuzzy matching.
 */
function normalizeRuleText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Get the authority priority of a taste source.
 *
 * Higher number = more authoritative (wins in merge).
 */
function sourcePriority(source: string): number {
  switch (source) {
    case 'manual': return 3;
    case 'claude_md': return 2;
    case 'auto': return 1;
    default: return 0;
  }
}

/**
 * Build a human-readable provenance description for a taste rule.
 */
function buildProvenance(rule: TasteRule): string {
  const sourceLabel = SOURCE_LABELS[rule.source];

  if (rule.source === 'auto' && rule.correctionCount > 0) {
    return `${sourceLabel}, corrected ${rule.correctionCount}x`;
  }

  return sourceLabel;
}
