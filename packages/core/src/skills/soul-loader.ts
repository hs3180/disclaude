/**
 * SOUL Loader - SOUL.md file discovery and loading for Agent personality definitions.
 *
 * This module provides SOUL.md discovery and loading as described in Issue #1315:
 * - Find SOUL.md files across multiple search paths (config, skill, user)
 * - Load and merge SOUL.md content with priority
 * - Support lifecycle configuration (Stop Condition, Trigger Phrase)
 *
 * Design Principles:
 * - Similar to SkillFinder but for personality definitions
 * - Multiple levels: system default < skill-specific < user custom
 * - Mergable content with priority
 *
 * @example
 * ```typescript
 * import { findSoul, loadSoul, mergeSouls } from './skills/soul-loader.js';
 *
 * // Find all SOUL.md files for a context
 * const soulPaths = await findSoul({ skillName: 'pilot' });
 *
 * // Load a specific SOUL.md
 * const soul = await loadSoul(soulPaths[0]);
 *
 * // Merge multiple SOULs with priority
 * const mergedSoul = mergeSouls([defaultSoul, skillSoul, userSoul]);
 * ```
 *
 * @module skills/soul-loader
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/**
 * Represents a discovered SOUL.md file.
 */
export interface DiscoveredSoul {
  /** Soul name or context (e.g., 'default', 'pilot', 'user') */
  name: string;
  /** Absolute path to the SOUL.md file */
  path: string;
  /** Level where the soul was found */
  level: SoulLevel;
  /** Priority (higher = more important) */
  priority: number;
}

/**
 * Soul level for priority ordering.
 */
export type SoulLevel = 'default' | 'skill' | 'user';

/**
 * Options for soul discovery.
 */
export interface FindSoulOptions {
  /** Skill name to look for skill-specific SOUL.md */
  skillName?: string;
  /** Chat ID for context (future: per-chat SOUL customization) */
  chatId?: string;
}

/**
 * Parsed SOUL.md content.
 */
export interface SoulContent {
  /** Soul name/identifier */
  name: string;
  /** Core truths section (raw markdown) */
  coreTruths?: string;
  /** Boundaries section (raw markdown) */
  boundaries?: string;
  /** Lifecycle configuration */
  lifecycle?: SoulLifecycle;
  /** Raw content */
  raw: string;
  /** Source path */
  source: string;
}

/**
 * Lifecycle configuration for session management.
 */
export interface SoulLifecycle {
  /** Condition to stop the session */
  stopCondition?: string;
  /** Phrase that triggers session end */
  triggerPhrase?: string;
}

/**
 * Search path configuration for SOUL discovery.
 */
interface SoulSearchPath {
  path: string;
  level: SoulLevel;
  priority: number;
  name: string;
}

/**
 * Get the default search paths for SOUL.md files.
 *
 * Search order (higher priority first):
 * 1. User level: ~/.disclaude/SOUL.md
 * 2. Skill level: skills/{skillName}/SOUL.md
 * 3. Default level: config/SOUL.md
 *
 * @param options - Discovery options
 * @returns Array of search paths sorted by priority
 */
export function getSoulSearchPaths(options: FindSoulOptions = {}): SoulSearchPath[] {
  const cwd = process.cwd();
  const workspaceDir = Config.getWorkspaceDir();
  const skillsDir = Config.getSkillsDir();
  const userHome = process.env.HOME || process.env.USERPROFILE || '';

  const paths: SoulSearchPath[] = [
    // User level - highest priority (user's custom personality)
    {
      path: path.join(userHome, '.disclaude', 'SOUL.md'),
      level: 'user',
      priority: 30,
      name: 'user',
    },

    // Skill level - medium priority (skill-specific personality)
    ...(options.skillName
      ? [
          {
            path: path.join(skillsDir, options.skillName, 'SOUL.md'),
            level: 'skill' as const,
            priority: 20,
            name: options.skillName,
          },
          {
            path: path.join(workspaceDir, '.claude', 'skills', options.skillName, 'SOUL.md'),
            level: 'skill' as const,
            priority: 21,
            name: `${options.skillName}-workspace`,
          },
          {
            path: path.join(cwd, '.claude', 'skills', options.skillName, 'SOUL.md'),
            level: 'skill' as const,
            priority: 22,
            name: `${options.skillName}-project`,
          },
        ]
      : []),

    // Default level - lowest priority (system default personality)
    {
      path: path.join(workspaceDir, 'config', 'SOUL.md'),
      level: 'default',
      priority: 10,
      name: 'default',
    },
    {
      path: path.join(cwd, 'config', 'SOUL.md'),
      level: 'default',
      priority: 11,
      name: 'default-project',
    },
  ];

  return paths.sort((a, b) => b.priority - a.priority);
}

/**
 * Find all available SOUL.md files for the given context.
 *
 * Searches for SOUL.md files across all levels and returns
 * those that exist.
 *
 * @param options - Discovery options
 * @returns Array of discovered souls (may be empty)
 */
export async function findSoul(options: FindSoulOptions = {}): Promise<DiscoveredSoul[]> {
  const searchPaths = getSoulSearchPaths(options);
  const discovered: DiscoveredSoul[] = [];

  for (const searchPath of searchPaths) {
    try {
      await fs.access(searchPath.path);
      discovered.push({
        name: searchPath.name,
        path: searchPath.path,
        level: searchPath.level,
        priority: searchPath.priority,
      });
      logger.debug({ name: searchPath.name, path: searchPath.path }, 'Found SOUL.md');
    } catch {
      // File doesn't exist, skip
    }
  }

  logger.debug({ count: discovered.length }, 'SOUL discovery complete');
  return discovered;
}

/**
 * Load and parse a SOUL.md file.
 *
 * Extracts sections (Core Truths, Boundaries, Lifecycle) from the markdown.
 *
 * @param soulPath - Path to SOUL.md file
 * @returns Parsed soul content
 */
export async function loadSoul(soulPath: string): Promise<SoulContent> {
  const raw = await fs.readFile(soulPath, 'utf-8');
  const name = path.basename(path.dirname(soulPath));

  // Extract sections
  const coreTruths = extractSection(raw, 'Core Truths', 'Boundaries');
  const boundaries = extractSection(raw, 'Boundaries', 'Lifecycle');
  const lifecycleSection = extractSection(raw, 'Lifecycle', null);

  // Parse lifecycle configuration
  const lifecycle = parseLifecycle(lifecycleSection);

  return {
    name,
    coreTruths,
    boundaries,
    lifecycle,
    raw,
    source: soulPath,
  };
}

/**
 * Extract a section from markdown by header.
 *
 * @param content - Full markdown content
 * @param sectionName - Section header to find
 * @param nextSection - Next section header (for boundary)
 * @returns Section content or undefined
 */
function extractSection(
  content: string,
  sectionName: string,
  nextSection: string | null
): string | undefined {
  // Try different header levels (## or ###)
  const headerPatterns = [
    new RegExp(`^##\\s+${sectionName}\\s*$`, 'm'),
    new RegExp(`^###\\s+${sectionName}\\s*$`, 'm'),
  ];

  let startIndex = -1;
  for (const pattern of headerPatterns) {
    const match = content.match(pattern);
    if (match && match.index !== undefined) {
      startIndex = match.index + match[0].length;
      break;
    }
  }

  if (startIndex === -1) {
    return undefined;
  }

  let endIndex = content.length;

  // Find the next section if specified
  if (nextSection) {
    const nextPatterns = [
      new RegExp(`^##\\s+`, 'm'),
      new RegExp(`^###\\s+`, 'm'),
    ];

    for (const pattern of nextPatterns) {
      const match = content.slice(startIndex).match(pattern);
      if (match && match.index !== undefined) {
        const potentialEnd = startIndex + match.index;
        if (potentialEnd < endIndex) {
          endIndex = potentialEnd;
        }
      }
    }
  }

  const sectionContent = content.slice(startIndex, endIndex).trim();
  return sectionContent || undefined;
}

/**
 * Parse lifecycle configuration from markdown.
 *
 * Supports:
 * - Stop Condition: ...
 * - Trigger Phrase: ...
 *
 * @param content - Lifecycle section content
 * @returns Parsed lifecycle configuration
 */
function parseLifecycle(content: string | undefined): SoulLifecycle | undefined {
  if (!content) {
    return undefined;
  }

  const lifecycle: SoulLifecycle = {};

  // Extract Stop Condition
  const stopMatch = content.match(/Stop Condition:\s*(.+)/i);
  if (stopMatch) {
    lifecycle.stopCondition = stopMatch[1].trim();
  }

  // Extract Trigger Phrase
  const triggerMatch = content.match(/Trigger Phrase:\s*(.+)/i);
  if (triggerMatch) {
    lifecycle.triggerPhrase = triggerMatch[1].trim();
  }

  return Object.keys(lifecycle).length > 0 ? lifecycle : undefined;
}

/**
 * Merge multiple SOULs with priority.
 *
 * Higher priority souls override lower priority ones.
 * Sections are merged intelligently:
 * - Core Truths: concatenated with priority
 * - Boundaries: concatenated with priority
 * - Lifecycle: highest priority wins
 *
 * @param souls - Array of soul contents (should be sorted by priority, highest first)
 * @returns Merged soul content
 */
export function mergeSouls(souls: SoulContent[]): SoulContent {
  if (souls.length === 0) {
    return { name: 'empty', raw: '', source: 'merged' };
  }

  if (souls.length === 1) {
    return souls[0];
  }

  // Sort by priority (higher first)
  const sorted = [...souls].sort((a, b) => {
    const getPriority = (s: SoulContent): number => {
      if (s.source.includes('.disclaude')) return 30;
      if (s.source.includes('skills')) return 20;
      return 10;
    };
    return getPriority(b) - getPriority(a);
  });

  // Merge sections
  const coreTruthsParts: string[] = [];
  const boundariesParts: string[] = [];
  let mergedLifecycle: SoulLifecycle | undefined;

  for (const soul of sorted) {
    if (soul.coreTruths) {
      coreTruthsParts.push(`<!-- From ${soul.name} -->\n${soul.coreTruths}`);
    }
    if (soul.boundaries) {
      boundariesParts.push(`<!-- From ${soul.name} -->\n${soul.boundaries}`);
    }
    // Lifecycle: highest priority wins
    if (soul.lifecycle && !mergedLifecycle) {
      mergedLifecycle = soul.lifecycle;
    }
  }

  // Build merged content
  const parts: string[] = [];

  if (coreTruthsParts.length > 0) {
    parts.push('## Core Truths\n\n' + coreTruthsParts.join('\n\n'));
  }

  if (boundariesParts.length > 0) {
    parts.push('## Boundaries\n\n' + boundariesParts.join('\n\n'));
  }

  if (mergedLifecycle) {
    const lifecycleParts: string[] = [];
    if (mergedLifecycle.stopCondition) {
      lifecycleParts.push(`Stop Condition: ${mergedLifecycle.stopCondition}`);
    }
    if (mergedLifecycle.triggerPhrase) {
      lifecycleParts.push(`Trigger Phrase: ${mergedLifecycle.triggerPhrase}`);
    }
    if (lifecycleParts.length > 0) {
      parts.push('## Lifecycle\n\n' + lifecycleParts.join('\n'));
    }
  }

  return {
    name: 'merged',
    coreTruths: coreTruthsParts.join('\n\n'),
    boundaries: boundariesParts.join('\n\n'),
    lifecycle: mergedLifecycle,
    raw: parts.join('\n\n---\n\n'),
    source: 'merged',
  };
}

/**
 * Load all applicable SOULs and merge them.
 *
 * Convenience function that combines findSoul, loadSoul, and mergeSouls.
 *
 * @param options - Discovery options
 * @returns Merged soul content, or undefined if no souls found
 */
export async function loadMergedSoul(options: FindSoulOptions = {}): Promise<SoulContent | undefined> {
  const discovered = await findSoul(options);

  if (discovered.length === 0) {
    logger.debug('No SOUL.md files found');
    return undefined;
  }

  const souls = await Promise.all(discovered.map(d => loadSoul(d.path)));
  const merged = mergeSouls(souls);

  logger.debug(
    {
      soulCount: souls.length,
      sources: souls.map(s => s.source),
    },
    'Merged SOULs loaded'
  );

  return merged;
}

/**
 * Format soul content for injection into agent prompt.
 *
 * @param soul - Soul content to format
 * @returns Formatted markdown string
 */
export function formatSoulForPrompt(soul: SoulContent): string {
  if (!soul.raw) {
    return '';
  }

  return `

---

## Agent Personality (SOUL)

${soul.raw}
`;
}
