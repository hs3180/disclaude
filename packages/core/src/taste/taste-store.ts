/**
 * Taste Store — Read/write taste profile from/to YAML files.
 *
 * Provides file-based persistence for user preference profiles.
 * The profile is stored as `workspace/taste.yaml`.
 *
 * Uses only Node.js built-in modules (fs, path) and
 * a lightweight YAML parser. No external dependencies.
 *
 * @see Issue #2335
 * @module taste/taste-store
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type {
  TasteProfile,
  TasteRule,
  TasteCategory,
  TasteResult,
  TasteSummary,
  DetectedPattern,
} from './types.js';

const logger = createLogger('TasteStore');

/** Default filename for the taste profile */
const TASTE_FILENAME = 'taste.yaml';

/**
 * Get the path to the taste profile file.
 *
 * @param workspaceDir - Workspace directory path
 * @returns Absolute path to taste.yaml
 */
export function getTastePath(workspaceDir: string): string {
  return path.join(workspaceDir, TASTE_FILENAME);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// YAML Serialization (lightweight, no deps)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Serialize a TasteProfile to YAML string.
 *
 * Simple hand-written serializer to avoid adding yaml dependency.
 * Handles the specific structure of TasteProfile only.
 */
export function serializeToYaml(profile: TasteProfile): string {
  const lines: string[] = [
    '# Auto-generated user preference profile',
    `# Last updated: ${profile.last_updated}`,
    '',
    'taste:',
  ];

  const categories: TasteCategory[] = ['code_style', 'interaction', 'technical'];

  for (const category of categories) {
    const rules = profile.taste[category];
    if (!rules || rules.length === 0) {continue;}

    lines.push(`  ${category}:`);
    for (const rule of rules) {
      lines.push(`    - rule: "${escapeYamlString(rule.rule)}"`);
      lines.push(`      source: ${rule.source}`);
      lines.push(`      count: ${rule.count}`);
      lines.push(`      last_seen: "${rule.last_seen}"`);
      lines.push('      examples:');
      for (const example of rule.examples) {
        lines.push(`        - "${escapeYamlString(example)}"`);
      }
    }
  }

  // If no rules were written, add empty placeholder
  if (lines.length <= 3) {
    lines.push('  {}');
  }

  return `${lines.join('\n')  }\n`;
}

/**
 * Parse a YAML string into a TasteProfile.
 *
 * Simple hand-written parser for the specific taste.yaml format.
 * Handles comments, nested structure, and quoted strings.
 */
export function parseFromYaml(yaml: string): TasteProfile {
  const profile: TasteProfile = {
    last_updated: new Date().toISOString().split('T')[0],
    taste: {},
  };

  const lines = yaml.split('\n');
  let currentCategory: TasteCategory | null = null;
  let currentRule: Partial<TasteRule> | null = null;
  let inExamples = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip comments and empty lines
    if (line.startsWith('#') || line === '') {continue;}

    // Detect category header (e.g., "code_style:")
    const categoryMatch = line.match(/^(code_style|interaction|technical):$/);
    if (categoryMatch) {
      // Save pending rule from previous category before switching
      if (currentRule && currentRule.rule && currentCategory) {
        const rules = profile.taste[currentCategory];
        if (rules) { rules.push(currentRule as TasteRule); }
      }
      currentCategory = categoryMatch[1] as TasteCategory;
      profile.taste[currentCategory] = [];
      currentRule = null;
      inExamples = false;
      continue;
    }

    if (!currentCategory) {continue;}

    // Detect new rule entry
    if (line.startsWith('- rule:')) {
      // Save previous rule
      if (currentRule && currentRule.rule) {
        const rules = profile.taste[currentCategory];
        if (rules) { rules.push(currentRule as TasteRule); }
      }
      currentRule = {
        rule: extractYamlValue(line.substring(2)), // skip "- "
        source: 'auto',
        count: 1,
        last_seen: '',
        examples: [],
      };
      inExamples = false;
      continue;
    }

    if (!currentRule) {continue;}

    // Parse rule fields
    if (line.startsWith('source:')) {
      currentRule.source = extractYamlValue(line) as TasteRule['source'];
      inExamples = false;
    } else if (line.startsWith('count:')) {
      currentRule.count = parseInt(extractYamlValue(line), 10) || 1;
      inExamples = false;
    } else if (line.startsWith('last_seen:')) {
      currentRule.last_seen = extractYamlValue(line);
      inExamples = false;
    } else if (line === 'examples:') {
      inExamples = true;
    } else if (inExamples && line.startsWith('- ') && currentRule.examples) {
      currentRule.examples.push(extractYamlValue(line.substring(2)));
    }
  }

  // Save last rule
  if (currentRule && currentRule.rule && currentCategory) {
    const rules = profile.taste[currentCategory];
    if (rules) { rules.push(currentRule as TasteRule); }
  }

  return profile;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// File Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Read the taste profile from disk.
 *
 * Returns an empty profile if the file doesn't exist.
 *
 * @param workspaceDir - Workspace directory path
 * @returns TasteProfile (empty if not found)
 */
export async function readTasteProfile(workspaceDir: string): Promise<TasteProfile> {
  const tastePath = getTastePath(workspaceDir);

  try {
    const content = await fs.readFile(tastePath, 'utf-8');
    return parseFromYaml(content);
  } catch {
    // File doesn't exist — return empty profile
    logger.debug({ tastePath }, 'No taste profile found, returning empty');
    return {
      last_updated: new Date().toISOString().split('T')[0],
      taste: {},
    };
  }
}

/**
 * Write the taste profile to disk.
 *
 * Creates the workspace directory if it doesn't exist.
 *
 * @param workspaceDir - Workspace directory path
 * @param profile - TasteProfile to persist
 */
export async function writeTasteProfile(
  workspaceDir: string,
  profile: TasteProfile,
): Promise<void> {
  const tastePath = getTastePath(workspaceDir);

  // Ensure workspace directory exists
  await fs.mkdir(workspaceDir, { recursive: true });

  const [dateStr] = new Date().toISOString().split('T');
  profile.last_updated = dateStr;
  const yaml = serializeToYaml(profile);
  await fs.writeFile(tastePath, yaml, 'utf-8');

  logger.debug({ tastePath }, 'Taste profile saved');
}

/**
 * Delete the taste profile file.
 *
 * @param workspaceDir - Workspace directory path
 * @returns true if file was deleted, false if it didn't exist
 */
export async function deleteTasteProfile(workspaceDir: string): Promise<boolean> {
  const tastePath = getTastePath(workspaceDir);

  try {
    await fs.unlink(tastePath);
    logger.debug({ tastePath }, 'Taste profile deleted');
    return true;
  } catch {
    return false;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Rule Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Merge detected patterns into an existing taste profile.
 *
 * - Existing rules: increment count, update last_seen, add new example
 * - New rules: add with count from detection
 *
 * @param profile - Existing taste profile
 * @param patterns - Newly detected patterns to merge
 * @returns Updated taste profile
 */
export function mergePatterns(
  profile: TasteProfile,
  patterns: DetectedPattern[],
): TasteProfile {
  for (const pattern of patterns) {
    const {category} = pattern;
    if (!profile.taste[category]) {
      profile.taste[category] = [];
    }

    const rules = profile.taste[category];
    if (!rules) {continue;}
    const existingRule = findSimilarRule(rules, pattern.rule);

    if (existingRule) {
      // Merge into existing rule
      existingRule.count += pattern.count;
      existingRule.last_seen = pattern.lastSeen;
      // Add new examples (max 3 total)
      for (const example of pattern.examples) {
        if (existingRule.examples.length < 3 && !existingRule.examples.includes(example)) {
          existingRule.examples.push(example);
        }
      }
    } else {
      // Add new rule
      rules.push({
        rule: pattern.rule,
        source: 'auto',
        count: pattern.count,
        last_seen: pattern.lastSeen,
        examples: pattern.examples.slice(0, 3),
      });
    }
  }

  return profile;
}

/**
 * Add a manual taste rule.
 *
 * @param profile - Existing taste profile
 * @param category - Rule category
 * @param ruleText - Rule text
 * @returns Updated taste profile
 */
export function addManualRule(
  profile: TasteProfile,
  category: TasteCategory,
  ruleText: string,
): TasteProfile {
  if (!profile.taste[category]) {
    profile.taste[category] = [];
  }

  // At this point profile.taste[category] is guaranteed to exist
  const rules = profile.taste[category] as TasteRule[];

  // Check if similar rule already exists
  const existing = findSimilarRule(rules, ruleText);
  if (existing) {
    return profile; // Don't duplicate
  }

  const [dateStr] = new Date().toISOString().split('T');
  rules.push({
    rule: ruleText,
    source: 'manual',
    count: 1,
    last_seen: dateStr,
    examples: [],
  });

  return profile;
}

/**
 * Remove a taste rule by exact text match.
 *
 * @param profile - Existing taste profile
 * @param category - Rule category
 * @param ruleText - Rule text to remove
 * @returns TasteResult with updated profile
 */
export function removeRule(
  profile: TasteProfile,
  category: TasteCategory,
  ruleText: string,
): TasteResult<TasteProfile> {
  if (!profile.taste[category]) {
    return { ok: false, error: `Category "${category}" has no rules` };
  }

  const rules = profile.taste[category] as TasteRule[];
  const index = rules.findIndex(r => r.rule === ruleText);

  if (index === -1) {
    return { ok: false, error: `Rule "${ruleText}" not found in ${category}` };
  }

  rules.splice(index, 1);

  // Clean up empty category
  if (rules.length === 0) {
    delete profile.taste[category];
  }

  return { ok: true, data: profile };
}

/**
 * Get active taste rules (count >= 2) for context injection.
 *
 * @param profile - Taste profile
 * @returns Array of active rules with their categories
 */
export function getActiveRules(
  profile: TasteProfile,
): Array<{ category: TasteCategory; rule: TasteRule }> {
  const active: Array<{ category: TasteCategory; rule: TasteRule }> = [];
  const categories: TasteCategory[] = ['code_style', 'interaction', 'technical'];

  for (const category of categories) {
    const rules = profile.taste[category];
    if (!rules) {continue;}

    for (const rule of rules) {
      if (rule.count >= 2) {
        active.push({ category, rule });
      }
    }
  }

  return active;
}

/**
 * Generate a summary of the taste profile.
 *
 * @param profile - Taste profile
 * @returns Summary statistics
 */
export function getSummary(profile: TasteProfile): TasteSummary {
  const categories: TasteCategory[] = ['code_style', 'interaction', 'technical'];
  let totalRules = 0;
  let activeRules = 0;
  const categoryCounts: Partial<Record<TasteCategory, number>> = {};

  for (const category of categories) {
    const rules = profile.taste[category];
    const count = rules?.length ?? 0;
    categoryCounts[category] = count;
    totalRules += count;
    activeRules += rules?.filter(r => r.count >= 2).length ?? 0;
  }

  return {
    totalRules,
    categoryCounts,
    activeRules,
    lastUpdated: profile.last_updated,
  };
}

/**
 * Format active rules as markdown for Agent context injection.
 *
 * @param profile - Taste profile
 * @returns Markdown string or null if no active rules
 */
export function formatTasteForContext(profile: TasteProfile): string | null {
  const activeRules = getActiveRules(profile);
  if (activeRules.length === 0) {return null;}

  const categoryLabels: Record<TasteCategory, string> = {
    code_style: '💻 代码风格',
    interaction: '💬 交互偏好',
    technical: '🔧 技术选择',
  };

  const lines: string[] = [
    '## User Taste (auto-learned preferences)',
    '',
    '> ⚠️ This section is auto-generated by the taste skill.',
    '> Use `/taste` commands to manage.',
    '',
  ];

  for (const { category, rule } of activeRules) {
    const label = categoryLabels[category];
    const source = rule.source === 'manual' ? '手动添加' :
                   rule.source === 'claude_md' ? '来自 CLAUDE.md' :
                   `被纠正 ${rule.count} 次`;
    lines.push(`- ${label}: ${rule.rule} (${source})`);
  }

  lines.push('', '<!-- taste:end -->');
  return lines.join('\n');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Internal Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Find a rule with similar text in an array.
 *
 * Uses exact match for now; future enhancement could use fuzzy matching.
 */
function findSimilarRule(rules: TasteRule[], ruleText: string): TasteRule | undefined {
  return rules.find(r => r.rule === ruleText);
}

/**
 * Extract a YAML value from a "key: value" line.
 *
 * Handles quoted and unquoted values.
 */
function extractYamlValue(line: string): string {
  // Match "key: value" or "key: "quoted value""
  const match = line.match(/^[\w-]+:\s*(.*)$/);
  if (!match) {return line;}

  let value = match[1].trim();

  // Remove surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  return value;
}

/**
 * Escape a string for safe inclusion in YAML.
 *
 * Handles double quotes and backslashes.
 */
function escapeYamlString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}
