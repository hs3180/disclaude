/**
 * TasteManager — core in-memory + persistent logic for user taste management.
 *
 * Manages per-chatId user preferences (taste) that are automatically learned
 * from user corrections and manually configured rules.
 *
 * Persistence:
 * - Per-chatId: `{workspace}/.disclaude/taste/{chatId}.json`
 * - Global fallback: `{workspace}/.disclaude/taste/_global.json`
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
import type {
  AddTasteOptions,
  TasteEntry,
  TasteCategory,
  TasteFile,
  TasteFilter,
  TasteManagerOptions,
  TasteResult,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Current schema version */
const SCHEMA_VERSION = 1;

/** Maximum rules per chatId */
const MAX_RULES_PER_CHAT = 100;

/** Maximum rule description length */
const MAX_RULE_LENGTH = 500;

/** Characters forbidden in chatId (path traversal protection) */
const FORBIDDEN_CHATID_CHARS = /[\x00\\/]/;

/** ID generation counter for uniqueness within a process */
let idCounter = 0;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages user taste rules — per-chatId persistent preferences.
 *
 * Lifecycle:
 * 1. Construct with `TasteManagerOptions`
 * 2. Use `add()`, `list()`, `remove()`, `update()` to manage taste rules
 * 3. Use `getFormattedTaste()` to get formatted taste for Agent prompt injection
 * 4. Persistence is automatic after each mutation
 */
export class TasteManager {
  private readonly workspaceDir: string;
  private readonly dataDir: string;
  private readonly tasteDir: string;

  /** In-memory cache: chatId → TasteFile */
  private cache: Map<string, TasteFile> = new Map();

  constructor(options: TasteManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.dataDir = join(options.workspaceDir, '.disclaude');
    this.tasteDir = join(this.dataDir, 'taste');
  }

  // ───────────────────────────────────────────
  // Core CRUD Operations
  // ───────────────────────────────────────────

  /**
   * Add a new taste rule for a chatId.
   *
   * If a similar rule already exists (exact match on `rule` text),
   * increments the correction count instead of creating a duplicate.
   *
   * @param chatId - Chat session identifier
   * @param options - Taste entry details
   * @returns TasteResult with the created or updated TasteEntry
   */
  add(chatId: string, options: AddTasteOptions): TasteResult<TasteEntry> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    const ruleError = this.validateRule(options.rule);
    if (ruleError) {
      return { ok: false, error: ruleError };
    }

    const file = this.loadTasteFile(chatId);

    // Check for duplicate rule (exact match)
    const existing = file.entries.find(
      (e) => e.rule.toLowerCase() === options.rule.toLowerCase()
    );
    if (existing) {
      existing.correctionCount += options.correctionCount ?? 1;
      existing.lastSeen = new Date().toISOString();
      existing.source = options.source ?? existing.source;
      existing.category = options.category ?? existing.category;
      this.saveTasteFile(chatId, file);
      return { ok: true, data: existing };
    }

    // Check max rules limit
    if (file.entries.length >= MAX_RULES_PER_CHAT) {
      return {
        ok: false,
        error: `已达到最大规则数量限制 (${MAX_RULES_PER_CHAT})`,
      };
    }

    const entry: TasteEntry = {
      id: this.generateId(),
      rule: options.rule.trim(),
      category: options.category ?? 'other',
      source: options.source ?? 'manual',
      correctionCount: options.correctionCount ?? 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };

    file.entries.push(entry);
    this.updateMeta(file);
    this.saveTasteFile(chatId, file);

    return { ok: true, data: entry };
  }

  /**
   * List taste rules for a chatId, optionally filtered.
   *
   * Returns entries sorted by correction count (highest first),
   * then by lastSeen (most recent first).
   *
   * @param chatId - Chat session identifier
   * @param filter - Optional filter criteria
   * @returns TasteResult with filtered TasteEntry array
   */
  list(chatId: string, filter?: TasteFilter): TasteResult<TasteEntry[]> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    const file = this.loadTasteFile(chatId);
    let {entries} = file;

    if (filter) {
      if (filter.category) {
        entries = entries.filter((e) => e.category === filter.category);
      }
      if (filter.source) {
        entries = entries.filter((e) => e.source === filter.source);
      }
      if (filter.minCorrections !== undefined) {
        const {minCorrections} = filter;
        entries = entries.filter(
          (e) => e.correctionCount >= minCorrections
        );
      }
    }

    // Sort by correction count desc, then lastSeen desc
    entries.sort((a, b) => {
      if (b.correctionCount !== a.correctionCount) {
        return b.correctionCount - a.correctionCount;
      }
      return b.lastSeen.localeCompare(a.lastSeen);
    });

    return { ok: true, data: entries };
  }

  /**
   * Remove a taste rule by ID.
   *
   * @param chatId - Chat session identifier
   * @param id - Taste entry ID to remove
   * @returns TasteResult indicating success or failure
   */
  remove(chatId: string, id: string): TasteResult<void> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    const file = this.loadTasteFile(chatId);
    const index = file.entries.findIndex((e) => e.id === id);

    if (index === -1) {
      return { ok: false, error: `规则 "${id}" 不存在` };
    }

    file.entries.splice(index, 1);
    this.updateMeta(file);
    this.saveTasteFile(chatId, file);

    return { ok: true, data: undefined };
  }

  /**
   * Update an existing taste rule.
   *
   * @param chatId - Chat session identifier
   * @param id - Taste entry ID to update
   * @param updates - Partial updates to apply
   * @returns TasteResult with the updated TasteEntry
   */
  update(
    chatId: string,
    id: string,
    updates: Partial<Pick<TasteEntry, 'rule' | 'category'>>
  ): TasteResult<TasteEntry> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    if (updates.rule !== undefined) {
      const ruleError = this.validateRule(updates.rule);
      if (ruleError) {
        return { ok: false, error: ruleError };
      }
    }

    const file = this.loadTasteFile(chatId);
    const entry = file.entries.find((e) => e.id === id);

    if (!entry) {
      return { ok: false, error: `规则 "${id}" 不存在` };
    }

    if (updates.rule !== undefined) {
      entry.rule = updates.rule.trim();
    }
    if (updates.category !== undefined) {
      entry.category = updates.category;
    }

    this.updateMeta(file);
    this.saveTasteFile(chatId, file);

    return { ok: true, data: entry };
  }

  /**
   * Reset (clear) all taste rules for a chatId.
   *
   * @param chatId - Chat session identifier
   * @returns TasteResult indicating success
   */
  reset(chatId: string): TasteResult<void> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    const file = this.createEmptyFile(chatId);
    this.saveTasteFile(chatId, file);

    return { ok: true, data: undefined };
  }

  // ───────────────────────────────────────────
  // Query for Agent Prompt
  // ───────────────────────────────────────────

  /**
   * Get formatted taste rules for Agent prompt injection.
   *
   * Returns a human-readable summary of taste rules, grouped by category,
   * sorted by weight (correction count). Only returns rules from the
   * specified chatId.
   *
   * Returns empty string if no rules exist.
   *
   * @param chatId - Chat session identifier
   * @returns Formatted taste section for prompt injection
   */
  getFormattedTaste(chatId: string): string {
    const result = this.list(chatId);
    if (!result.ok || result.data.length === 0) {
      return '';
    }

    const entries = result.data;
    const categoryLabels: Record<TasteCategory, string> = {
      code_style: '代码风格',
      interaction: '交互偏好',
      tech_preference: '技术选择',
      project_convention: '项目规范',
      other: '其他偏好',
    };

    // Group by category
    const grouped = new Map<TasteCategory, TasteEntry[]>();
    for (const entry of entries) {
      const group = grouped.get(entry.category) ?? [];
      group.push(entry);
      grouped.set(entry.category, group);
    }

    const lines: string[] = ['[User Preferences — auto-learned from your corrections]'];

    for (const [category, categoryEntries] of grouped) {
      const label = categoryLabels[category] ?? category;
      lines.push('');
      lines.push(`**${label}**:`);
      for (const entry of categoryEntries) {
        const sourceLabel = entry.source === 'auto' ? '自动学习' : entry.source === 'manual' ? '手动添加' : '来自CLAUDE.md';
        const weightLabel = entry.correctionCount >= 3 ? '（严格遵守）' : entry.correctionCount >= 2 ? '' : '';
        lines.push(`  - ${entry.rule}${weightLabel} [${sourceLabel}, 被纠正${entry.correctionCount}次]`);
      }
    }

    return lines.join('\n');
  }

  // ───────────────────────────────────────────
  // Internal: File I/O
  // ───────────────────────────────────────────

  /**
   * Load a TasteFile for a chatId (from cache or disk).
   */
  private loadTasteFile(chatId: string): TasteFile {
    // Check cache first
    const cached = this.cache.get(chatId);
    if (cached) {
      return cached;
    }

    // Try to load from disk
    const filePath = this.getTasteFilePath(chatId);
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw) as unknown;

        if (this.validateFileSchema(data)) {
          const file = data as TasteFile;
          this.cache.set(chatId, file);
          return file;
        }
      } catch {
        // Corrupted file — start fresh
      }
    }

    // Create empty file
    const file = this.createEmptyFile(chatId);
    this.cache.set(chatId, file);
    return file;
  }

  /**
   * Save a TasteFile to disk using atomic write-then-rename.
   */
  private saveTasteFile(chatId: string, file: TasteFile): void {
    // Update cache
    this.cache.set(chatId, file);

    try {
      // Ensure directory exists
      if (!existsSync(this.tasteDir)) {
        mkdirSync(this.tasteDir, { recursive: true });
      }

      const filePath = this.getTasteFilePath(chatId);
      const tmpPath = `${filePath  }.tmp`;

      const json = JSON.stringify(file, null, 2);
      writeFileSync(tmpPath, json, 'utf8');

      try {
        renameSync(tmpPath, filePath);
      } catch (renameErr) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup failure
        }
        throw renameErr;
      }
    } catch (err) {
      // Log but don't throw — taste persistence is non-critical
      const message = err instanceof Error ? err.message : String(err);
      // In production, this would use the logger. For now, silently continue.
      void message;
    }
  }

  /**
   * Get the file path for a chatId's taste data.
   */
  private getTasteFilePath(chatId: string): string {
    // Sanitize chatId for use as filename
    const safeName = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.tasteDir, `${safeName}.json`);
  }

  // ───────────────────────────────────────────
  // Internal: Validation
  // ───────────────────────────────────────────

  /**
   * Validate a chatId.
   */
  private validateChatId(chatId: string): string | null {
    if (!chatId || chatId.length === 0) {
      return 'chatId 不能为空';
    }
    if (FORBIDDEN_CHATID_CHARS.test(chatId)) {
      return 'chatId 包含非法字符';
    }
    if (chatId === '..' || chatId.includes('..')) {
      return 'chatId 不能包含 ".."';
    }
    return null;
  }

  /**
   * Validate a taste rule description.
   */
  private validateRule(rule: string): string | null {
    if (!rule || rule.trim().length === 0) {
      return '规则描述不能为空';
    }
    if (rule.length > MAX_RULE_LENGTH) {
      return `规则描述不能超过 ${MAX_RULE_LENGTH} 个字符`;
    }
    return null;
  }

  /**
   * Validate the top-level schema of a TasteFile.
   */
  private validateFileSchema(data: unknown): data is TasteFile {
    if (typeof data !== 'object' || data === null) {return false;}
    const obj = data as Record<string, unknown>;
    if (typeof obj.version !== 'number') {return false;}
    if (!Array.isArray(obj.entries)) {return false;}
    if (typeof obj.meta !== 'object' || obj.meta === null) {return false;}
    return true;
  }

  // ───────────────────────────────────────────
  // Internal: Helpers
  // ───────────────────────────────────────────

  /**
   * Create an empty TasteFile.
   */
  private createEmptyFile(chatId: string): TasteFile {
    return {
      version: SCHEMA_VERSION,
      chatId,
      entries: [],
      meta: {
        updatedAt: new Date().toISOString(),
        totalRules: 0,
        version: SCHEMA_VERSION,
      },
    };
  }

  /**
   * Update metadata after mutation.
   */
  private updateMeta(file: TasteFile): void {
    file.meta.updatedAt = new Date().toISOString();
    file.meta.totalRules = file.entries.length;
  }

  /**
   * Generate a unique ID for a taste entry.
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const counter = (++idCounter).toString(36);
    const random = Math.random().toString(36).slice(2, 6);
    return `t_${timestamp}_${counter}_${random}`;
  }

  // ───────────────────────────────────────────
  // Testing Support
  // ───────────────────────────────────────────

  /**
   * Get the taste directory path (for testing).
   */
  getTasteDir(): string {
    return this.tasteDir;
  }

  /**
   * Clear the in-memory cache (for testing).
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get a taste file path for a chatId (for testing).
   */
  getFilePath(chatId: string): string {
    return this.getTasteFilePath(chatId);
  }
}
