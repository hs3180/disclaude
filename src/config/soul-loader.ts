/**
 * SOUL.md Loader - Agent personality/behavior definition system.
 *
 * SOUL.md is a "personality definition" design pattern that defines AI's core
 * behavior guidelines through Markdown files. This allows Agents to drive
 * behavior through "self-awareness" rather than "rule constraints".
 *
 * @see Issue #1315
 * @see https://www.verysmallwoods.com/blog/20260205-openclaw-soul-md-design
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/**
 * Parsed SOUL content structure.
 */
export interface SoulContent {
  /** Core values and behavior guidelines */
  coreTruths: string[];
  /** What the Agent should NOT do */
  boundaries: string[];
  /** Lifecycle configuration (optional) */
  lifecycle?: {
    /** Condition for ending conversation */
    stopCondition?: string;
    /** Trigger phrase for ending */
    triggerPhrase?: string;
  };
}

/**
 * SOUL.md file location with priority.
 */
export interface SoulLocation {
  /** File path */
  path: string;
  /** Priority level (higher = more important) */
  priority: number;
  /** Description for logging */
  source: string;
}

/**
 * Cached SOUL content with timestamp.
 */
interface CachedSoul {
  content: SoulContent;
  loadedAt: number;
}

/** Cache TTL in milliseconds (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Global cache for loaded SOUL content */
const soulCache = new Map<string, CachedSoul>();

/**
 * Parse SOUL.md content into structured format.
 *
 * Supports three sections:
 * - Core Truths: Agent's core values and behavior guidelines
 * - Boundaries: What the Agent should NOT do
 * - Lifecycle (optional): Stop conditions and trigger phrases
 *
 * @param content - Raw markdown content
 * @returns Parsed SoulContent structure
 */
export function parseSoulContent(content: string): SoulContent {
  const result: SoulContent = {
    coreTruths: [],
    boundaries: [],
  };

  // Extract Core Truths section
  const coreTruthsMatch = content.match(/##\s*Core Truths\s*([\s\S]*?)(?=##\s|$)/i);
  if (coreTruthsMatch?.[1]) {
    result.coreTruths = parseListItems(coreTruthsMatch[1]);
  }

  // Extract Boundaries section
  const boundariesMatch = content.match(/##\s*Boundaries\s*([\s\S]*?)(?=##\s|$)/i);
  if (boundariesMatch?.[1]) {
    result.boundaries = parseListItems(boundariesMatch[1]);
  }

  // Extract Lifecycle section (optional)
  const lifecycleMatch = content.match(/##\s*Lifecycle\s*([\s\S]*?)(?=##\s|$)/i);
  if (lifecycleMatch?.[1]) {
    result.lifecycle = {};

    const stopConditionMatch = lifecycleMatch[1].match(/Stop Condition:\s*(.+?)(?:\n|$)/i);
    if (stopConditionMatch?.[1]) {
      result.lifecycle.stopCondition = stopConditionMatch[1].trim();
    }

    const triggerPhraseMatch = lifecycleMatch[1].match(/Trigger Phrase:\s*(.+?)(?:\n|$)/i);
    if (triggerPhraseMatch?.[1]) {
      result.lifecycle.triggerPhrase = triggerPhraseMatch[1].trim();
    }
  }

  return result;
}

/**
 * Parse list items from markdown content.
 * Supports both bullet points (-) and numbered lists (1.).
 *
 * @param content - Markdown content
 * @returns Array of list items
 */
function parseListItems(content: string): string[] {
  const items: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    // Match bullet points: - item or * item
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (bulletMatch?.[1]) {
      items.push(bulletMatch[1].trim());
      continue;
    }

    // Match numbered lists: 1. item
    const numberedMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (numberedMatch?.[1]) {
      items.push(numberedMatch[1].trim());
    }
  }

  return items;
}

/**
 * Get all possible SOUL.md file locations with priorities.
 *
 * Priority order (highest to lowest):
 * 1. ~/.disclaude/SOUL.md - User-defined personality (highest priority)
 * 2. skills/{skill}/SOUL.md - Skill-specific personality
 * 3. config/SOUL.md - System default personality (lowest priority)
 *
 * @param skillName - Optional skill name for skill-specific SOUL
 * @param configDir - Optional config directory path
 * @param skillsDir - Optional skills directory path
 * @returns Array of SoulLocation objects
 */
export function getSoulLocations(
  skillName?: string,
  configDir?: string,
  skillsDir?: string
): SoulLocation[] {
  const locations: SoulLocation[] = [];

  // Priority 1: User-defined personality (highest)
  const homeDir = os.homedir();
  const userSoulPath = path.join(homeDir, '.disclaude', 'SOUL.md');
  locations.push({
    path: userSoulPath,
    priority: 3,
    source: 'user-defined',
  });

  // Priority 2: Skill-specific personality
  if (skillName && skillsDir) {
    const skillSoulPath = path.join(skillsDir, skillName, 'SOUL.md');
    locations.push({
      path: skillSoulPath,
      priority: 2,
      source: `skill:${skillName}`,
    });
  }

  // Priority 3: System default personality (lowest)
  if (configDir) {
    const systemSoulPath = path.join(configDir, 'SOUL.md');
    locations.push({
      path: systemSoulPath,
      priority: 1,
      source: 'system-default',
    });
  }

  return locations;
}

/**
 * Load SOUL.md content from a file.
 *
 * @param filePath - Path to SOUL.md file
 * @returns Parsed SoulContent or null if file doesn't exist
 */
function loadSoulFile(filePath: string): SoulContent | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return parseSoulContent(content);
  } catch (error) {
    logger.debug({ err: error, filePath }, 'Failed to load SOUL.md file');
    return null;
  }
}

/**
 * Merge multiple SoulContent objects.
 * Higher priority content overrides lower priority content for each section.
 *
 * @param contents - Array of SoulContent objects (ordered by priority, lowest first)
 * @returns Merged SoulContent
 */
export function mergeSoulContents(contents: SoulContent[]): SoulContent {
  const merged: SoulContent = {
    coreTruths: [],
    boundaries: [],
  };

  // Process in order (lowest priority first, highest priority last)
  // This way, higher priority items come last and take precedence
  for (const content of contents) {
    if (content.coreTruths.length > 0) {
      merged.coreTruths = [...merged.coreTruths, ...content.coreTruths];
    }
    if (content.boundaries.length > 0) {
      merged.boundaries = [...merged.boundaries, ...content.boundaries];
    }
    if (content.lifecycle) {
      merged.lifecycle = {
        ...merged.lifecycle,
        ...content.lifecycle,
      };
    }
  }

  return merged;
}

/**
 * Format SoulContent for injection into Agent system prompt.
 *
 * @param soul - SoulContent to format
 * @returns Formatted markdown string
 */
export function formatSoulForPrompt(soul: SoulContent): string {
  const parts: string[] = [];

  if (soul.coreTruths.length > 0) {
    parts.push('## Core Truths');
    parts.push('');
    parts.push('These are your core values and behavior guidelines:');
    parts.push('');
    for (const truth of soul.coreTruths) {
      parts.push(`- ${truth}`);
    }
  }

  if (soul.boundaries.length > 0) {
    if (parts.length > 0) {
      parts.push('');
    }
    parts.push('## Boundaries');
    parts.push('');
    parts.push('These are things you should NOT do:');
    parts.push('');
    for (const boundary of soul.boundaries) {
      parts.push(`- ${boundary}`);
    }
  }

  if (soul.lifecycle) {
    if (parts.length > 0) {
      parts.push('');
    }
    parts.push('## Lifecycle');
    parts.push('');
    if (soul.lifecycle.stopCondition) {
      parts.push(`**Stop Condition**: ${soul.lifecycle.stopCondition}`);
    }
    if (soul.lifecycle.triggerPhrase) {
      parts.push(`**Trigger Phrase**: ${soul.lifecycle.triggerPhrase}`);
    }
  }

  return parts.join('\n');
}

/**
 * SoulLoader class for loading and caching SOUL.md content.
 */
export class SoulLoader {
  private readonly configDir: string;
  private readonly skillsDir: string;
  private readonly cacheTtl: number;

  constructor(options: {
    configDir: string;
    skillsDir: string;
    cacheTtl?: number;
  }) {
    this.configDir = options.configDir;
    this.skillsDir = options.skillsDir;
    this.cacheTtl = options.cacheTtl ?? CACHE_TTL_MS;
  }

  /**
   * Load merged SOUL content from all available sources.
   *
   * @param skillName - Optional skill name for skill-specific SOUL
   * @param forceRefresh - Force cache refresh
   * @returns Merged SoulContent or null if no SOUL.md files exist
   */
  loadMergedSoul(skillName?: string, forceRefresh = false): SoulContent | null {
    const cacheKey = skillName ?? 'default';

    // Check cache
    if (!forceRefresh) {
      const cached = soulCache.get(cacheKey);
      if (cached && Date.now() - cached.loadedAt < this.cacheTtl) {
        logger.debug({ cacheKey }, 'Using cached SOUL content');
        return cached.content;
      }
    }

    // Get all locations
    const locations = getSoulLocations(skillName, this.configDir, this.skillsDir);

    // Load content from each location (lowest priority first)
    const contents: SoulContent[] = [];
    const sortedLocations = [...locations].sort((a, b) => a.priority - b.priority);

    for (const location of sortedLocations) {
      const content = loadSoulFile(location.path);
      if (content) {
        logger.debug(
          { path: location.path, source: location.source },
          'Loaded SOUL.md file'
        );
        contents.push(content);
      }
    }

    if (contents.length === 0) {
      logger.debug('No SOUL.md files found');
      return null;
    }

    // Merge contents
    const merged = mergeSoulContents(contents);

    // Cache result
    soulCache.set(cacheKey, {
      content: merged,
      loadedAt: Date.now(),
    });

    logger.info(
      {
        coreTruthsCount: merged.coreTruths.length,
        boundariesCount: merged.boundaries.length,
        hasLifecycle: !!merged.lifecycle,
      },
      'Merged SOUL content loaded'
    );

    return merged;
  }

  /**
   * Clear the cache.
   */
  clearCache(): void {
    soulCache.clear();
    logger.debug('SOUL cache cleared');
  }
}

/**
 * Default export for convenience.
 */
export default SoulLoader;
