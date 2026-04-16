/**
 * TasteManager — Auto-detect and persist user preferences (taste).
 *
 * Implements Issue #2335: auto-summarize user taste to avoid repeated corrections.
 *
 * Architecture:
 * ```
 * TasteManager
 *   ├── load()          — Read taste.yaml from disk
 *   ├── save()          — Atomic write (write tmp + rename)
 *   ├── addRule()       — Add a new taste rule
 *   ├── removeRule()    — Remove by description (exact match)
 *   ├── recordCorrection() — Upsert rule with incremented count
 *   ├── getRules()      — List rules (optionally filtered)
 *   ├── reset()         — Clear auto-detected rules only
 *   └── formatForPrompt() — Format rules as agent prompt section
 * ```
 *
 * Persistence: `{projectDir}/taste.yaml` or `{workspaceDir}/.disclaude/taste.yaml`
 * Atomic writes: write to `.tmp` then `rename()` to prevent corruption.
 *
 * @module taste/taste-manager
 */

import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { createLogger } from '../utils/logger.js';
import type {
  TasteData,
  TasteRule,
  TasteCategory,
  TasteManagerOptions,
  AddTasteRuleOptions,
  RecordCorrectionOptions,
  ListTasteRulesOptions,
} from './types.js';
import { TASTE_VERSION, TASTE_CATEGORY_LABELS } from './types.js';

const logger = createLogger('TasteManager');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager Class
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages user taste (preference) rules with YAML persistence.
 *
 * Taste rules capture recurring user corrections and preferences,
 * enabling the agent to automatically follow them in future interactions.
 *
 * @example
 * ```typescript
 * const tm = new TasteManager({ filePath: '/path/to/taste.yaml' });
 *
 * // Record a correction signal
 * tm.recordCorrection({ description: '使用 const/let，禁止 var', category: 'code_style' });
 * await tm.save();
 *
 * // Format for agent prompt
 * const prompt = tm.formatForPrompt();
 * ```
 */
export class TasteManager {
  private readonly filePath: string;
  private data: TasteData;

  constructor(options: TasteManagerOptions) {
    this.filePath = options.filePath;
    this.data = { version: TASTE_VERSION, rules: [] };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Persistence
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Load taste data from the YAML file on disk.
   *
   * If the file doesn't exist, initializes empty data.
   * If the file is corrupted, logs a warning and initializes empty data.
   *
   * @returns true if file was loaded successfully, false if initialized empty
   */
  load(): boolean {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = yaml.load(content) as TasteData | null | undefined;

      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) {
        logger.warn({ path: this.filePath }, 'Taste file is empty or invalid, initializing empty');
        this.data = { version: TASTE_VERSION, rules: [] };
        return false;
      }

      // Version migration placeholder — future format changes can be handled here
      if (parsed.version !== TASTE_VERSION) {
        logger.info(
          { currentVersion: parsed.version, expectedVersion: TASTE_VERSION },
          'Taste file version mismatch, migrating'
        );
      }

      this.data = {
        version: parsed.version ?? TASTE_VERSION,
        rules: parsed.rules,
      };

      logger.debug(
        { path: this.filePath, ruleCount: this.data.rules.length },
        'Taste data loaded'
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug({ path: this.filePath }, 'Taste file not found, initializing empty');
        this.data = { version: TASTE_VERSION, rules: [] };
        return false;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ path: this.filePath, error: message }, 'Failed to load taste file');
      this.data = { version: TASTE_VERSION, rules: [] };
      return false;
    }
  }

  /**
   * Save taste data to disk using atomic write (write .tmp then rename).
   *
   * Creates parent directories if they don't exist.
   * Uses write-then-rename to prevent corruption on crash/interruption.
   *
   * @throws Error if write or rename fails
   */
  save(): void {
    const dir = path.dirname(this.filePath);

    // Ensure parent directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpPath = this.filePath + '.tmp';
    const content = yaml.dump(this.data, { lineWidth: -1, quotingType: "'", forceQuotes: false });

    // Write to temp file first
    fs.writeFileSync(tmpPath, content, 'utf-8');

    // Atomic rename
    fs.renameSync(tmpPath, this.filePath);

    logger.debug(
      { path: this.filePath, ruleCount: this.data.rules.length },
      'Taste data saved'
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Rule Management
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Add a new taste rule.
   *
   * If a rule with the same description already exists, does nothing
   * (use `recordCorrection()` to update existing rules).
   *
   * @param options - Rule creation options
   * @returns true if rule was added, false if duplicate
   */
  addRule(options: AddTasteRuleOptions): boolean {
    const existing = this.findRuleByDescription(options.description);
    if (existing) {
      logger.debug({ description: options.description }, 'Taste rule already exists, skipping');
      return false;
    }

    const now = new Date().toISOString();
    const rule: TasteRule = {
      description: options.description,
      category: options.category ?? 'other',
      source: options.source ?? 'manual',
      correctionCount: 0,
      lastSeenAt: now,
      createdAt: now,
    };

    this.data.rules.push(rule);
    logger.info(
      { description: options.description, category: rule.category, source: rule.source },
      'Taste rule added'
    );
    return true;
  }

  /**
   * Remove a taste rule by description (exact match).
   *
   * @param description - Description of the rule to remove
   * @returns true if rule was found and removed, false otherwise
   */
  removeRule(description: string): boolean {
    const index = this.data.rules.findIndex(
      (r) => r.description === description
    );

    if (index === -1) {
      logger.debug({ description }, 'Taste rule not found for removal');
      return false;
    }

    const removed = this.data.rules.splice(index, 1)[0];
    logger.info(
      { description: removed.description, category: removed.category },
      'Taste rule removed'
    );
    return true;
  }

  /**
   * Record a correction signal — upsert a taste rule with incremented count.
   *
   * If a matching rule exists, increments `correctionCount` and updates `lastSeenAt`.
   * If no match exists, creates a new auto-detected rule.
   *
   * Matching is case-insensitive substring match (≥80% similarity).
   *
   * @param options - Correction recording options
   * @returns The matched or created rule
   */
  recordCorrection(options: RecordCorrectionOptions): TasteRule {
    const existing = this.findSimilarRule(options.description);

    if (existing) {
      existing.correctionCount++;
      existing.lastSeenAt = new Date().toISOString();
      logger.info(
        {
          description: existing.description,
          correctionCount: existing.correctionCount,
        },
        'Taste correction recorded (existing rule)'
      );
      return existing;
    }

    // Create new auto-detected rule
    const now = new Date().toISOString();
    const rule: TasteRule = {
      description: options.description,
      category: options.category ?? 'other',
      source: 'auto',
      correctionCount: 1,
      lastSeenAt: now,
      createdAt: now,
    };

    this.data.rules.push(rule);
    logger.info(
      { description: options.description, category: rule.category },
      'Taste correction recorded (new rule)'
    );
    return rule;
  }

  /**
   * Get taste rules, optionally filtered by category and/or source.
   *
   * @param options - Filter options (undefined = return all)
   * @returns Filtered taste rules
   */
  getRules(options?: ListTasteRulesOptions): TasteRule[] {
    let rules = [...this.data.rules];

    if (options?.category) {
      rules = rules.filter((r) => r.category === options.category);
    }

    if (options?.source) {
      rules = rules.filter((r) => r.source === options.source);
    }

    // Sort by correctionCount descending, then by lastSeenAt descending
    rules.sort((a, b) => {
      if (b.correctionCount !== a.correctionCount) {
        return b.correctionCount - a.correctionCount;
      }
      return b.lastSeenAt.localeCompare(a.lastSeenAt);
    });

    return rules;
  }

  /**
   * Get the total number of taste rules.
   */
  getRuleCount(): number {
    return this.data.rules.length;
  }

  /**
   * Reset all auto-detected taste rules.
   *
   * Keeps manually added and CLAUDE.md-sourced rules.
   * This is the equivalent of the proposed `/taste reset` command.
   *
   * @returns Number of rules that were removed
   */
  reset(): number {
    const before = this.data.rules.length;
    this.data.rules = this.data.rules.filter((r) => r.source !== 'auto');
    const removed = before - this.data.rules.length;

    if (removed > 0) {
      logger.info({ removed, remaining: this.data.rules.length }, 'Auto-detected taste rules reset');
    }

    return removed;
  }

  /**
   * Clear all taste rules (including manual and CLAUDE.md-sourced).
   *
   * @returns Number of rules that were removed
   */
  clearAll(): number {
    const count = this.data.rules.length;
    this.data.rules = [];
    logger.info({ count }, 'All taste rules cleared');
    return count;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Prompt Formatting
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Format taste rules as a prompt section for agent injection.
   *
   * Returns an empty string if no rules exist.
   * Rules are grouped by category with correction count annotations.
   *
   * @returns Formatted prompt section, or empty string if no rules
   *
   * @example
   * ```
   * [User Taste Preferences - auto-learned]
   *
   * **代码风格:**
   * - 使用 const/let，禁止 var (纠正 3 次)
   * - 函数名使用 camelCase (纠正 2 次)
   *
   * **交互习惯:**
   * - 回复简洁，先结论后分析 (纠正 1 次)
   * ```
   */
  formatForPrompt(): string {
    const rules = this.getRules();
    if (rules.length === 0) {
      return '';
    }

    // Group by category
    const grouped = new Map<TasteCategory, TasteRule[]>();
    for (const rule of rules) {
      const existing = grouped.get(rule.category) ?? [];
      existing.push(rule);
      grouped.set(rule.category, existing);
    }

    const lines: string[] = [
      '',
      '---',
      '',
      '## User Taste Preferences',
      '',
      'The following preferences were auto-learned from the user\'s repeated corrections. Follow them strictly.',
      '',
    ];

    for (const [category, categoryRules] of grouped) {
      const label = TASTE_CATEGORY_LABELS[category] ?? category;
      lines.push(`**${label}:**`);

      for (const rule of categoryRules) {
        const sourceTag = rule.source === 'claude_md' ? '(来自 CLAUDE.md)' : '';
        const countTag = rule.correctionCount > 0 ? `(纠正 ${rule.correctionCount} 次)` : '(手动设置)';
        lines.push(`- ${rule.description} ${countTag}${sourceTag}`);
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Internal Helpers
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Find a rule by exact description match (case-insensitive).
   */
  private findRuleByDescription(description: string): TasteRule | undefined {
    const lower = description.toLowerCase();
    return this.data.rules.find((r) => r.description.toLowerCase() === lower);
  }

  /**
   * Find a similar rule using fuzzy matching.
   *
   * Uses case-insensitive comparison and checks if either string
   * contains the other (substring match) for basic similarity.
   */
  private findSimilarRule(description: string): TasteRule | undefined {
    const lower = description.toLowerCase().trim();

    // 1. Exact match (case-insensitive)
    const exact = this.data.rules.find(
      (r) => r.description.toLowerCase().trim() === lower
    );
    if (exact) return exact;

    // 2. Substring match — new description contains existing or vice versa
    const substring = this.data.rules.find((r) => {
      const ruleLower = r.description.toLowerCase().trim();
      return lower.includes(ruleLower) || ruleLower.includes(lower);
    });
    if (substring) return substring;

    // 3. Word overlap — at least 60% of words overlap
    const newWords = new Set(lower.split(/\s+/));
    let bestOverlap = 0;
    let bestRule: TasteRule | undefined;

    for (const rule of this.data.rules) {
      const ruleWords = new Set(rule.description.toLowerCase().trim().split(/\s+/));
      let overlap = 0;
      for (const word of newWords) {
        if (ruleWords.has(word)) overlap++;
      }
      const overlapRatio = overlap / Math.max(newWords.size, ruleWords.size);
      if (overlapRatio >= 0.6 && overlapRatio > bestOverlap) {
        bestOverlap = overlapRatio;
        bestRule = rule;
      }
    }

    return bestRule;
  }
}
