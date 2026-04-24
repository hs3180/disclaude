/**
 * TasteManager — core logic for auto-summarizing and persisting user taste (preferences).
 *
 * Manages per-project taste rules that capture user preferences such as code style,
 * interaction habits, tech preferences, and project norms. These rules are loaded
 * into Agent context to avoid repeated user corrections.
 *
 * Storage: `{workspace}/.disclaude/taste/{projectName}.json`
 * - "default" project → `default.json`
 * - Named projects → `{name}.json`
 *
 * Persistence: Atomic write-then-rename (same pattern as ProjectManager).
 *
 * @see Issue #2335
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
  ProjectResult,
  TasteData,
  TasteRule,
  TasteManagerOptions,
  AddTasteInput,
  UpdateTasteInput,
  TasteCategory,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Maximum content length for a single taste rule */
const MAX_CONTENT_LENGTH = 512;

/** Maximum number of taste rules per project */
const MAX_RULES_PER_PROJECT = 100;

/** Characters forbidden in project names */
const FORBIDDEN_PROJECT_CHARS = /[\x00\\/]/;

/** Category labels for prompt generation */
const CATEGORY_LABELS: Record<TasteCategory, string> = {
  code_style: '代码风格',
  interaction: '交互偏好',
  tech_preference: '技术选择',
  project_norm: '项目规范',
  other: '其他偏好',
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages user taste (preferences) per project.
 *
 * Lifecycle:
 * 1. Construct with `TasteManagerOptions` (workspaceDir)
 * 2. Use `addRule()`, `updateRule()`, `deleteRule()`, `listRules()` for CRUD
 * 3. Use `getTastePrompt()` to generate injection text for Agent context
 * 4. Use `resetTaste()` to clear all rules for a project
 *
 * Data is persisted atomically after every mutation.
 */
export class TasteManager {
  private readonly workspaceDir: string;

  /** In-memory cache: projectName → TasteData */
  private readonly cache = new Map<string, TasteData>();

  /** Path to .disclaude/taste/ directory */
  private readonly tasteDir: string;

  constructor(options: TasteManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.tasteDir = join(options.workspaceDir, '.disclaude', 'taste');
  }

  // ───────────────────────────────────────────
  // Core CRUD Methods
  // ───────────────────────────────────────────

  /**
   * Add a new taste rule for a project.
   *
   * Validates input, generates a unique ID, and persists to disk.
   *
   * @param projectName - Project name (e.g. "default" or a named project)
   * @param input - Taste rule data to add
   * @returns ProjectResult with the created TasteRule on success
   */
  addRule(projectName: string, input: AddTasteInput): ProjectResult<TasteRule> {
    // Validate project name
    const nameError = this.validateProjectName(projectName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    // Validate content
    const contentError = this.validateContent(input.content);
    if (contentError) {
      return { ok: false, error: contentError };
    }

    // Load existing data
    const data = this.loadTasteData(projectName);

    // Check rule limit
    if (data.rules.length >= MAX_RULES_PER_PROJECT) {
      return { ok: false, error: `每个项目最多 ${MAX_RULES_PER_PROJECT} 条 taste 规则` };
    }

    // Check for duplicate content
    if (data.rules.some(r => r.content === input.content.trim())) {
      return { ok: false, error: '该偏好规则已存在' };
    }

    const now = new Date().toISOString();
    const rule: TasteRule = {
      id: this.generateId(),
      category: input.category,
      content: input.content.trim(),
      source: input.source ?? 'manual',
      correctionCount: input.correctionCount ?? 1,
      lastSeen: now,
      createdAt: now,
    };

    data.rules.push(rule);
    data.updatedAt = now;

    // Persist
    const persistResult = this.persistTasteData(projectName, data);
    if (!persistResult.ok) {
      return { ok: false, error: persistResult.error };
    }

    // Update cache
    this.cache.set(projectName, data);

    return { ok: true, data: rule };
  }

  /**
   * Update an existing taste rule.
   *
   * Only provided fields will be modified.
   * Automatically updates `lastSeen` timestamp.
   *
   * @param projectName - Project name
   * @param ruleId - ID of the rule to update
   * @param input - Fields to update
   * @returns ProjectResult with the updated TasteRule on success
   */
  updateRule(
    projectName: string,
    ruleId: string,
    input: UpdateTasteInput,
  ): ProjectResult<TasteRule> {
    const nameError = this.validateProjectName(projectName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    if (input.content !== undefined) {
      const contentError = this.validateContent(input.content);
      if (contentError) {
        return { ok: false, error: contentError };
      }
    }

    const data = this.loadTasteData(projectName);
    const rule = data.rules.find(r => r.id === ruleId);
    if (!rule) {
      return { ok: false, error: `规则 "${ruleId}" 不存在` };
    }

    // Apply updates
    if (input.category !== undefined) {
      rule.category = input.category;
    }
    if (input.content !== undefined) {
      rule.content = input.content.trim();
    }
    if (input.correctionCount !== undefined) {
      rule.correctionCount = input.correctionCount;
    }
    rule.lastSeen = new Date().toISOString();
    data.updatedAt = rule.lastSeen;

    const persistResult = this.persistTasteData(projectName, data);
    if (!persistResult.ok) {
      return { ok: false, error: persistResult.error };
    }

    this.cache.set(projectName, data);
    return { ok: true, data: rule };
  }

  /**
   * Delete a taste rule by ID.
   *
   * @param projectName - Project name
   * @param ruleId - ID of the rule to delete
   * @returns ProjectResult with void on success
   */
  deleteRule(projectName: string, ruleId: string): ProjectResult<void> {
    const nameError = this.validateProjectName(projectName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const data = this.loadTasteData(projectName);
    const index = data.rules.findIndex(r => r.id === ruleId);
    if (index === -1) {
      return { ok: false, error: `规则 "${ruleId}" 不存在` };
    }

    data.rules.splice(index, 1);
    data.updatedAt = new Date().toISOString();

    // If no rules remain, delete the file
    if (data.rules.length === 0) {
      this.deleteTasteFile(projectName);
      this.cache.delete(projectName);
    } else {
      const persistResult = this.persistTasteData(projectName, data);
      if (!persistResult.ok) {
        return { ok: false, error: persistResult.error };
      }
      this.cache.set(projectName, data);
    }

    return { ok: true, data: undefined };
  }

  /**
   * List all taste rules for a project.
   *
   * Returns rules sorted by category, then by correctionCount (descending).
   *
   * @param projectName - Project name
   * @returns ProjectResult with array of TasteRule on success
   */
  listRules(projectName: string): ProjectResult<TasteRule[]> {
    const nameError = this.validateProjectName(projectName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const data = this.loadTasteData(projectName);

    // Sort: by category first, then by correctionCount descending
    const sorted = [...data.rules].sort((a, b) => {
      const catCompare = a.category.localeCompare(b.category);
      if (catCompare !== 0) {return catCompare;}
      return b.correctionCount - a.correctionCount;
    });

    return { ok: true, data: sorted };
  }

  /**
   * Get a single taste rule by ID.
   *
   * @param projectName - Project name
   * @param ruleId - Rule ID
   * @returns ProjectResult with TasteRule on success
   */
  getRule(projectName: string, ruleId: string): ProjectResult<TasteRule> {
    const nameError = this.validateProjectName(projectName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const data = this.loadTasteData(projectName);
    const rule = data.rules.find(r => r.id === ruleId);
    if (!rule) {
      return { ok: false, error: `规则 "${ruleId}" 不存在` };
    }

    return { ok: true, data: rule };
  }

  /**
   * Reset (clear) all taste rules for a project.
   *
   * Removes the taste file from disk and clears the cache.
   *
   * @param projectName - Project name
   * @returns ProjectResult with number of deleted rules on success
   */
  resetTaste(projectName: string): ProjectResult<number> {
    const nameError = this.validateProjectName(projectName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const data = this.loadTasteData(projectName);
    const count = data.rules.length;

    this.deleteTasteFile(projectName);
    this.cache.delete(projectName);

    return { ok: true, data: count };
  }

  // ───────────────────────────────────────────
  // Prompt Generation
  // ───────────────────────────────────────────

  /**
   * Generate a taste prompt section for Agent context injection.
   *
   * Returns a formatted string that can be injected into the system prompt
   * or message preamble. Rules are grouped by category and sorted by weight.
   *
   * Returns empty string if no taste rules exist.
   *
   * @param projectName - Project name
   * @returns Formatted taste prompt string
   */
  getTastePrompt(projectName: string): string {
    const result = this.listRules(projectName);
    if (!result.ok || result.data.length === 0) {
      return '';
    }

    const rules = result.data;

    // Group by category
    const grouped = new Map<TasteCategory, TasteRule[]>();
    for (const rule of rules) {
      const existing = grouped.get(rule.category) ?? [];
      existing.push(rule);
      grouped.set(rule.category, existing);
    }

    const lines: string[] = ['[Project Taste — auto-learned preferences]'];

    for (const [category, categoryRules] of grouped) {
      const label = CATEGORY_LABELS[category] ?? category;
      const ruleTexts = categoryRules.map(rule => {
        const weightHint = rule.correctionCount >= 3
          ? `（重要，被纠正 ${rule.correctionCount} 次）`
          : rule.correctionCount >= 2
            ? `（被纠正 ${rule.correctionCount} 次）`
            : '';
        const sourceHint = rule.source === 'claude_md' ? '（来自 CLAUDE.md）' : '';
        return `- ${rule.content}${weightHint}${sourceHint}`;
      });
      lines.push(`${label}：${ruleTexts.join('；')}`);
    }

    return lines.join('\n');
  }

  // ───────────────────────────────────────────
  // Reinforcement (Auto-detection Support)
  // ───────────────────────────────────────────

  /**
   * Reinforce an existing rule by incrementing its correction count,
   * or add a new rule if no matching content exists.
   *
   * Used by auto-detection logic when a user correction is observed.
   *
   * @param projectName - Project name
   * @param category - Taste category
   * @param content - Preference content
   * @returns ProjectResult with the rule on success
   */
  reinforceOrAdd(
    projectName: string,
    category: TasteCategory,
    content: string,
  ): ProjectResult<TasteRule> {
    const nameError = this.validateProjectName(projectName);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const trimmedContent = content.trim();
    const contentError = this.validateContent(trimmedContent);
    if (contentError) {
      return { ok: false, error: contentError };
    }

    const data = this.loadTasteData(projectName);
    const existing = data.rules.find(
      r => r.content === trimmedContent || this.isSimilarContent(r.content, trimmedContent),
    );

    if (existing) {
      // Reinforce: increment count and update timestamp
      existing.correctionCount += 1;
      existing.lastSeen = new Date().toISOString();
      data.updatedAt = existing.lastSeen;

      const persistResult = this.persistTasteData(projectName, data);
      if (!persistResult.ok) {
        return { ok: false, error: persistResult.error };
      }
      this.cache.set(projectName, data);
      return { ok: true, data: existing };
    }

    // Add new auto-detected rule
    return this.addRule(projectName, {
      category,
      content: trimmedContent,
      source: 'auto',
      correctionCount: 1,
    });
  }

  // ───────────────────────────────────────────
  // Query Methods
  // ───────────────────────────────────────────

  /**
   * Get taste data file path for a project (for testing/debugging).
   */
  getTasteFilePath(projectName: string): string {
    return this.resolveTastePath(projectName);
  }

  /**
   * Get the taste directory path.
   */
  getTasteDir(): string {
    return this.tasteDir;
  }

  /**
   * Check if a project has any taste rules.
   */
  hasTaste(projectName: string): boolean {
    const data = this.loadTasteData(projectName);
    return data.rules.length > 0;
  }

  /**
   * Get the count of taste rules for a project.
   */
  getRuleCount(projectName: string): number {
    const data = this.loadTasteData(projectName);
    return data.rules.length;
  }

  // ───────────────────────────────────────────
  // Internal: Persistence
  // ───────────────────────────────────────────

  /**
   * Resolve the file path for a project's taste data.
   */
  private resolveTastePath(projectName: string): string {
    return join(this.tasteDir, `${projectName}.json`);
  }

  /**
   * Resolve the temp file path for atomic writes.
   */
  private resolveTasteTmpPath(projectName: string): string {
    return join(this.tasteDir, `${projectName}.json.tmp`);
  }

  /**
   * Load taste data from disk, using cache if available.
   */
  private loadTasteData(projectName: string): TasteData {
    // Check cache first
    const cached = this.cache.get(projectName);
    if (cached) {
      return cached;
    }

    const filePath = this.resolveTastePath(projectName);

    if (!existsSync(filePath)) {
      // No file → empty data
      return {
        projectName,
        rules: [],
        updatedAt: new Date().toISOString(),
      };
    }

    try {
      const raw = readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw) as unknown;

      if (!this.validateTasteSchema(data)) {
        // Invalid schema → return empty
        return {
          projectName,
          rules: [],
          updatedAt: new Date().toISOString(),
        };
      }

      return data as TasteData;
    } catch {
      // Corrupted → return empty
      return {
        projectName,
        rules: [],
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Persist taste data to disk using atomic write-then-rename.
   */
  private persistTasteData(
    projectName: string,
    data: TasteData,
  ): ProjectResult<void> {
    try {
      // Ensure directory exists
      if (!existsSync(this.tasteDir)) {
        mkdirSync(this.tasteDir, { recursive: true });
      }

      const tmpPath = this.resolveTasteTmpPath(projectName);
      const filePath = this.resolveTastePath(projectName);

      const json = JSON.stringify(data, null, 2);
      writeFileSync(tmpPath, json, 'utf8');

      try {
        renameSync(tmpPath, filePath);
      } catch (renameErr) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup failure
        }
        return {
          ok: false,
          error: `Taste 持久化写入失败: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
        };
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `Taste 持久化失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Delete the taste file for a project.
   */
  private deleteTasteFile(projectName: string): void {
    const filePath = this.resolveTastePath(projectName);
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // Ignore deletion errors
    }
  }

  // ───────────────────────────────────────────
  // Internal: Validation
  // ───────────────────────────────────────────

  /**
   * Validate a project name.
   */
  private validateProjectName(name: string): string | null {
    if (!name || name.length === 0) {
      return '项目名称不能为空';
    }
    if (name === '..' || name.includes('..')) {
      return '项目名称不能包含 ".."';
    }
    if (FORBIDDEN_PROJECT_CHARS.test(name)) {
      return '项目名称不能包含特殊字符';
    }
    if (name.trim().length === 0) {
      return '项目名称不能仅包含空白字符';
    }
    return null;
  }

  /**
   * Validate taste rule content.
   */
  private validateContent(content: string): string | null {
    if (!content || content.trim().length === 0) {
      return '偏好内容不能为空';
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return `偏好内容不能超过 ${MAX_CONTENT_LENGTH} 个字符`;
    }
    return null;
  }

  /**
   * Validate the top-level schema of taste data.
   */
  private validateTasteSchema(data: unknown): data is TasteData {
    if (typeof data !== 'object' || data === null) {return false;}
    const obj = data as Record<string, unknown>;
    if (typeof obj.projectName !== 'string') {return false;}
    if (!Array.isArray(obj.rules)) {return false;}
    if (typeof obj.updatedAt !== 'string') {return false;}
    return true;
  }

  // ───────────────────────────────────────────
  // Internal: Utilities
  // ───────────────────────────────────────────

  /**
   * Generate a unique ID for a taste rule.
   *
   * Format: `t_{timestamp}_{random}` — sortable and collision-resistant.
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `t_${timestamp}_${random}`;
  }

  /**
   * Check if two taste contents are semantically similar.
   *
   * Simple heuristic: normalize whitespace and compare.
   * This prevents near-duplicate rules from being added.
   */
  private isSimilarContent(existing: string, incoming: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    return normalize(existing) === normalize(incoming);
  }
}
