/**
 * TasteManager — per-project user preference (taste) tracking.
 *
 * Manages taste entries that capture user preferences discovered
 * through interactions, such as code style, interaction habits,
 * and technical choices.
 *
 * Storage pattern: `{workspace}/projects/{projectName}/taste.json`
 * Uses atomic write-then-rename for safe persistence (same as ProjectManager).
 *
 * Lifecycle:
 * 1. Construct with `TasteManagerOptions`
 * 2. Call `load(projectName)` to restore from disk (optional — graceful no-op if absent)
 * 3. Use `addEntry()`, `removeEntry()`, `reinforce()` to manage entries
 * 4. Call `toPromptText(projectName)` to generate Agent context prompt
 * 5. All mutations auto-persist
 *
 * @see Issue #2335 (auto-summarize user taste to avoid repeated corrections)
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
import type { ProjectResult } from './types.js';
import type {
  TasteCategory,
  TasteEntry,
  TasteManagerOptions,
  TastePersistData,
} from './taste-types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Current schema version for taste data */
const TASTE_SCHEMA_VERSION = 1;

/** Maximum taste entries per category */
const MAX_ENTRIES_PER_CATEGORY = 50;

/** Maximum rule text length */
const MAX_RULE_LENGTH = 500;

/** Valid taste categories */
const VALID_CATEGORIES: ReadonlySet<string> = new Set<string>([
  'code_style',
  'interaction',
  'technical',
  'project_norms',
  'custom',
]);

/** Valid taste sources */
const VALID_SOURCES: ReadonlySet<string> = new Set<string>([
  'auto',
  'claude_md',
  'manual',
]);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages per-project user taste (preference) entries.
 *
 * Follows the same patterns as ProjectManager:
 * - In-memory state with atomic JSON persistence
 * - Graceful handling of missing/corrupted files
 * - Auto-persist on mutations
 */
export class TasteManager {
  private readonly workspaceDir: string;

  /**
   * In-memory taste data cache: projectName → category → entries.
   * Loaded lazily or explicitly via load().
   */
  private readonly cache: Map<string, Map<string, TasteEntry[]>> = new Map();

  constructor(options: TasteManagerOptions) {
    this.workspaceDir = options.workspaceDir;
  }

  // ───────────────────────────────────────────
  // Core CRUD
  // ───────────────────────────────────────────

  /**
   * Add a taste entry for a project.
   *
   * If an identical rule already exists in the same category,
   * the existing entry is reinforced instead (count + 1).
   *
   * @param projectName - Project instance name
   * @param entry - Taste entry without auto-managed fields
   * @returns ProjectResult with the added or reinforced TasteEntry
   */
  addEntry(
    projectName: string,
    entry: Omit<TasteEntry, 'count' | 'lastSeen'>,
  ): ProjectResult<TasteEntry> {
    const nameError = this.validateProjectName(projectName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const ruleError = this.validateRule(entry.rule);
    if (ruleError) {
      return { ok: false, error: ruleError };
    }

    const categoryError = this.validateCategory(entry.category);
    if (categoryError) {
      return { ok: false, error: categoryError };
    }

    const sourceError = this.validateSource(entry.source);
    if (sourceError) {
      return { ok: false, error: sourceError };
    }

    const projectEntries = this.getOrCreateProjectEntries(projectName);
    const categoryKey = this.resolveCategoryKey(entry);
    const entries = this.getOrCreateCategory(projectEntries, categoryKey);

    // Check for duplicate rule (case-insensitive match)
    const normalizedRule = entry.rule.trim().toLowerCase();
    const existingIndex = entries.findIndex(
      (e) => e.rule.trim().toLowerCase() === normalizedRule,
    );

    if (existingIndex >= 0) {
      // Reinforce existing entry
      const existing = entries[existingIndex];
      existing.count += 1;
      existing.lastSeen = new Date().toISOString();
      this.persist(projectName);
      return { ok: true, data: existing };
    }

    // Check capacity
    if (entries.length >= MAX_ENTRIES_PER_CATEGORY) {
      return {
        ok: false,
        error: `类别 "${categoryKey}" 已达到最大条目数 (${MAX_ENTRIES_PER_CATEGORY})`,
      };
    }

    const newEntry: TasteEntry = {
      rule: entry.rule.trim(),
      category: entry.category,
      source: entry.source,
      count: 1,
      lastSeen: new Date().toISOString(),
      customCategory: entry.customCategory,
    };

    entries.push(newEntry);
    this.persist(projectName);
    return { ok: true, data: newEntry };
  }

  /**
   * Remove a specific taste entry by category and index.
   *
   * @param projectName - Project instance name
   * @param category - Category to remove from
   * @param index - Index within the category's entry list
   * @returns ProjectResult indicating success or failure
   */
  removeEntry(
    projectName: string,
    category: TasteCategory,
    index: number,
  ): ProjectResult<void> {
    const nameError = this.validateProjectName(projectName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const projectEntries = this.cache.get(projectName);
    if (!projectEntries) {
      return { ok: false, error: `项目 "${projectName}" 没有偏好数据` };
    }

    const categoryKey = category === 'custom' ? category : category;
    const entries = projectEntries.get(categoryKey);
    if (!entries) {
      return { ok: false, error: `类别 "${categoryKey}" 不存在` };
    }

    if (index < 0 || index >= entries.length) {
      return {
        ok: false,
        error: `索引 ${index} 超出范围 (0-${entries.length - 1})`,
      };
    }

    entries.splice(index, 1);

    // Clean up empty category
    if (entries.length === 0) {
      projectEntries.delete(categoryKey);
    }

    // Clean up empty project
    if (projectEntries.size === 0) {
      this.cache.delete(projectName);
    }

    this.persist(projectName);
    return { ok: true, data: undefined };
  }

  /**
   * List all taste entries for a project.
   *
   * @param projectName - Project instance name
   * @param category - Optional category filter
   * @returns Array of TasteEntry (sorted by count descending)
   */
  listEntries(projectName: string, category?: TasteCategory): TasteEntry[] {
    const projectEntries = this.cache.get(projectName);
    if (!projectEntries) {
      return [];
    }

    if (category) {
      const categoryKey = category;
      return [...(projectEntries.get(categoryKey) || [])].sort(
        (a, b) => b.count - a.count,
      );
    }

    // Return all entries sorted by count
    const allEntries: TasteEntry[] = [];
    for (const entries of projectEntries.values()) {
      allEntries.push(...entries);
    }
    return allEntries.sort((a, b) => b.count - a.count);
  }

  /**
   * Reinforce an existing taste entry.
   *
   * Increments the count and updates lastSeen timestamp.
   *
   * @param projectName - Project instance name
   * @param category - Category of the entry
   * @param ruleIndex - Index within the category
   * @returns ProjectResult with the updated TasteEntry
   */
  reinforce(
    projectName: string,
    category: TasteCategory,
    ruleIndex: number,
  ): ProjectResult<TasteEntry> {
    const nameError = this.validateProjectName(projectName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const projectEntries = this.cache.get(projectName);
    if (!projectEntries) {
      return { ok: false, error: `项目 "${projectName}" 没有偏好数据` };
    }

    const entries = projectEntries.get(category);
    if (!entries) {
      return { ok: false, error: `类别 "${category}" 不存在` };
    }

    if (ruleIndex < 0 || ruleIndex >= entries.length) {
      return {
        ok: false,
        error: `索引 ${ruleIndex} 超出范围 (0-${entries.length - 1})`,
      };
    }

    const entry = entries[ruleIndex];
    entry.count += 1;
    entry.lastSeen = new Date().toISOString();

    this.persist(projectName);
    return { ok: true, data: entry };
  }

  /**
   * Clear all taste entries for a project.
   *
   * @param projectName - Project instance name
   * @returns ProjectResult indicating success or failure
   */
  clear(projectName: string): ProjectResult<void> {
    const nameError = this.validateProjectName(projectName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    this.cache.delete(projectName);
    this.persist(projectName);
    return { ok: true, data: undefined };
  }

  // ───────────────────────────────────────────
  // Prompt Generation
  // ───────────────────────────────────────────

  /**
   * Generate prompt text for Agent context injection.
   *
   * Returns a formatted string listing all taste rules for a project,
   * grouped by category with correction counts.
   * Returns empty string if no taste data exists.
   *
   * @param projectName - Project instance name
   * @returns Formatted prompt text for system prompt injection
   */
  toPromptText(projectName: string): string {
    const projectEntries = this.cache.get(projectName);
    if (!projectEntries || projectEntries.size === 0) {
      return '';
    }

    const allEntries = this.listEntries(projectName);
    if (allEntries.length === 0) {
      return '';
    }

    const categoryLabels: Record<string, string> = {
      code_style: '代码风格',
      interaction: '交互偏好',
      technical: '技术选择',
      project_norms: '项目规范',
      custom: '自定义',
    };

    // Group by category
    const grouped = new Map<string, TasteEntry[]>();
    for (const entry of allEntries) {
      const key =
        entry.category === 'custom' && entry.customCategory
          ? entry.customCategory
          : categoryLabels[entry.category] || entry.category;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      const group = grouped.get(key);
      if (group) {
        group.push(entry);
      }
    }

    const lines: string[] = ['[Project Taste — 用户偏好，请务必遵循]'];
    for (const [categoryLabel, entries] of grouped) {
      lines.push('');
      lines.push(`**${categoryLabel}**:`);
      for (const entry of entries) {
        const source =
          entry.source === 'auto'
            ? `（被纠正 ${entry.count} 次）`
            : entry.source === 'claude_md'
              ? '（来自 CLAUDE.md）'
              : '（手动添加）';
        lines.push(`  - ${entry.rule} ${source}`);
      }
    }

    return lines.join('\n');
  }

  // ───────────────────────────────────────────
  // Persistence
  // ───────────────────────────────────────────

  /**
   * Persist taste data for a project to disk.
   *
   * Uses atomic write-then-rename pattern.
   * If no entries exist, the taste file is deleted.
   *
   * @param projectName - Project instance name
   * @returns ProjectResult indicating success or failure
   */
  persist(projectName: string): ProjectResult<void> {
    const projectDir = this.resolveProjectDir(projectName);
    const tastePath = join(projectDir, 'taste.json');
    const tasteTmpPath = join(projectDir, 'taste.json.tmp');

    const projectEntries = this.cache.get(projectName);

    // If no entries, delete the taste file
    if (!projectEntries || projectEntries.size === 0) {
      if (existsSync(tastePath)) {
        try {
          unlinkSync(tastePath);
        } catch {
          // Ignore deletion failure
        }
      }
      return { ok: true, data: undefined };
    }

    try {
      // Ensure project directory exists
      if (!existsSync(projectDir)) {
        mkdirSync(projectDir, { recursive: true });
      }

      const data: TastePersistData = {
        version: TASTE_SCHEMA_VERSION,
        entries: {},
      };

      for (const [category, entries] of projectEntries.entries()) {
        if (entries.length > 0) {
          data.entries[category] = entries;
        }
      }

      const json = JSON.stringify(data, null, 2);
      writeFileSync(tasteTmpPath, json, 'utf8');

      try {
        renameSync(tasteTmpPath, tastePath);
      } catch (renameErr) {
        try {
          unlinkSync(tasteTmpPath);
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
   * Load taste data for a project from disk.
   *
   * Gracefully handles:
   * - File not found (first run) → no-op
   * - Invalid JSON → skip
   * - Invalid schema → skip invalid entries
   *
   * @param projectName - Project instance name
   * @returns ProjectResult indicating success or failure
   */
  load(projectName: string): ProjectResult<void> {
    const nameError = this.validateProjectName(projectName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const tastePath = join(this.resolveProjectDir(projectName), 'taste.json');

    if (!existsSync(tastePath)) {
      return { ok: true, data: undefined };
    }

    try {
      const raw = readFileSync(tastePath, 'utf8');
      const data = JSON.parse(raw) as unknown;

      if (!this.validatePersistSchema(data)) {
        return { ok: false, error: 'taste.json 格式无效，已跳过恢复' };
      }

      const persisted = data as TastePersistData;
      const projectEntries = new Map<string, TasteEntry[]>();

      for (const [category, entries] of Object.entries(persisted.entries)) {
        if (!Array.isArray(entries)) {
          continue;
        }

        const validEntries: TasteEntry[] = [];
        for (const entry of entries) {
          if (this.isValidTasteEntry(entry)) {
            validEntries.push(entry);
          }
        }

        if (validEntries.length > 0) {
          projectEntries.set(category, validEntries);
        }
      }

      if (projectEntries.size > 0) {
        this.cache.set(projectName, projectEntries);
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
   * Get the taste file path for a project (for testing/debugging).
   *
   * @param projectName - Project instance name
   * @returns Absolute path to taste.json
   */
  getTastePath(projectName: string): string {
    return join(this.resolveProjectDir(projectName), 'taste.json');
  }

  // ───────────────────────────────────────────
  // Internal Helpers
  // ───────────────────────────────────────────

  /**
   * Resolve the project directory for taste storage.
   *
   * Pattern: `{workspace}/projects/{projectName}/`
   */
  private resolveProjectDir(projectName: string): string {
    const ws = this.workspaceDir.replace(/\/+$/, '');
    return `${ws}/projects/${projectName}`;
  }

  /**
   * Get or create the entry map for a project.
   */
  private getOrCreateProjectEntries(
    projectName: string,
  ): Map<string, TasteEntry[]> {
    let entries = this.cache.get(projectName);
    if (!entries) {
      entries = new Map();
      this.cache.set(projectName, entries);
    }
    return entries;
  }

  /**
   * Get or create the entry array for a category within a project.
   */
  private getOrCreateCategory(
    projectEntries: Map<string, TasteEntry[]>,
    categoryKey: string,
  ): TasteEntry[] {
    let entries = projectEntries.get(categoryKey);
    if (!entries) {
      entries = [];
      projectEntries.set(categoryKey, entries);
    }
    return entries;
  }

  /**
   * Resolve the storage key for a category.
   *
   * Custom categories use customCategory as the key if provided.
   */
  private resolveCategoryKey(
    entry: Omit<TasteEntry, 'count' | 'lastSeen'>,
  ): string {
    if (entry.category === 'custom' && entry.customCategory) {
      return `custom:${entry.customCategory}`;
    }
    return entry.category;
  }

  // ───────────────────────────────────────────
  // Validation
  // ───────────────────────────────────────────

  private validateProjectName(name: string): string | null {
    if (!name || name.length === 0) {
      return '项目名称不能为空';
    }
    if (name === 'default') {
      // default project doesn't have a project directory
      return 'default 项目不支持偏好功能';
    }
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      return '项目名称包含非法字符';
    }
    return null;
  }

  private validateRule(rule: string): string | null {
    if (!rule || rule.trim().length === 0) {
      return '规则文本不能为空';
    }
    if (rule.length > MAX_RULE_LENGTH) {
      return `规则文本不能超过 ${MAX_RULE_LENGTH} 个字符`;
    }
    return null;
  }

  private validateCategory(category: string): string | null {
    if (!VALID_CATEGORIES.has(category)) {
      return `无效的类别: "${category}"`;
    }
    return null;
  }

  private validateSource(source: string): string | null {
    if (!VALID_SOURCES.has(source)) {
      return `无效的来源: "${source}"`;
    }
    return null;
  }

  private validatePersistSchema(data: unknown): data is TastePersistData {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const obj = data as Record<string, unknown>;
    if (typeof obj.entries !== 'object' || obj.entries === null) {
      return false;
    }
    if (Array.isArray(obj.entries)) {
      return false;
    }
    return true;
  }

  private isValidTasteEntry(entry: unknown): entry is TasteEntry {
    if (typeof entry !== 'object' || entry === null) {
      return false;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.rule !== 'string' || e.rule.length === 0) {
      return false;
    }
    if (typeof e.category !== 'string') {
      return false;
    }
    if (typeof e.source !== 'string') {
      return false;
    }
    if (typeof e.count !== 'number' || e.count < 0) {
      return false;
    }
    if (typeof e.lastSeen !== 'string' || e.lastSeen.length === 0) {
      return false;
    }
    return true;
  }
}
