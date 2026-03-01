/**
 * SkillLoader - Generic skill loading for Agent SDK.
 *
 * This module provides a generic skill loading mechanism as described in Issue #430:
 * - Load skill files from various paths
 * - Search skills from multiple directories
 * - Support for project, workspace, and package domains
 *
 * @module skills/skill-loader
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('SkillLoader');

/**
 * Represents a loaded skill with its metadata and content.
 */
export interface Skill {
  /** Skill name (derived from directory name or file name) */
  name: string;

  /** Skill description (extracted from first heading or frontmatter) */
  description: string;

  /** List of allowed tools (if specified in skill file) */
  allowedTools?: string[];

  /** Raw skill content (markdown) */
  content: string;

  /** Path to the skill file */
  filePath: string;
}

/**
 * Options for loading skills.
 */
export interface SkillLoaderOptions {
  /** Additional search paths ( prepended to default paths) */
  searchPaths?: string[];

  /** Skill file name to look for (default: 'SKILL.md') */
  skillFileName?: string;
}

/**
 * Default skill file name.
 */
const DEFAULT_SKILL_FILE_NAME = 'SKILL.md';

/**
 * SkillLoader - Generic skill loading utility.
 *
 * Provides methods to:
 * - Load a single skill from a file path
 * - Load all skills from a directory
 * - Search skills across multiple directories
 *
 * @example
 * ```typescript
 * const loader = new SkillLoader();
 *
 * // Load a single skill
 * const skill = await loader.loadSkill('skills/evaluator/SKILL.md');
 *
 * // Load all skills from a directory
 * const skills = await loader.loadSkillsFromDirectory('skills');
 *
 * // Search skills across default paths
 * const allSkills = await loader.searchSkills();
 * ```
 */
export class SkillLoader {
  private skillFileName: string;
  private additionalSearchPaths: string[];

  /**
   * Create a SkillLoader.
   *
   * @param options - Loader options
   */
  constructor(options: SkillLoaderOptions = {}) {
    this.skillFileName = options.skillFileName || DEFAULT_SKILL_FILE_NAME;
    this.additionalSearchPaths = options.searchPaths || [];
  }

  /**
   * Get the default skill search paths in priority order.
   *
   * Priority order (highest to lowest):
   * 1. Project domain: `.claude/skills/` (user-defined skills)
   * 2. Workspace domain: `workspace/.claude/skills/`
   * 3. Package domain: `skills/` (built-in skills)
   *
   * @returns Array of search paths
   */
  getDefaultSearchPaths(): string[] {
    const workspaceDir = Config.getWorkspaceDir();
    const packageDir = Config.getSkillsDir();

    return [
      ...this.additionalSearchPaths,
      // Project domain (user-defined skills)
      path.join(workspaceDir, '.claude', 'skills'),
      // Workspace domain
      path.join(workspaceDir, 'workspace', '.claude', 'skills'),
      // Package domain (built-in skills)
      packageDir,
    ];
  }

  /**
   * Load a skill from a file path.
   *
   * @param skillPath - Path to the skill file (absolute or relative to workspace)
   * @returns Loaded skill
   * @throws Error if file cannot be read
   */
  async loadSkill(skillPath: string): Promise<Skill> {
    // Resolve path
    const resolvedPath = path.isAbsolute(skillPath)
      ? skillPath
      : path.join(Config.getWorkspaceDir(), skillPath);

    logger.debug({ skillPath: resolvedPath }, 'Loading skill');

    // Read file content
    const content = await fs.readFile(resolvedPath, 'utf-8');

    // Extract skill metadata
    const name = this.extractSkillName(resolvedPath, content);
    const description = this.extractDescription(content);
    const allowedTools = this.extractAllowedTools(content);

    const skill: Skill = {
      name,
      description,
      content,
      filePath: resolvedPath,
    };

    if (allowedTools && allowedTools.length > 0) {
      skill.allowedTools = allowedTools;
    }

    logger.debug({ skillName: name, path: resolvedPath }, 'Skill loaded');
    return skill;
  }

  /**
   * Load all skills from a directory.
   *
   * Looks for subdirectories containing skill files (SKILL.md by default).
   *
   * @param dirPath - Directory path to search
   * @returns Array of loaded skills
   */
  async loadSkillsFromDirectory(dirPath: string): Promise<Skill[]> {
    // Resolve path
    const resolvedPath = path.isAbsolute(dirPath)
      ? dirPath
      : path.join(Config.getWorkspaceDir(), dirPath);

    logger.debug({ dirPath: resolvedPath }, 'Loading skills from directory');

    const skills: Skill[] = [];

    try {
      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const skillFilePath = path.join(resolvedPath, entry.name, this.skillFileName);

        try {
          const skill = await this.loadSkill(skillFilePath);
          // Override name with directory name for consistency
          skill.name = entry.name;
          skills.push(skill);
        } catch (error) {
          // Skip directories without skill files
          logger.debug({
            dirName: entry.name,
            skillFile: skillFilePath,
          }, 'No skill file in directory, skipping');
        }
      }
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === 'ENOENT') {
        logger.debug({ dirPath: resolvedPath }, 'Directory does not exist, returning empty array');
        return [];
      }
      throw error;
    }

    logger.debug({ count: skills.length, dirPath: resolvedPath }, 'Skills loaded from directory');
    return skills;
  }

  /**
   * Search for skills across multiple directories.
   *
   * Searches in priority order and returns the first occurrence of each skill.
   * Later paths override earlier ones if they have the same skill name.
   *
   * @param searchPaths - Paths to search (uses default paths if not provided)
   * @returns Array of loaded skills (deduplicated by name)
   */
  async searchSkills(searchPaths?: string[]): Promise<Skill[]> {
    const paths = searchPaths || this.getDefaultSearchPaths();

    logger.debug({ searchPaths: paths }, 'Searching for skills');

    const skillMap = new Map<string, Skill>();

    // Search in reverse order so higher priority paths override lower ones
    for (const searchPath of paths) {
      try {
        const skills = await this.loadSkillsFromDirectory(searchPath);

        for (const skill of skills) {
          // Later (higher priority) paths override earlier ones
          skillMap.set(skill.name, skill);
        }
      } catch (error) {
        logger.debug({ searchPath, error }, 'Failed to search path, continuing');
      }
    }

    const skills = Array.from(skillMap.values());
    logger.debug({ count: skills.length }, 'Skills found across all paths');
    return skills;
  }

  /**
   * Find a specific skill by name across search paths.
   *
   * @param skillName - Name of the skill to find
   * @param searchPaths - Paths to search (uses default paths if not provided)
   * @returns The skill if found, undefined otherwise
   */
  async findSkill(skillName: string, searchPaths?: string[]): Promise<Skill | undefined> {
    const paths = searchPaths || this.getDefaultSearchPaths();

    for (const searchPath of paths) {
      const skillFilePath = path.join(searchPath, skillName, this.skillFileName);

      try {
        const skill = await this.loadSkill(skillFilePath);
        skill.name = skillName; // Ensure consistent naming
        return skill;
      } catch {
        // Continue to next path
      }
    }

    logger.debug({ skillName }, 'Skill not found in any search path');
    return undefined;
  }

  /**
   * Extract skill name from file path or content.
   */
  private extractSkillName(filePath: string, content: string): string {
    // First try to get from first heading
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      // Clean up heading (remove "Skill:" prefix if present)
      let name = headingMatch[1].trim();
      name = name.replace(/^Skill:\s*/i, '');
      return name;
    }

    // Fall back to file name without extension
    const fileName = path.basename(filePath, '.md');

    // If the file is named "SKILL" (default skill file name), use parent directory name
    if (fileName === this.skillFileName.replace('.md', '')) {
      const dirName = path.basename(path.dirname(filePath));
      if (dirName && dirName !== '.' && dirName !== '..') {
        return dirName;
      }
    }

    return fileName;
  }

  /**
   * Extract description from content.
   *
   * Uses the first paragraph after the main heading.
   */
  private extractDescription(content: string): string {
    // Remove frontmatter if present
    let cleaned = content.replace(/^---\n[\s\S]*?\n---\n/, '');

    // Remove first heading
    cleaned = cleaned.replace(/^#\s+.+$\n?/m, '');

    // Find first non-empty paragraph
    const lines = cleaned.split('\n');
    const paragraphLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines at start
      if (paragraphLines.length === 0 && !trimmed) {
        continue;
      }

      // Stop at next heading or empty line after content
      if (trimmed.startsWith('#') || (paragraphLines.length > 0 && !trimmed)) {
        break;
      }

      paragraphLines.push(trimmed);
    }

    const description = paragraphLines.join(' ').trim();

    // Limit description length
    if (description.length > 200) {
      return description.substring(0, 197) + '...';
    }

    return description || 'No description available';
  }

  /**
   * Extract allowed tools from frontmatter or content.
   *
   * Looks for:
   * 1. YAML frontmatter: allowed-tools:
   * 2. Markdown list: ## Tools Available
   */
  private extractAllowedTools(content: string): string[] | undefined {
    // Check frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      const toolsMatch = frontmatter.match(/allowed-tools:\s*\n((?:\s+-\s+.+\n?)+)/i);

      if (toolsMatch) {
        const tools = toolsMatch[1]
          .split('\n')
          .map(line => line.trim().replace(/^-\s*/, ''))
          .filter(line => line.length > 0);

        return tools.length > 0 ? tools : undefined;
      }
    }

    // Check for "## Tools Available" section
    const toolsSectionMatch = content.match(/##\s+Tools\s+Available\s*\n([\s\S]*?)(?=\n##|$)/i);
    if (toolsSectionMatch) {
      const section = toolsSectionMatch[1];
      const tools: string[] = [];

      // Look for list items or code blocks
      const listItems = section.matchAll(/[-*]\s+`?(\w+)`?/g);
      for (const match of listItems) {
        tools.push(match[1]);
      }

      return tools.length > 0 ? tools : undefined;
    }

    return undefined;
  }
}

/**
 * Default SkillLoader instance.
 */
export const skillLoader = new SkillLoader();
