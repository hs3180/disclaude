/**
 * Skill Type Definitions - Generic skill support for Agent SDK.
 *
 * This module provides type definitions for the skill loading system as described in Issue #430:
 *
 * - SkillLoader: Interface for loading skills from files
 * - Skill: Represents a loaded skill with metadata and content
 * - SkillSearchPath: Defines where to search for skills
 *
 * Design Principles:
 * - Simple and minimal - no complex parsing
 * - Just read markdown files and extract metadata
 * - Works with any Agent implementation
 *
 * @module skills/types
 */

/**
 * Represents a loaded skill with metadata and content.
 *
 * A skill is a markdown file that defines:
 * - Role and responsibilities (via content)
 * - Available tools (via allowedTools)
 * - Instructions for the agent
 *
 * @example
 * ```typescript
 * const skill: Skill = {
 *   name: 'evaluator',
 *   description: 'Task completion evaluation specialist',
 *   allowedTools: ['Read', 'Grep', 'Glob', 'Write'],
 *   content: '# Skill: Evaluator\n\n...',
 *   path: '/path/to/skills/evaluator/SKILL.md',
 * };
 * ```
 */
export interface Skill {
  /** Skill name (from YAML frontmatter or directory name) */
  name: string;

  /** Skill description (from YAML frontmatter) */
  description?: string;

  /** Allowed tools for this skill (from YAML frontmatter) */
  allowedTools?: string[];

  /** Raw markdown content (including frontmatter) */
  content: string;

  /** File path where the skill was loaded from */
  path: string;
}

/**
 * Search path configuration for skill discovery.
 *
 * @example
 * ```typescript
 * const searchPath: SkillSearchPath = {
 *   path: '.claude/skills',
 *   domain: 'project',
 *   priority: 1,
 * };
 * ```
 */
export interface SkillSearchPath {
  /** Directory path to search for skills */
  path: string;

  /** Domain identifier (e.g., 'project', 'workspace', 'package') */
  domain?: string;

  /** Priority for conflict resolution (higher = preferred) */
  priority?: number;
}

/**
 * Interface for loading and discovering skills.
 *
 * Implementations can provide different strategies for:
 * - Loading individual skill files
 * - Discovering skills in directories
 * - Searching across multiple paths
 *
 * @example
 * ```typescript
 * class FileSystemSkillLoader implements SkillLoader {
 *   async loadSkill(path: string): Promise<Skill> {
 *     const content = await fs.readFile(path, 'utf-8');
 *     return this.parseSkill(content, path);
 *   }
 *
 *   async loadSkillsFromDirectory(dir: string): Promise<Skill[]> {
 *     // Load all SKILL.md files from subdirectories
 *   }
 *
 *   async searchSkills(paths: SkillSearchPath[]): Promise<Skill[]> {
 *     // Search all paths and merge results
 *   }
 * }
 * ```
 */
export interface SkillLoader {
  /**
   * Load a single skill from a file path.
   *
   * @param path - Absolute or relative path to skill file
   * @returns Loaded skill with metadata and content
   * @throws Error if file cannot be read
   */
  loadSkill(path: string): Promise<Skill>;

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
  loadSkillsFromDirectory(dir: string): Promise<Skill[]>;

  /**
   * Search for skills across multiple paths.
   *
   * Searches in priority order and deduplicates by skill name.
   * Higher priority paths override lower priority ones.
   *
   * @param paths - Search paths with priority information
   * @returns Array of loaded skills (deduplicated)
   */
  searchSkills(paths: SkillSearchPath[]): Promise<Skill[]>;
}

/**
 * Parsed YAML frontmatter from skill markdown.
 */
export interface SkillFrontmatter {
  /** Skill name */
  name?: string;

  /** Skill description */
  description?: string;

  /** Allowed tools list */
  'allowed-tools'?: string[];

  /** Disable model invocation */
  'disable-model-invocation'?: boolean;
}
