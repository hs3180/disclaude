/**
 * TasteReader — reads/writes user taste preferences from/to persistent storage.
 *
 * Manages the taste.json file in the workspace .disclaude directory,
 * providing atomic read/write operations and validation.
 *
 * Phase 1: Workspace-level taste (all chatIds share the same taste).
 * Future: Per-project taste when project system is fully merged.
 *
 * @see Issue #2335 (parent — auto-summarize user taste)
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TasteFile, TasteRule, TasteResult } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TasteReader');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Maximum number of taste rules to keep (prevents unbounded growth) */
const MAX_RULES = 50;

/** Maximum length of a single rule description */
const MAX_RULE_LENGTH = 200;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteReader
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Reads and writes user taste preferences from/to persistent storage.
 *
 * Usage:
 * ```typescript
 * const reader = new TasteReader({ workspaceDir: '/path/to/workspace' });
 *
 * // Read all taste rules
 * const result = reader.read();
 * if (result.ok) {
 *   console.log(result.data.rules);
 * }
 *
 * // Format rules for agent prompt injection
 * const prompt = reader.formatTasteForPrompt();
 * ```
 */
export class TasteReader {
  private readonly dataDir: string;
  private readonly persistPath: string;
  private readonly persistTmpPath: string;

  constructor(options: { workspaceDir: string }) {
    this.dataDir = join(options.workspaceDir, '.disclaude');
    this.persistPath = join(this.dataDir, 'taste.json');
    this.persistTmpPath = join(this.dataDir, 'taste.json.tmp');
  }

  // ───────────────────────────────────────────
  // Read Operations
  // ───────────────────────────────────────────

  /**
   * Read all taste rules from persistent storage.
   *
   * Returns an empty array if the file doesn't exist (first run).
   * Returns an error for corrupted/invalid files.
   *
   * @returns TasteResult with TasteFile on success
   */
  read(): TasteResult<TasteFile> {
    if (!existsSync(this.persistPath)) {
      // First run — no taste data yet
      return {
        ok: true,
        data: {
          version: 1,
          rules: [],
          updatedAt: new Date().toISOString(),
        },
      };
    }

    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as unknown;

      if (!this.validateSchema(data)) {
        logger.warn('taste.json schema invalid, returning empty state');
        return {
          ok: true,
          data: {
            version: 1,
            rules: [],
            updatedAt: new Date().toISOString(),
          },
        };
      }

      const file = data as TasteFile;
      return { ok: true, data: file };
    } catch (err) {
      // Corrupted file — don't crash, return empty state gracefully
      logger.warn({ err }, 'Failed to read taste.json, returning empty state');
      return {
        ok: true,
        data: {
          version: 1,
          rules: [],
          updatedAt: new Date().toISOString(),
        },
      };
    }
  }

  // ───────────────────────────────────────────
  // Write Operations
  // ───────────────────────────────────────────

  /**
   * Write taste rules to persistent storage using atomic write.
   *
   * Truncates to MAX_RULES if necessary.
   *
   * @param rules - Array of taste rules to persist
   * @returns TasteResult indicating success or failure
   */
  write(rules: TasteRule[]): TasteResult<void> {
    // Truncate if exceeding limit (keep most recently seen)
    const truncated = rules.length > MAX_RULES
      ? [...rules]
          .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
          .slice(0, MAX_RULES)
      : rules;

    const data: TasteFile = {
      version: 1,
      rules: truncated,
      updatedAt: new Date().toISOString(),
    };

    try {
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      const json = JSON.stringify(data, null, 2);
      writeFileSync(this.persistTmpPath, json, 'utf8');

      try {
        renameSync(this.persistTmpPath, this.persistPath);
      } catch (renameErr) {
        try { unlinkSync(this.persistTmpPath); } catch { /* ignore */ }
        return {
          ok: false,
          error: `写入 taste.json 失败: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
        };
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `持久化 taste 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Clear all taste rules.
   *
   * @returns TasteResult indicating success or failure
   */
  clear(): TasteResult<void> {
    return this.write([]);
  }

  // ───────────────────────────────────────────
  // Prompt Formatting
  // ───────────────────────────────────────────

  /**
   * Format taste rules as a prompt section for agent injection.
   *
   * Returns an empty string if no taste rules exist.
   * Groups rules by category for organized presentation.
   *
   * @returns Formatted string for agent prompt, or empty string
   */
  formatTasteForPrompt(): string {
    const result = this.read();
    if (!result.ok || result.data.rules.length === 0) {
      return '';
    }

    const { rules } = result.data;

    // Group by category
    const grouped = new Map<string, TasteRule[]>();
    for (const rule of rules) {
      const existing = grouped.get(rule.category) ?? [];
      existing.push(rule);
      grouped.set(rule.category, existing);
    }

    const categoryLabels: Record<string, string> = {
      code_style: '代码风格',
      interaction: '交互偏好',
      technical: '技术选择',
      project_norm: '项目规范',
      general: '其他偏好',
    };

    const lines: string[] = [];

    for (const [category, categoryRules] of grouped) {
      const label = categoryLabels[category] ?? category;
      lines.push(`**${label}**:`);
      for (const rule of categoryRules) {
        const countInfo = rule.source === 'auto' ? `（被纠正 ${rule.count} 次）` : '';
        const sourceInfo = rule.source === 'claude_md' ? '（来自 CLAUDE.md）' : '';
        lines.push(`- ${rule.rule}${countInfo}${sourceInfo}`);
      }
    }

    return [
      '',
      '---',
      '',
      '## User Taste — Auto-learned Preferences',
      '',
      'The following preferences were automatically detected from your interaction history. Follow them strictly.',
      '',
      ...lines,
      '',
      '---',
    ].join('\n');
  }

  // ───────────────────────────────────────────
  // Getters
  // ───────────────────────────────────────────

  /**
   * Get the persist file path (for testing/debugging).
   */
  getPersistPath(): string {
    return this.persistPath;
  }

  // ───────────────────────────────────────────
  // Validation
  // ───────────────────────────────────────────

  /**
   * Validate the top-level schema of persisted taste data.
   */
  private validateSchema(data: unknown): data is TasteFile {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const obj = data as Record<string, unknown>;

    // Check version
    if (obj.version !== 1) {
      return false;
    }

    // Check rules array
    if (!Array.isArray(obj.rules)) {
      return false;
    }

    // Validate each rule (lenient — skip invalid ones at read time)
    for (const rule of obj.rules as unknown[]) {
      if (typeof rule !== 'object' || rule === null) {
        return false;
      }
      const r = rule as Record<string, unknown>;
      if (typeof r.rule !== 'string' || r.rule.length === 0 || r.rule.length > MAX_RULE_LENGTH) {
        return false;
      }
      if (typeof r.category !== 'string') {
        return false;
      }
      if (typeof r.source !== 'string') {
        return false;
      }
      if (typeof r.count !== 'number') {
        return false;
      }
      if (typeof r.lastSeen !== 'string' || r.lastSeen.length === 0) {
        return false;
      }
    }

    return true;
  }
}
