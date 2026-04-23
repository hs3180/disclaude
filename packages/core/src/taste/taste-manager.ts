/**
 * TasteManager — manages per-chatId user preference rules.
 *
 * Stores taste rules in `{workspace}/.disclaude/taste.json` using
 * atomic write-then-rename for crash safety.
 *
 * Usage:
 * 1. Construct with `TasteManagerOptions`
 * 2. Call `loadPersistedData()` or rely on constructor auto-load
 * 3. Use `addRule()`, `removeRule()`, `listRules()`, `resetTaste()`
 *
 * @see Issue #2335 — feat(project): auto-summarize user taste
 */

import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import type {
  ChatTasteData,
  TasteCategory,
  TasteManagerOptions,
  TastePersistData,
  TasteResult,
  TasteRule,
  TasteSource,
} from './types.js';

const logger = createLogger('TasteManager');

/** Maximum rules per chatId to prevent unbounded growth */
const MAX_RULES_PER_CHAT = 100;

/** Minimum correction count before auto-detected rule is promoted */
const AUTO_PROMOTE_THRESHOLD = 2;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class TasteManager {
  private readonly workspaceDir: string;
  private readonly dataDir: string;
  private readonly persistPath: string;
  private readonly persistTmpPath: string;

  /** In-memory taste data: chatId → rules */
  private data: Map<string, ChatTasteData> = new Map();

  /** Auto-incrementing rule ID counter per chatId */
  private ruleIdCounters: Map<string, number> = new Map();

  constructor(options: TasteManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.dataDir = join(options.workspaceDir, '.disclaude');
    this.persistPath = join(this.dataDir, 'taste.json');
    this.persistTmpPath = join(this.dataDir, 'taste.json.tmp');

    this.loadPersistedData();
  }

  // ───────────────────────────────────────────
  // Core CRUD Operations
  // ───────────────────────────────────────────

  /**
   * Add or update a taste rule for a chatId.
   *
   * If a rule with the same `rule` text and `category` already exists,
   * its `correctionCount` and `lastSeen` are updated instead of creating
   * a duplicate.
   *
   * @param chatId - Chat session identifier
   * @param category - Taste category
   * @param rule - Human-readable preference description
   * @param source - Where this rule came from
   * @returns TasteResult with the created/updated TasteRule
   */
  addRule(
    chatId: string,
    category: TasteCategory,
    rule: string,
    source: TasteSource = 'manual',
  ): TasteResult<TasteRule> {
    if (!chatId || chatId.length === 0) {
      return { ok: false, error: 'chatId 不能为空' };
    }
    if (!rule || rule.trim().length === 0) {
      return { ok: false, error: '规则内容不能为空' };
    }

    const chatData = this.getOrCreateChatData(chatId);

    // Check if a similar rule already exists
    const existingRule = chatData.rules.find(
      (r) => r.category === category && r.rule === rule.trim(),
    );

    if (existingRule) {
      // Update existing rule
      existingRule.correctionCount++;
      existingRule.lastSeen = new Date().toISOString();
      existingRule.source = source; // Allow source upgrade
      this.persist();
      logger.info({ chatId, ruleId: existingRule.id, count: existingRule.correctionCount }, 'Updated existing taste rule');
      return { ok: true, data: existingRule };
    }

    // Check limit
    if (chatData.rules.length >= MAX_RULES_PER_CHAT) {
      return { ok: false, error: `每个会话最多 ${MAX_RULES_PER_CHAT} 条偏好规则` };
    }

    // Create new rule
    const newRule: TasteRule = {
      id: this.nextRuleId(chatId),
      category,
      rule: rule.trim(),
      source,
      correctionCount: source === 'auto' ? 1 : 0,
      lastSeen: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    chatData.rules.push(newRule);
    this.persist();

    logger.info({ chatId, ruleId: newRule.id, category }, 'Added new taste rule');
    return { ok: true, data: newRule };
  }

  /**
   * Remove a taste rule by its ID.
   *
   * @param chatId - Chat session identifier
   * @param ruleId - Rule ID to remove (e.g., "r-1")
   * @returns TasteResult indicating success or not found
   */
  removeRule(chatId: string, ruleId: string): TasteResult<void> {
    const chatData = this.data.get(chatId);
    if (!chatData) {
      return { ok: false, error: `会话 ${chatId} 没有偏好规则` };
    }

    const index = chatData.rules.findIndex((r) => r.id === ruleId);
    if (index === -1) {
      return { ok: false, error: `规则 ${ruleId} 不存在` };
    }

    chatData.rules.splice(index, 1);
    if (chatData.rules.length === 0) {
      this.data.delete(chatId);
    }
    this.persist();

    logger.info({ chatId, ruleId }, 'Removed taste rule');
    return { ok: true, data: undefined };
  }

  /**
   * List all taste rules for a chatId.
   *
   * Rules are sorted by correction count (highest first), then by creation time.
   *
   * @param chatId - Chat session identifier
   * @param category - Optional category filter
   * @returns TasteResult with array of TasteRule
   */
  listRules(chatId: string, category?: TasteCategory): TasteResult<TasteRule[]> {
    const chatData = this.data.get(chatId);
    if (!chatData) {
      return { ok: true, data: [] };
    }

    let rules = [...chatData.rules];
    if (category) {
      rules = rules.filter((r) => r.category === category);
    }

    // Sort: highest correction count first, then newest first
    rules.sort((a, b) => {
      if (b.correctionCount !== a.correctionCount) {
        return b.correctionCount - a.correctionCount;
      }
      return b.createdAt.localeCompare(a.createdAt);
    });

    return { ok: true, data: rules };
  }

  /**
   * Reset (clear) all taste rules for a chatId.
   *
   * @param chatId - Chat session identifier
   * @returns TasteResult with the number of removed rules
   */
  resetTaste(chatId: string): TasteResult<number> {
    const chatData = this.data.get(chatId);
    if (!chatData) {
      return { ok: true, data: 0 };
    }

    const count = chatData.rules.length;
    this.data.delete(chatId);
    this.ruleIdCounters.delete(chatId);
    this.persist();

    logger.info({ chatId, removedCount: count }, 'Reset taste rules');
    return { ok: true, data: count };
  }

  /**
   * Get all chatIds that have taste rules.
   *
   * @returns Array of chatIds with taste data
   */
  getChatIds(): string[] {
    return [...this.data.keys()];
  }

  /**
   * Get taste rules formatted for agent prompt injection.
   *
   * Returns a human-readable markdown section listing all active rules,
   * or null if no rules exist for the chatId.
   *
   * Only includes rules that have been corrected at least AUTO_PROMOTE_THRESHOLD
   * times (for auto-detected rules), or all manually-added rules.
   *
   * @param chatId - Chat session identifier
   * @returns Formatted taste section, or null if no active rules
   */
  getTastePromptSection(chatId: string): string | null {
    const result = this.listRules(chatId);
    if (!result.ok || result.data.length === 0) {
      return null;
    }

    // Filter: show manual rules always, auto rules only after threshold
    const activeRules = result.data.filter(
      (r) => r.source === 'manual' || r.source === 'claude_md' || r.correctionCount >= AUTO_PROMOTE_THRESHOLD,
    );

    if (activeRules.length === 0) {
      return null;
    }

    const categoryLabels: Record<TasteCategory, string> = {
      code_style: '代码风格',
      interaction: '交互偏好',
      tech_preference: '技术选择',
      project_norm: '项目规范',
      other: '其他偏好',
    };

    // Group by category
    const grouped = new Map<TasteCategory, TasteRule[]>();
    for (const rule of activeRules) {
      const group = grouped.get(rule.category) ?? [];
      group.push(rule);
      grouped.set(rule.category, group);
    }

    const lines: string[] = [
      '## User Preferences (auto-learned)',
      '',
      'These are the user\'s preferences learned from interactions. **Always follow these rules** without being reminded:',
      '',
    ];

    for (const [cat, rules] of grouped) {
      lines.push(`**${categoryLabels[cat] || cat}:**`);
      for (const r of rules) {
        const sourceTag = r.source === 'auto' ? `（已纠正 ${r.correctionCount} 次）` : '';
        lines.push(`- ${r.rule}${sourceTag}`);
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
   */
  persist(): TasteResult<void> {
    try {
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      const data: TastePersistData = { chats: {} };
      for (const [chatId, chatData] of this.data.entries()) {
        data.chats[chatId] = { rules: chatData.rules };
      }

      const json = JSON.stringify(data, null, 2);
      writeFileSync(this.persistTmpPath, json, 'utf8');

      try {
        renameSync(this.persistTmpPath, this.persistPath);
      } catch (renameErr) {
        try { unlinkSync(this.persistTmpPath); } catch { /* ignore */ }
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
   */
  loadPersistedData(): TasteResult<void> {
    if (!existsSync(this.persistPath)) {
      return { ok: true, data: undefined };
    }

    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;

      if (!this.validateSchema(parsed)) {
        return { ok: false, error: 'taste.json 格式无效，已跳过恢复' };
      }

      const data = parsed as TastePersistData;
      this.data.clear();
      this.ruleIdCounters.clear();

      for (const [chatId, chatData] of Object.entries(data.chats)) {
        if (typeof chatData !== 'object' || chatData === null || !Array.isArray(chatData.rules)) {
          continue;
        }

        const validRules: TasteRule[] = [];
        let maxId = 0;

        for (const rule of chatData.rules) {
          if (this.isValidRule(rule)) {
            validRules.push(rule);
            // Extract counter from rule ID (e.g., "r-5" → 5)
            const idNum = parseInt(rule.id.replace('r-', ''), 10);
            if (!isNaN(idNum) && idNum > maxId) {
              maxId = idNum;
            }
          }
        }

        if (validRules.length > 0) {
          this.data.set(chatId, { rules: validRules });
          this.ruleIdCounters.set(chatId, maxId);
        }
      }

      logger.info({ chatCount: this.data.size }, 'Loaded taste data');
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

  private getOrCreateChatData(chatId: string): ChatTasteData {
    let data = this.data.get(chatId);
    if (!data) {
      data = { rules: [] };
      this.data.set(chatId, data);
    }
    return data;
  }

  private nextRuleId(chatId: string): string {
    const counter = (this.ruleIdCounters.get(chatId) ?? 0) + 1;
    this.ruleIdCounters.set(chatId, counter);
    return `r-${counter}`;
  }

  private validateSchema(data: unknown): data is TastePersistData {
    if (typeof data !== 'object' || data === null) { return false; }
    const obj = data as Record<string, unknown>;
    if (typeof obj.chats !== 'object' || obj.chats === null || Array.isArray(obj.chats)) {
      return false;
    }
    return true;
  }

  private isValidRule(rule: unknown): rule is TasteRule {
    if (typeof rule !== 'object' || rule === null) { return false; }
    const r = rule as Record<string, unknown>;
    return (
      typeof r.id === 'string' &&
      typeof r.category === 'string' &&
      typeof r.rule === 'string' &&
      typeof r.source === 'string' &&
      typeof r.correctionCount === 'number' &&
      typeof r.lastSeen === 'string' &&
      typeof r.createdAt === 'string'
    );
  }
}
