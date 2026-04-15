/**
 * TasteStore — File-based persistence for user taste preferences.
 *
 * Reads and writes a `taste.yaml` file in the workspace directory.
 * Uses write-then-rename pattern (atomic rename) to prevent corruption.
 *
 * The store caches the profile in memory and reloads from disk on demand,
 * allowing external edits (e.g., user manually editing taste.yaml) to
 * take effect on the next load.
 *
 * @see Issue #2335 — auto-summarize user taste to avoid repeated corrections
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createLogger, type Logger } from '../utils/logger.js';
import type {
  TasteProfile,
  TasteRule,
  TasteStoreOptions,
  TasteResult,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Default filename for the taste profile */
const DEFAULT_FILENAME = 'taste.yaml';

/** Current schema version */
const CURRENT_VERSION = 1;

/**
 * Create a fresh empty profile.
 * Returns a new object each time to prevent shared mutable state.
 */
function emptyProfile(): TasteProfile {
  return { version: CURRENT_VERSION, rules: [] };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TasteStore Class
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * File-based store for user taste preferences.
 *
 * Usage:
 * ```typescript
 * const store = new TasteStore({ workspaceDir: '/path/to/workspace' });
 *
 * // Load profile (reads from disk)
 * const result = store.load();
 * if (result.ok) {
 *   console.log(result.data.rules);
 * }
 *
 * // Add a rule
 * store.addRule({
 *   category: 'code_style',
 *   content: 'Use const/let, never var',
 *   source: 'manual',
 * });
 *
 * // Save to disk
 * store.save();
 * ```
 */
export class TasteStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private cached: TasteProfile | null = null;

  constructor(options: TasteStoreOptions) {
    const filename = options.filename ?? DEFAULT_FILENAME;
    this.filePath = path.join(options.workspaceDir, filename);
    this.logger = createLogger('taste-store');
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Read Operations
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Load the taste profile from disk.
   *
   * Returns the cached profile if available, otherwise reads from disk.
   * If the file doesn't exist, returns an empty profile.
   * If the file is malformed, returns an error.
   *
   * @param forceReload - If true, ignores cache and reads from disk
   */
  load(forceReload = false): TasteResult<TasteProfile> {
    if (!forceReload && this.cached) {
      return { ok: true, data: this.cached };
    }

    const loaded = this.readFromDisk();
    if (loaded.ok) {
      this.cached = loaded.data;
    }
    return loaded;
  }

  /**
   * Get the current taste rules (loads if not cached).
   */
  getRules(): TasteRule[] {
    const result = this.load();
    return result.ok ? result.data.rules : [];
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Write Operations
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Add a taste rule and save to disk.
   *
   * If a rule with identical content already exists, increments its
   * correctionCount and updates lastSeen instead of creating a duplicate.
   *
   * @param rule - The rule to add
   * @returns Result with the added or updated rule
   */
  addRule(rule: Omit<TasteRule, 'createdAt'>): TasteResult<TasteRule> {
    const loadResult = this.load();
    if (!loadResult.ok) {
      return loadResult;
    }

    const profile = loadResult.data;
    const now = new Date().toISOString();

    // Check for duplicate (same content, case-insensitive)
    const existingIndex = profile.rules.findIndex(
      (r) => r.content.toLowerCase() === rule.content.toLowerCase()
        && r.category === rule.category,
    );

    let savedRule: TasteRule;

    if (existingIndex >= 0) {
      // Update existing rule
      const existing = profile.rules[existingIndex];
      savedRule = {
        ...existing,
        correctionCount: (existing.correctionCount ?? 0) + 1,
        lastSeen: now,
        source: rule.source,
      };
      profile.rules[existingIndex] = savedRule;
      this.logger.info(
        { category: savedRule.category, content: savedRule.content, count: savedRule.correctionCount },
        'Updated existing taste rule',
      );
    } else {
      // Add new rule
      savedRule = {
        ...rule,
        createdAt: now,
        lastSeen: now,
        correctionCount: rule.source === 'auto' ? 1 : undefined,
      };
      profile.rules.push(savedRule);
      this.logger.info(
        { category: savedRule.category, content: savedRule.content },
        'Added new taste rule',
      );
    }

    this.cached = profile;

    const saveResult = this.save();
    if (!saveResult.ok) {
      return saveResult;
    }

    return { ok: true, data: savedRule };
  }

  /**
   * Remove a taste rule by its content.
   *
   * @param content - The exact content string of the rule to remove
   * @returns Result indicating success or failure
   */
  removeRule(content: string): TasteResult<void> {
    const loadResult = this.load();
    if (!loadResult.ok) {
      return loadResult;
    }

    const profile = loadResult.data;
    const before = profile.rules.length;
    profile.rules = profile.rules.filter(
      (r) => r.content !== content,
    );

    if (profile.rules.length === before) {
      return { ok: false, error: `No rule found with content: "${content}"` };
    }

    this.cached = profile;
    this.logger.info({ content }, 'Removed taste rule');

    return this.save();
  }

  /**
   * Clear all taste rules.
   */
  clear(): TasteResult<void> {
    this.cached = emptyProfile();
    this.logger.info('Cleared all taste rules');
    return this.save();
  }

  /**
   * Save the current profile to disk using atomic write-then-rename.
   */
  save(): TasteResult<void> {
    const profile = this.cached ?? emptyProfile();

    try {
      const content = yaml.dump(profile, {
        lineWidth: -1, // Don't wrap lines
        quotingType: '"',
        forceQuotes: false,
        sortKeys: false,
      });

      // Write to temp file first, then rename for atomic write
      const tmpPath = `${this.filePath  }.tmp`;
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, this.filePath);

      this.logger.debug({ path: this.filePath }, 'Taste profile saved');
      return { ok: true, data: undefined };
    } catch (err) {
      const message = `Failed to save taste profile: ${(err as Error).message}`;
      this.logger.error({ err, path: this.filePath }, message);
      return { ok: false, error: message };
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Private Helpers
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Read the taste profile from disk.
   *
   * Returns empty profile if file doesn't exist.
   * Returns error if file is malformed.
   */
  private readFromDisk(): TasteResult<TasteProfile> {
    if (!fs.existsSync(this.filePath)) {
      this.logger.debug({ path: this.filePath }, 'No taste.yaml found, using empty profile');
      return { ok: true, data: emptyProfile() };
    }

    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = yaml.load(content);

      if (!parsed || typeof parsed !== 'object') {
        return { ok: false, error: 'taste.yaml is not a valid YAML object' };
      }

      const profile = validateProfile(parsed as Record<string, unknown>);
      if (!profile) {
        return { ok: false, error: 'taste.yaml has invalid schema' };
      }

      this.logger.debug(
        { ruleCount: profile.rules.length, path: this.filePath },
        'Loaded taste profile',
      );

      return { ok: true, data: profile };
    } catch (err) {
      const message = `Failed to read taste.yaml: ${(err as Error).message}`;
      this.logger.error({ err, path: this.filePath }, message);
      return { ok: false, error: message };
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Validation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  'code_style', 'interaction', 'technical', 'project_convention',
]);

const VALID_SOURCES: ReadonlySet<string> = new Set([
  'manual', 'auto', 'claude_md',
]);

/**
 * Validate a parsed YAML object as a TasteProfile.
 *
 * Returns null if validation fails, otherwise returns a typed TasteProfile.
 * Tolerant parsing: skips invalid rules rather than failing entirely.
 */
function validateProfile(raw: Record<string, unknown>): TasteProfile | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  // Version check
  if (raw.version !== 1) {
    return null;
  }

  const rules = Array.isArray(raw.rules) ? raw.rules : [];

  const validRules: TasteRule[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') {
      continue;
    }

    const r = rule as Record<string, unknown>;

    if (
      typeof r.category === 'string' && VALID_CATEGORIES.has(r.category)
      && typeof r.content === 'string' && r.content.trim().length > 0
      && typeof r.source === 'string' && VALID_SOURCES.has(r.source)
    ) {
      validRules.push({
        category: r.category as TasteRule['category'],
        content: r.content,
        source: r.source as TasteRule['source'],
        correctionCount: typeof r.correctionCount === 'number' ? r.correctionCount : undefined,
        lastSeen: typeof r.lastSeen === 'string' ? r.lastSeen : undefined,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : undefined,
        note: typeof r.note === 'string' ? r.note : undefined,
      });
    }
  }

  return {
    version: 1,
    rules: validRules,
  };
}
