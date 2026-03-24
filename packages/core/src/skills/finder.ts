/**
 * Skill Finder - Simple skill file discovery for Agent SDK.
 *
 * This module provides a simple skill search mechanism as described in Issue #430:
 * - Find skill files by name across multiple search paths
 * - No YAML parsing - just return file paths
 * - Support project, workspace, and package domains
 *
 * Design Principles:
 * - Simple and minimal - no complex parsing
 * - Just find and return file paths
 * - Let the caller read and process the markdown content
 *
 * @example
 * ```typescript
 * import { findSkill, listSkills } from './skills/finder.js';
 *
 * // Find a specific skill
 * const skillPath = await findSkill('evaluator');
 * // Returns: '/path/to/skills/evaluator/SKILL.md'
 *
 * // List all available skills
 * const skills = await listSkills();
 * // Returns: [{ name: 'evaluator', path: '...' }, ...]
 * ```
 *
 * @module skills/finder
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SkillFinder');

/**
 * Represents a discovered skill.
 */
export interface DiscoveredSkill {
  /** Skill name (derived from directory name) */
  name: string;
  /** Absolute path to the SKILL.md file */
  path: string;
  /** Domain where the skill was found */
  domain: 'project' | 'workspace' | 'package';
}

/**
 * Search path configuration for skill discovery.
 */
export interface SkillSearchPath {
  /** Directory path to search */
  path: string;
  /** Domain identifier */
  domain: 'project' | 'workspace' | 'package';
  /** Priority (higher = searched first) */
  priority: number;
}

/**
 * Get the default search paths for skills.
 *
 * Search order (higher priority first):
 * 1. Project domain: `.claude/skills/` in current working directory
 * 2. Workspace domain: `.claude/skills/` in configured workspace
 * 3. Package domain: `skills/` in package installation directory
 *
 * @returns Array of search paths sorted by priority
 */
export function getDefaultSearchPaths(): SkillSearchPath[] {
  const cwd = process.cwd();
  const workspaceDir = Config.getWorkspaceDir();
  const packageDir = Config.getSkillsDir();

  const paths: SkillSearchPath[] = [
    // Project domain - highest priority (user's custom skills)
    { path: path.join(cwd, '.claude', 'skills'), domain: 'project', priority: 3 },

    // Workspace domain - medium priority
    { path: path.join(workspaceDir, '.claude', 'skills'), domain: 'workspace', priority: 2 },

    // Package domain - lowest priority (built-in skills)
    { path: packageDir, domain: 'package', priority: 1 },
  ];

  return paths.sort((a, b) => b.priority - a.priority);
}

/**
 * Find a skill by name across all search paths.
 *
 * Searches for `skills/<name>/SKILL.md` in each search path,
 * returning the first match (highest priority).
 *
 * @param name - Skill name to find
 * @param searchPaths - Optional custom search paths
 * @returns Absolute path to the skill file, or null if not found
 *
 * @example
 * ```typescript
 * const path = await findSkill('evaluator');
 * if (path) {
 *   console.log(`Found at: ${path}`);
 * }
 * ```
 */
export async function findSkill(
  name: string,
  searchPaths?: SkillSearchPath[]
): Promise<string | null> {
  const paths = searchPaths || getDefaultSearchPaths();

  for (const searchPath of paths) {
    const skillFile = path.join(searchPath.path, name, 'SKILL.md');

    try {
      await fs.access(skillFile);
      logger.debug({ name, path: skillFile, domain: searchPath.domain }, 'Found skill');
      return skillFile;
    } catch {
      // Continue to next search path
    }
  }

  logger.debug({ name, searchPaths: paths.map(p => p.path) }, 'Skill not found');
  return null;
}

/**
 * List all available skills across all search paths.
 *
 * Discovers all skills and returns them grouped by name.
 * If the same skill exists in multiple domains, only the
 * highest priority version is returned.
 *
 * @param searchPaths - Optional custom search paths
 * @returns Array of discovered skills
 *
 * @example
 * ```typescript
 * const skills = await listSkills();
 * for (const skill of skills) {
 *   console.log(`${skill.name}: ${skill.path} (${skill.domain})`);
 * }
 * ```
 */
export async function listSkills(
  searchPaths?: SkillSearchPath[]
): Promise<DiscoveredSkill[]> {
  const paths = searchPaths || getDefaultSearchPaths();
  const found = new Map<string, DiscoveredSkill>();

  for (const searchPath of paths) {
    try {
      const entries = await fs.readdir(searchPath.path, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const skillName = entry.name;
        const skillFile = path.join(searchPath.path, skillName, 'SKILL.md');

        try {
          await fs.access(skillFile);

          // Only add if not already found (higher priority wins)
          if (!found.has(skillName)) {
            found.set(skillName, {
              name: skillName,
              path: skillFile,
              domain: searchPath.domain,
            });
          }
        } catch {
          // Directory doesn't contain SKILL.md, skip
        }
      }
    } catch {
      // Search path doesn't exist or not readable, skip
    }
  }

  const skills = Array.from(found.values());
  logger.debug({ count: skills.length, skills: skills.map(s => s.name) }, 'Listed skills');

  return skills;
}

/**
 * Check if a skill exists.
 *
 * @param name - Skill name to check
 * @param searchPaths - Optional custom search paths
 * @returns True if skill exists
 */
export async function skillExists(
  name: string,
  searchPaths?: SkillSearchPath[]
): Promise<boolean> {
  const skillPath = await findSkill(name, searchPaths);
  return skillPath !== null;
}

/**
 * Read skill content directly.
 *
 * This is a convenience function that finds and reads the skill file.
 * Does not parse YAML - returns raw markdown content.
 *
 * @param name - Skill name to read
 * @param searchPaths - Optional custom search paths
 * @returns Raw markdown content, or null if not found
 *
 * @example
 * ```typescript
 * const content = await readSkillContent('evaluator');
 * if (content) {
 *   console.log(content);
 * }
 * ```
 */
export async function readSkillContent(
  name: string,
  searchPaths?: SkillSearchPath[]
): Promise<string | null> {
  const skillPath = await findSkill(name, searchPaths);

  if (!skillPath) {
    return null;
  }

  try {
    const content = await fs.readFile(skillPath, 'utf-8');
    return content;
  } catch (error) {
    logger.error({ error, skillPath }, 'Failed to read skill content');
    return null;
  }
}
