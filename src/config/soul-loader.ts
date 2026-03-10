/**
 * SOUL.md Loader - Agent personality/behavior definition system.
 *
 * SOUL.md is a "personality definition" design pattern that defines AI's core
 * behavior guidelines through Markdown files, allowing Agents to drive behavior
 * through "self-awareness" rather than "rule constraints".
 *
 * @see Issue #1315
 * @see https://www.verysmallwoods.com/blog/20260205-openclaw-soul-md-design
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from './index.js';

const logger = createLogger('SoulLoader');

/**
 * Parsed SOUL.md content structure.
 */
export interface SoulContent {
  /** Raw content of the SOUL.md file */
  raw: string;

  /** Core truths - Agent's core values and behavior guidelines */
  coreTruths: string;

  /** Boundaries - What the Agent should NOT do */
  boundaries: string;

  /** Lifecycle configuration (optional) */
  lifecycle?: {
    /** When to end the session */
    stopCondition?: string;
    /** Trigger phrase for ending */
    triggerPhrase?: string;
  };

  /** Source file path */
  source: string;

  /** Priority level (higher = more important) */
  priority: number;
}

/**
 * SOUL.md file location configuration.
 */
export interface SoulLocation {
  /** File path */
  path: string;

  /** Priority level */
  priority: number;

  /** Description for logging */
  description: string;
}

/**
 * Get all potential SOUL.md file locations in priority order.
 *
 * Priority (low to high):
 * 1. config/SOUL.md - System default personality (lowest)
 * 2. skills/{skill}/SOUL.md - Skill-specific personality (medium)
 * 3. ~/.disclaude/SOUL.md - User-defined personality (highest)
 *
 * @param skillName - Optional skill name for skill-specific SOUL
 * @returns Array of potential locations sorted by priority
 */
export function getSoulLocations(skillName?: string): SoulLocation[] {
  const locations: SoulLocation[] = [];
  const workspaceDir = Config.getWorkspaceDir();

  // 1. System default: config/SOUL.md (lowest priority = 1)
  locations.push({
    path: path.join(workspaceDir, 'config', 'SOUL.md'),
    priority: 1,
    description: 'System default personality',
  });

  // 2. Skill-specific: skills/{skill}/SOUL.md (medium priority = 2)
  if (skillName) {
    locations.push({
      path: path.join(workspaceDir, 'skills', skillName, 'SOUL.md'),
      priority: 2,
      description: `Skill-specific personality (${skillName})`,
    });

    // Also check built-in skills directory
    const builtinSkillsDir = Config.getSkillsDir();
    locations.push({
      path: path.join(builtinSkillsDir, skillName, 'SOUL.md'),
      priority: 2,
      description: `Built-in skill personality (${skillName})`,
    });
  }

  // 3. User-defined: ~/.disclaude/SOUL.md (highest priority = 3)
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    locations.push({
      path: path.join(homeDir, '.disclaude', 'SOUL.md'),
      priority: 3,
      description: 'User-defined personality',
    });
  }

  return locations;
}

/**
 * Parse SOUL.md content into structured format.
 *
 * Expected format:
 * ```markdown
 * # {Name} SOUL
 *
 * ## Core Truths
 * {content}
 *
 * ## Boundaries
 * {content}
 *
 * ## Lifecycle (optional)
 * - Stop Condition: {condition}
 * - Trigger Phrase: {phrase}
 * ```
 *
 * @param content - Raw markdown content
 * @param source - Source file path
 * @param priority - Priority level
 * @returns Parsed SoulContent
 */
export function parseSoulContent(
  content: string,
  source: string,
  priority: number
): SoulContent {
  const result: SoulContent = {
    raw: content,
    coreTruths: '',
    boundaries: '',
    source,
    priority,
  };

  // Extract Core Truths section
  // Use (?=\n## |$) to match end of section (next ## header or end of string)
  const coreTruthsMatch = content.match(/##\s*Core Truths\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (coreTruthsMatch) {
    result.coreTruths = coreTruthsMatch[1].trim();
  }

  // Extract Boundaries section
  const boundariesMatch = content.match(/##\s*Boundaries\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (boundariesMatch) {
    result.boundaries = boundariesMatch[1].trim();
  }

  // Extract Lifecycle section
  const lifecycleMatch = content.match(/##\s*Lifecycle\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (lifecycleMatch) {
    const lifecycleContent = lifecycleMatch[1];

    // Parse Stop Condition
    const stopConditionMatch = lifecycleContent.match(/[-*]\s*Stop Condition:\s*(.+)/i);
    // Parse Trigger Phrase
    const triggerPhraseMatch = lifecycleContent.match(/[-*]\s*Trigger Phrase:\s*(.+)/i);

    if (stopConditionMatch || triggerPhraseMatch) {
      result.lifecycle = {
        stopCondition: stopConditionMatch?.[1]?.trim(),
        triggerPhrase: triggerPhraseMatch?.[1]?.trim(),
      };
    }
  }

  return result;
}

/**
 * Load a single SOUL.md file.
 *
 * @param location - File location configuration
 * @returns Parsed SoulContent or null if file doesn't exist
 */
export async function loadSoulFile(location: SoulLocation): Promise<SoulContent | null> {
  try {
    const content = await fs.readFile(location.path, 'utf-8');
    logger.debug({ path: location.path, description: location.description }, 'Loaded SOUL.md');
    return parseSoulContent(content, location.path, location.priority);
  } catch (error) {
    // File doesn't exist is expected, not an error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    logger.warn({ error, path: location.path }, 'Failed to load SOUL.md');
    return null;
  }
}

/**
 * Load and merge all SOUL.md files based on priority.
 *
 * Higher priority files override lower priority ones for each section.
 * If a higher priority file has an empty section, it still overrides.
 *
 * @param skillName - Optional skill name for skill-specific SOUL
 * @returns Merged SoulContent or null if no files exist
 */
export async function loadMergedSoul(skillName?: string): Promise<SoulContent | null> {
  const locations = getSoulLocations(skillName);
  const loadedSouls: SoulContent[] = [];

  // Load all existing SOUL files
  for (const location of locations) {
    const soul = await loadSoulFile(location);
    if (soul) {
      loadedSouls.push(soul);
    }
  }

  if (loadedSouls.length === 0) {
    logger.debug('No SOUL.md files found');
    return null;
  }

  // Sort by priority (ascending) so higher priority overrides lower
  loadedSouls.sort((a, b) => a.priority - b.priority);

  // Merge: start with lowest priority, override with higher
  const merged: SoulContent = {
    raw: '',
    coreTruths: '',
    boundaries: '',
    source: loadedSouls.map(s => s.source).join(', '),
    priority: Math.max(...loadedSouls.map(s => s.priority)),
  };

  for (const soul of loadedSouls) {
    if (soul.coreTruths) {
      merged.coreTruths = soul.coreTruths;
    }
    if (soul.boundaries) {
      merged.boundaries = soul.boundaries;
    }
    if (soul.lifecycle) {
      merged.lifecycle = { ...merged.lifecycle, ...soul.lifecycle };
    }
  }

  // Reconstruct raw content from merged sections
  merged.raw = buildRawContent(merged);

  logger.info(
    {
      sources: loadedSouls.map(s => ({ path: s.source, priority: s.priority })),
      hasLifecycle: !!merged.lifecycle,
    },
    'Merged SOUL.md files'
  );

  return merged;
}

/**
 * Build raw markdown content from SoulContent.
 *
 * @param soul - Parsed soul content
 * @returns Raw markdown string
 */
function buildRawContent(soul: SoulContent): string {
  const parts: string[] = [];

  parts.push('# Agent SOUL\n');

  if (soul.coreTruths) {
    parts.push('## Core Truths\n');
    parts.push(soul.coreTruths);
    parts.push('\n');
  }

  if (soul.boundaries) {
    parts.push('## Boundaries\n');
    parts.push(soul.boundaries);
    parts.push('\n');
  }

  if (soul.lifecycle) {
    parts.push('## Lifecycle\n');
    if (soul.lifecycle.stopCondition) {
      parts.push(`- Stop Condition: ${soul.lifecycle.stopCondition}\n`);
    }
    if (soul.lifecycle.triggerPhrase) {
      parts.push(`- Trigger Phrase: ${soul.lifecycle.triggerPhrase}\n`);
    }
  }

  return parts.join('');
}

/**
 * Format SoulContent for injection into Agent system prompt.
 *
 * @param soul - Parsed soul content
 * @returns Formatted string for system prompt
 */
export function formatSoulForPrompt(soul: SoulContent): string {
  const parts: string[] = [];

  parts.push('---\n');
  parts.push('## Agent Personality (SOUL)\n\n');
  parts.push('> Your behavior is guided by the following personality definition.\n');
  parts.push('> This shapes how you respond, not what you can do.\n\n');

  if (soul.coreTruths) {
    parts.push('### Core Truths\n\n');
    parts.push(soul.coreTruths);
    parts.push('\n\n');
  }

  if (soul.boundaries) {
    parts.push('### Boundaries\n\n');
    parts.push(soul.boundaries);
    parts.push('\n\n');
  }

  if (soul.lifecycle) {
    parts.push('### Lifecycle\n\n');
    if (soul.lifecycle.stopCondition) {
      parts.push(`**Stop Condition:** ${soul.lifecycle.stopCondition}\n\n`);
    }
    if (soul.lifecycle.triggerPhrase) {
      parts.push(`**Trigger Phrase:** When the stop condition is met, include \`${soul.lifecycle.triggerPhrase}\` in your response to signal session end.\n\n`);
    }
  }

  parts.push('---\n');

  return parts.join('');
}

/**
 * SoulLoader class for caching and managing SOUL.md loading.
 */
export class SoulLoader {
  private cache: Map<string, SoulContent> = new Map();
  private lastLoadTime: Map<string, number> = new Map();
  private readonly cacheTtlMs: number;

  constructor(cacheTtlMs: number = 60000) { // Default 1 minute TTL
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Get merged SOUL content with caching.
   *
   * @param skillName - Optional skill name
   * @param forceReload - Force reload from disk
   * @returns Merged SoulContent or null
   */
  async getSoul(skillName?: string, forceReload = false): Promise<SoulContent | null> {
    const cacheKey = skillName || '__default__';
    const now = Date.now();
    const lastLoad = this.lastLoadTime.get(cacheKey) || 0;

    // Return cached if valid and not forcing reload
    if (!forceReload && this.cache.has(cacheKey) && (now - lastLoad) < this.cacheTtlMs) {
      return this.cache.get(cacheKey) || null;
    }

    // Load from disk
    const soul = await loadMergedSoul(skillName);

    if (soul) {
      this.cache.set(cacheKey, soul);
      this.lastLoadTime.set(cacheKey, now);
    }

    return soul;
  }

  /**
   * Clear the cache.
   */
  clearCache(): void {
    this.cache.clear();
    this.lastLoadTime.clear();
  }
}

// Export singleton instance for convenience
export const soulLoader = new SoulLoader();
