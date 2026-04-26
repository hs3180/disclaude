/**
 * TasteManager — core in-memory + persistent logic for user taste management.
 *
 * Manages user taste (preference) rules in memory with atomic persistence
 * to `{dataDir}/taste.json`.
 *
 * Features:
 * - Add/remove/update taste rules (manual or auto-detected)
 * - Workspace-level and per-project taste scopes
 * - Auto-detection from correction signals (consolidation)
 * - Weight-based priority (correction count as signal)
 * - Atomic persistence with write-then-rename pattern
 *
 * @see Issue #2335 (parent — auto-summarize user taste)
 */

import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  TasteResult,
  TasteEntry,
  TasteCategory,
  TasteSource,
  TasteManagerOptions,
  TastePersistData,
  CorrectionSignal,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Minimum number of correction signals before auto-promoting to a taste rule */
const AUTO_PROMOTE_THRESHOLD = 2;

/** Maximum number of taste rules per scope (workspace or project) */
const MAX_RULES_PER_SCOPE = 50;

/** Maximum rule text length */
const MAX_RULE_LENGTH = 200;

/** Maximum number of projects with taste overrides */
const MAX_PROJECTS = 20;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Internal Tracking for Auto-detection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Internal tracker for pending correction signals.
 *
 * Signals are accumulated until they reach the threshold,
 * then promoted to a full TasteEntry.
 */
interface PendingCorrection {
  category: TasteCategory;
  rule: string;
  count: number;
  lastSeen: string;
  firstSeen: string;
  sampleMessages: string[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages user taste (preference) rules with persistence.
 *
 * Lifecycle:
 * 1. Construct with `TasteManagerOptions`
 * 2. Call `load()` to restore persisted state (or starts empty)
 * 3. Use `add()`, `remove()`, `update()` to manage rules
 * 4. Use `recordCorrection()` for auto-detection
 * 5. Call `getEffectiveTaste()` to get merged rules for Agent injection
 *
 * Zero-config: If no taste file exists, starts with empty state.
 */
export class TasteManager {
  private readonly dataDir: string;
  private readonly persistPath: string;
  private readonly persistTmpPath: string;

  /** Workspace-level taste rules */
  private workspaceTastes: TasteEntry[] = [];

  /** Per-project taste rules */
  private projectTastes: Map<string, TasteEntry[]> = new Map();

  /** Pending auto-detection corrections */
  private pendingCorrections: Map<string, PendingCorrection> = new Map();

  constructor(options: TasteManagerOptions) {
    this.dataDir = options.dataDir;
    this.persistPath = join(options.dataDir, 'taste.json');
    this.persistTmpPath = join(options.dataDir, 'taste.json.tmp');
  }

  // ───────────────────────────────────────────
  // Initialization
  // ───────────────────────────────────────────

  /**
   * Load persisted taste data from disk.
   *
   * Gracefully handles missing or corrupted files.
   *
   * @returns TasteResult indicating success or failure
   */
  load(): TasteResult<void> {
    if (!existsSync(this.persistPath)) {
      return { ok: true, data: undefined };
    }

    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as unknown;

      if (!this.validateSchema(data)) {
        return { ok: false, error: 'taste.json 格式无效，已跳过恢复' };
      }

      const persisted = data as TastePersistData;

      // Restore workspace tastes
      this.workspaceTastes = Array.isArray(persisted.workspace)
        ? persisted.workspace.filter(this.isValidEntry)
        : [];

      // Restore project tastes
      this.projectTastes.clear();
      if (persisted.projects && typeof persisted.projects === 'object') {
        for (const [projectName, entries] of Object.entries(persisted.projects)) {
          if (Array.isArray(entries)) {
            const validEntries = entries.filter(this.isValidEntry);
            if (validEntries.length > 0) {
              this.projectTastes.set(projectName, validEntries);
            }
          }
        }
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `读取 taste.json 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ───────────────────────────────────────────
  // Core CRUD Operations
  // ───────────────────────────────────────────

  /**
   * Add a taste rule.
   *
   * @param rule - The preference rule text
   * @param category - Category for grouping
   * @param source - How this rule was added
   * @param project - Optional project name for project-scoped rules
   * @returns TasteResult with the created TasteEntry
   */
  add(
    rule: string,
    category: TasteCategory,
    source: TasteSource,
    project?: string,
  ): TasteResult<TasteEntry> {
    // Validate rule
    const ruleError = this.validateRule(rule);
    if (ruleError) {
      return { ok: false, error: ruleError };
    }

    // Check capacity
    const scopeTastes = project
      ? this.projectTastes.get(project) ?? []
      : this.workspaceTastes;

    if (scopeTastes.length >= MAX_RULES_PER_SCOPE) {
      return { ok: false, error: `taste 规则已达上限 (${MAX_RULES_PER_SCOPE})` };
    }

    // Check for duplicates (exact rule match within same scope)
    const normalizedRule = rule.trim().toLowerCase();
    if (scopeTastes.some(e => e.rule.trim().toLowerCase() === normalizedRule)) {
      return { ok: false, error: '该 taste 规则已存在' };
    }

    // Check project count limit
    if (project && !this.projectTastes.has(project)) {
      if (this.projectTastes.size >= MAX_PROJECTS) {
        return { ok: false, error: `项目 taste 数量已达上限 (${MAX_PROJECTS})` };
      }
    }

    const entry: TasteEntry = {
      rule: rule.trim(),
      category,
      source,
      correctionCount: source === 'auto' ? AUTO_PROMOTE_THRESHOLD : 0,
      lastSeen: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    if (project) {
      const entries = this.projectTastes.get(project) ?? [];
      entries.push(entry);
      this.projectTastes.set(project, entries);
    } else {
      this.workspaceTastes.push(entry);
    }

    this.persist();
    return { ok: true, data: entry };
  }

  /**
   * Remove a taste rule by its index.
   *
   * @param index - Index of the rule to remove
   * @param project - Optional project name
   * @returns TasteResult indicating success
   */
  remove(index: number, project?: string): TasteResult<void> {
    const tastes = project
      ? this.projectTastes.get(project) ?? []
      : this.workspaceTastes;

    if (index < 0 || index >= tastes.length) {
      return { ok: false, error: '索引越界，taste 规则不存在' };
    }

    tastes.splice(index, 1);

    // Clean up empty project entries
    if (project && tastes.length === 0) {
      this.projectTastes.delete(project);
    }

    this.persist();
    return { ok: true, data: undefined };
  }

  /**
   * Update an existing taste rule.
   *
   * @param index - Index of the rule to update
   * @param updates - Partial updates to apply
   * @param project - Optional project name
   * @returns TasteResult with the updated TasteEntry
   */
  update(
    index: number,
    updates: Partial<Pick<TasteEntry, 'rule' | 'category'>>,
    project?: string,
  ): TasteResult<TasteEntry> {
    const tastes = project
      ? this.projectTastes.get(project) ?? []
      : this.workspaceTastes;

    if (index < 0 || index >= tastes.length) {
      return { ok: false, error: '索引越界，taste 规则不存在' };
    }

    const entry = tastes[index];

    if (updates.rule !== undefined) {
      const ruleError = this.validateRule(updates.rule);
      if (ruleError) {
        return { ok: false, error: ruleError };
      }
      entry.rule = updates.rule.trim();
    }

    if (updates.category !== undefined) {
      entry.category = updates.category;
    }

    entry.lastSeen = new Date().toISOString();
    this.persist();
    return { ok: true, data: { ...entry } };
  }

  // ───────────────────────────────────────────
  // Auto-detection
  // ───────────────────────────────────────────

  /**
   * Record a correction signal for auto-detection.
   *
   * Accumulates correction signals and auto-promotes to a taste rule
   * when the threshold is reached.
   *
   * @param signal - The correction signal from conversation analysis
   * @param project - Optional project scope
   * @returns TasteResult indicating if a new rule was auto-promoted
   */
  recordCorrection(signal: CorrectionSignal, project?: string): TasteResult<boolean> {
    const key = `${signal.category}:${signal.rule.trim().toLowerCase()}`;
    const existing = this.pendingCorrections.get(key);

    if (existing) {
      existing.count++;
      existing.lastSeen = signal.timestamp;
      existing.sampleMessages.push(signal.originalMessage);
      // Keep only last 3 sample messages
      if (existing.sampleMessages.length > 3) {
        existing.sampleMessages.shift();
      }
    } else {
      this.pendingCorrections.set(key, {
        category: signal.category,
        rule: signal.rule.trim(),
        count: 1,
        lastSeen: signal.timestamp,
        firstSeen: signal.timestamp,
        sampleMessages: [signal.originalMessage],
      });
    }

    const pending = this.pendingCorrections.get(key);
    if (!pending) {
      return { ok: false, error: '内部错误：pending correction 不存在' };
    }

    // Check if threshold is reached for auto-promotion
    if (pending.count >= AUTO_PROMOTE_THRESHOLD) {
      // Check if this rule already exists in taste
      const scopeTastes = project
        ? this.projectTastes.get(project) ?? []
        : this.workspaceTastes;

      const normalizedRule = pending.rule.toLowerCase();
      const existingRule = scopeTastes.find(
        e => e.rule.trim().toLowerCase() === normalizedRule,
      );

      if (existingRule) {
        // Accumulate correction count on existing rule
        existingRule.correctionCount += pending.count;
        existingRule.lastSeen = pending.lastSeen;
        this.pendingCorrections.delete(key);
        this.persist();
        return { ok: true, data: false }; // Updated, not newly promoted
      }

      // Auto-promote to a new taste rule
      const entry: TasteEntry = {
        rule: pending.rule,
        category: pending.category,
        source: 'auto',
        correctionCount: pending.count,
        lastSeen: pending.lastSeen,
        createdAt: pending.firstSeen,
      };

      if (project) {
        const entries = this.projectTastes.get(project) ?? [];
        entries.push(entry);
        this.projectTastes.set(project, entries);
      } else {
        this.workspaceTastes.push(entry);
      }

      this.pendingCorrections.delete(key);
      this.persist();
      return { ok: true, data: true }; // Newly promoted
    }

    return { ok: true, data: false }; // Still accumulating
  }

  // ───────────────────────────────────────────
  // Query Methods
  // ───────────────────────────────────────────

  /**
   * Get all taste rules for a specific scope.
   *
   * @param project - Optional project name (defaults to workspace)
   * @returns Array of TasteEntry
   */
  list(project?: string): TasteEntry[] {
    if (project) {
      return [...(this.projectTastes.get(project) ?? [])];
    }
    return [...this.workspaceTastes];
  }

  /**
   * Get effective taste rules for Agent injection.
   *
   * Merges workspace-level and project-specific rules.
   * Project rules take precedence when rules conflict (same category + similar text).
   *
   * @param project - Optional project name
   * @returns Merged array of TasteEntry, sorted by correction count (descending)
   */
  getEffectiveTaste(project?: string): TasteEntry[] {
    const workspaceTastes = [...this.workspaceTastes];

    if (!project) {
      return workspaceTastes.sort((a, b) => b.correctionCount - a.correctionCount);
    }

    const projectTastes = this.projectTastes.get(project) ?? [];

    // Merge: start with workspace, overlay project-specific
    const merged = new Map<string, TasteEntry>();

    for (const entry of workspaceTastes) {
      merged.set(`${entry.category}:${entry.rule.toLowerCase()}`, entry);
    }

    for (const entry of projectTastes) {
      // Project rules override workspace rules with same category
      const projectKeys = [...merged.keys()].filter(
        k => k.startsWith(`${entry.category}:`),
      );

      // If a similar rule exists in workspace, replace it
      let replaced = false;
      for (const key of projectKeys) {
        const existing = merged.get(key);
        if (existing && this.isSimilarRule(existing.rule, entry.rule)) {
          merged.set(key, entry);
          replaced = true;
          break;
        }
      }

      if (!replaced) {
        merged.set(`${entry.category}:${entry.rule.toLowerCase()}`, entry);
      }
    }

    return [...merged.values()].sort((a, b) => b.correctionCount - a.correctionCount);
  }

  /**
   * List all projects that have taste overrides.
   *
   * @returns Array of project names
   */
  listProjects(): string[] {
    return [...this.projectTastes.keys()];
  }

  /**
   * Clear all taste rules for a scope.
   *
   * @param project - Optional project name (defaults to workspace)
   * @returns TasteResult indicating success
   */
  reset(project?: string): TasteResult<void> {
    if (project) {
      this.projectTastes.delete(project);
    } else {
      this.workspaceTastes = [];
      this.projectTastes.clear();
      this.pendingCorrections.clear();
    }
    this.persist();
    return { ok: true, data: undefined };
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
  private persist(): TasteResult<void> {
    try {
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      const data: TastePersistData = {
        workspace: this.workspaceTastes,
        projects: {},
      };

      for (const [projectName, entries] of this.projectTastes.entries()) {
        data.projects[projectName] = entries;
      }

      const json = JSON.stringify(data, null, 2);
      writeFileSync(this.persistTmpPath, json, 'utf8');

      try {
        renameSync(this.persistTmpPath, this.persistPath);
      } catch (renameErr) {
        try {
          unlinkSync(this.persistTmpPath);
        } catch {
          // Ignore cleanup failure
        }
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
  // Validation Helpers
  // ───────────────────────────────────────────

  /**
   * Validate a taste rule text.
   */
  private validateRule(rule: string): string | null {
    if (!rule || rule.trim().length === 0) {
      return 'taste 规则不能为空';
    }
    if (rule.trim().length > MAX_RULE_LENGTH) {
      return `taste 规则不能超过 ${MAX_RULE_LENGTH} 个字符`;
    }
    return null;
  }

  /**
   * Check if a persisted data object has a valid schema.
   */
  private validateSchema(data: unknown): data is TastePersistData {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const obj = data as Record<string, unknown>;

    // workspace must be an array (or absent)
    if (obj.workspace !== undefined && !Array.isArray(obj.workspace)) {
      return false;
    }

    // projects must be an object (or absent)
    if (obj.projects !== undefined) {
      if (typeof obj.projects !== 'object' || obj.projects === null || Array.isArray(obj.projects)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Type guard for valid TasteEntry objects.
   */
  private isValidEntry(entry: unknown): entry is TasteEntry {
    if (typeof entry !== 'object' || entry === null) {return false;}
    const e = entry as Record<string, unknown>;
    return (
      typeof e.rule === 'string' && e.rule.length > 0 &&
      typeof e.category === 'string' &&
      typeof e.source === 'string' &&
      typeof e.correctionCount === 'number' &&
      typeof e.lastSeen === 'string' && e.lastSeen.length > 0 &&
      typeof e.createdAt === 'string' && e.createdAt.length > 0
    );
  }

  /**
   * Check if two rules are semantically similar.
   *
   * Uses simple normalization for matching — not a full semantic similarity check.
   */
  private isSimilarRule(ruleA: string, ruleB: string): boolean {
    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '');
    return normalize(ruleA) === normalize(ruleB);
  }
}
