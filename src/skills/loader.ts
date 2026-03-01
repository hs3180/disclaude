/**
 * FileSystemSkillLoader - File system based skill loader implementation.
 *
 * Provides a minimal implementation for loading skills from the file system:
 * - Load individual skill files
 * - Discover skills in directories
 * - Search across multiple paths
 *
 * Design Principles (from Issue #430):
 * - Simple and minimal - no complex YAML parsing
 * - Just read markdown files and extract basic metadata
 * - No backward compatibility concerns
 *
 * @module skills/loader
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { Skill, SkillLoader, SkillSearchPath, SkillFrontmatter } from './types.js';

/**
 * Default skill file name to look for in subdirectories.
 */
const SKILL_FILE_NAME = 'SKILL.md';

/**
 * File system based implementation of SkillLoader.
 *
 * @example
 * ```typescript
 * const loader = new FileSystemSkillLoader();
 *
 * // Load a single skill
 * const skill = await loader.loadSkill('/path/to/skills/evaluator/SKILL.md');
 *
 * // Load all skills from a directory
 * const skills = await loader.loadSkillsFromDirectory('/path/to/skills');
 *
 * // Search across multiple paths
 * const allSkills = await loader.searchSkills([
 *   { path: '.claude/skills', domain: 'project', priority: 3 },
 *   { path: 'workspace/.claude/skills', domain: 'workspace', priority: 2 },
 *   { path: 'skills', domain: 'package', priority: 1 },
 * ]);
 * ```
 */
export class FileSystemSkillLoader implements SkillLoader {
  private readonly logger = createLogger('SkillLoader');

  /**
   * Load a single skill from a file path.
   *
   * @param skillPath - Absolute or relative path to skill file
   * @returns Loaded skill with metadata and content
   * @throws Error if file cannot be read
   */
  async loadSkill(skillPath: string): Promise<Skill> {
    this.logger.debug({ path: skillPath }, 'Loading skill');

    const content = await fs.readFile(skillPath, 'utf-8');
    const frontmatter = this.parseFrontmatter(content);
    const name = this.extractSkillName(frontmatter, skillPath);

    const skill: Skill = {
      name,
      description: frontmatter.description,
      allowedTools: frontmatter['allowed-tools'],
      content,
      path: skillPath,
    };

    this.logger.debug(
      {
        name: skill.name,
        description: skill.description,
        allowedTools: skill.allowedTools,
        path: skillPath,
      },
      'Skill loaded'
    );

    return skill;
  }

  /**
   * Load all skills from a directory.
   *
   * Looks for SKILL.md files in subdirectories:
   * ```
   * skills/
   * ├── evaluator/
   * │   └── SKILL.md
   * ├── executor/
   * │   └── SKILL.md
   * └── reporter/
   *     └── SKILL.md
   * ```
   *
   * @param dir - Directory path containing skill subdirectories
   * @returns Array of loaded skills
   */
  async loadSkillsFromDirectory(dir: string): Promise<Skill[]> {
    this.logger.debug({ dir }, 'Loading skills from directory');

    const skills: Skill[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const skillPath = path.join(dir, entry.name, SKILL_FILE_NAME);
        try {
          const skill = await this.loadSkill(skillPath);
          skills.push(skill);
        } catch (error) {
          // Skip directories without SKILL.md
          this.logger.debug(
            { dir: entry.name, error: error instanceof Error ? error.message : String(error) },
            'No SKILL.md found in directory, skipping'
          );
        }
      }
    } catch (error) {
      // Directory doesn't exist, return empty array
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug({ dir }, 'Directory does not exist, returning empty skills');
        return [];
      }
      throw error;
    }

    this.logger.debug({ dir, count: skills.length }, 'Skills loaded from directory');
    return skills;
  }

  /**
   * Search for skills across multiple paths.
   *
   * Searches in priority order and deduplicates by skill name.
   * Higher priority paths override lower priority ones.
   *
   * @param paths - Search paths with priority information
   * @returns Array of loaded skills (deduplicated)
   */
  async searchSkills(paths: SkillSearchPath[]): Promise<Skill[]> {
    this.logger.debug({ paths: paths.map(p => p.path) }, 'Searching for skills');

    // Sort by priority (higher first)
    const sortedPaths = [...paths].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    );

    const skillMap = new Map<string, Skill>();

    for (const searchPath of sortedPaths) {
      try {
        const skills = await this.loadSkillsFromDirectory(searchPath.path);

        for (const skill of skills) {
          // Only add if not already present (higher priority wins)
          if (!skillMap.has(skill.name)) {
            skillMap.set(skill.name, skill);
          } else {
            this.logger.debug(
              { name: skill.name, existingPath: skillMap.get(skill.name)?.path, newPath: skill.path },
              'Skill already loaded from higher priority path, skipping'
            );
          }
        }
      } catch (error) {
        this.logger.debug(
          { path: searchPath.path, error: error instanceof Error ? error.message : String(error) },
          'Failed to load skills from path'
        );
      }
    }

    const result = Array.from(skillMap.values());
    this.logger.debug({ count: result.length }, 'Skills search completed');
    return result;
  }

  /**
   * Parse YAML frontmatter from skill markdown content.
   *
   * Uses simple regex parsing - no complex YAML library needed.
   * Only extracts basic fields: name, description, allowed-tools.
   *
   * @param content - Raw markdown content with optional frontmatter
   * @returns Parsed frontmatter object
   */
  private parseFrontmatter(content: string): SkillFrontmatter {
    const frontmatter: SkillFrontmatter = {};

    // Check for YAML frontmatter between --- markers
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
      return frontmatter;
    }

    const [, yaml] = match;

    // Parse name
    const nameMatch = yaml.match(/^name:\s*(.+)$/m);
    if (nameMatch) {
      const [, name] = nameMatch;
      frontmatter.name = name.trim();
    }

    // Parse description
    const descMatch = yaml.match(/^description:\s*(.+)$/m);
    if (descMatch) {
      const [, desc] = descMatch;
      frontmatter.description = desc.trim();
    }

    // Parse allowed-tools (can be array format: [Tool1, Tool2])
    const toolsMatch = yaml.match(/^allowed-tools:\s*\[(.+)\]$/m);
    if (toolsMatch) {
      const [, toolsStr] = toolsMatch;
      frontmatter['allowed-tools'] = toolsStr
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);
    }

    return frontmatter;
  }

  /**
   * Extract skill name from frontmatter or file path.
   *
   * @param frontmatter - Parsed frontmatter
   * @param skillPath - Path to skill file
   * @returns Skill name
   */
  private extractSkillName(frontmatter: SkillFrontmatter, skillPath: string): string {
    // Use frontmatter name if available
    if (frontmatter.name) {
      return frontmatter.name;
    }

    // Fall back to directory name
    const dirName = path.basename(path.dirname(skillPath));
    return dirName;
  }
}
