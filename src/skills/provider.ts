/**
 * ClaudeCodeSkillProvider - Skill provider for Claude Code Agent SDK.
 *
 * This module implements Phase 2-4 of Issue #430:
 * - Phase 2: Claude Code Agent Skills implementation
 * - Phase 3: Skills injection mechanism
 * - Phase 4: Project domain support
 *
 * The provider loads skills from multiple search paths and provides:
 * - allowedTools configuration for SDK
 * - skill content for system prompt injection
 *
 * @module skills/provider
 */

import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { FileSystemSkillLoader } from './loader.js';
import type { Skill, SkillSearchPath } from './types.js';

/**
 * Context for skill loading.
 */
export interface SkillLoadContext {
  /** Workspace directory (usually process.cwd()) */
  workspaceDir?: string;
  /** Package directory (where skills/ is located) */
  packageDir?: string;
  /** Additional search paths */
  additionalPaths?: SkillSearchPath[];
}

/**
 * Skill provider options.
 */
export interface SkillProviderOptions {
  /** Skill loader instance (defaults to FileSystemSkillLoader) */
  loader?: FileSystemSkillLoader;
  /** Context for skill loading */
  context?: SkillLoadContext;
}

/**
 * Loaded skills result with metadata.
 */
export interface LoadedSkills {
  /** Array of loaded skills */
  skills: Skill[];
  /** Combined allowed tools from all skills */
  allowedTools: string[];
  /** System prompt content from all skills */
  systemPromptContent: string;
  /** Loading errors (non-fatal) */
  errors: Array<{ path: string; error: Error }>;
}

/**
 * ClaudeCodeSkillProvider - Provides skills for Claude Code Agent SDK.
 *
 * This class implements the skill loading and injection mechanism for the
 * Agent system. It loads skills from multiple paths with priority-based
 * deduplication and provides both allowedTools and system prompt content.
 *
 * Search Path Priority (highest to lowest):
 * 1. Project domain: `.claude/skills/` (user-defined, highest priority)
 * 2. Workspace domain: `workspace/.claude/skills/` (shared workspace skills)
 * 3. Package domain: `skills/` (built-in skills, lowest priority)
 *
 * @example
 * ```typescript
 * const provider = new ClaudeCodeSkillProvider();
 *
 * // Load skills for evaluator agent
 * const result = await provider.loadSkillsForAgent('evaluator');
 *
 * // Use allowedTools in SDK options
 * const sdkOptions = {
 *   allowedTools: result.allowedTools,
 * };
 *
 * // Use systemPromptContent in system prompt
 * const systemPrompt = basePrompt + '\n\n' + result.systemPromptContent;
 * ```
 */
export class ClaudeCodeSkillProvider {
  private readonly logger = createLogger('SkillProvider');
  private readonly loader: FileSystemSkillLoader;
  private readonly context: SkillLoadContext;

  /** Cache for loaded skills */
  private skillsCache: Map<string, LoadedSkills> = new Map();

  constructor(options: SkillProviderOptions = {}) {
    this.loader = options.loader ?? new FileSystemSkillLoader();
    this.context = options.context ?? {};
  }

  /**
   * Get default search paths for skill discovery.
   *
   * Returns paths in priority order (highest first):
   * 1. Project domain: .claude/skills (priority 3)
   * 2. Workspace domain: workspace/.claude/skills (priority 2)
   * 3. Package domain: skills (priority 1)
   *
   * @returns Array of search paths with priorities
   */
  getDefaultSearchPaths(): SkillSearchPath[] {
    const workspaceDir = this.context.workspaceDir ?? process.cwd();
    const packageDir = this.context.packageDir ?? this.findPackageDir();

    const paths: SkillSearchPath[] = [
      // Project domain - user-defined skills (highest priority)
      {
        path: path.join(workspaceDir, '.claude', 'skills'),
        domain: 'project',
        priority: 3,
      },
      // Workspace domain - shared workspace skills
      {
        path: path.join(workspaceDir, 'workspace', '.claude', 'skills'),
        domain: 'workspace',
        priority: 2,
      },
      // Package domain - built-in skills (lowest priority)
      {
        path: path.join(packageDir, 'skills'),
        domain: 'package',
        priority: 1,
      },
    ];

    // Add additional paths if provided
    if (this.context.additionalPaths) {
      paths.push(...this.context.additionalPaths);
    }

    return paths;
  }

  /**
   * Load all available skills from search paths.
   *
   * @returns Loaded skills with metadata
   */
  async loadAllSkills(): Promise<LoadedSkills> {
    const cacheKey = '__all__';
    if (this.skillsCache.has(cacheKey)) {
      return this.skillsCache.get(cacheKey)!;
    }

    const searchPaths = this.getDefaultSearchPaths();
    const result = await this.loadSkillsFromPaths(searchPaths);

    this.skillsCache.set(cacheKey, result);
    return result;
  }

  /**
   * Load skills for a specific agent by name.
   *
   * This method loads the skill file for the named agent and returns
   * the allowedTools and systemPromptContent for that specific skill.
   *
   * @param agentName - Name of the agent (e.g., 'evaluator', 'executor')
   * @returns Loaded skill data for the agent
   */
  async loadSkillsForAgent(agentName: string): Promise<LoadedSkills> {
    // Check cache first
    if (this.skillsCache.has(agentName)) {
      return this.skillsCache.get(agentName)!;
    }

    const searchPaths = this.getDefaultSearchPaths();
    const errors: Array<{ path: string; error: Error }> = [];

    // Sort by priority (highest first)
    const sortedPaths = [...searchPaths].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    );

    // Try to find the specific skill
    for (const searchPath of sortedPaths) {
      const skillPath = path.join(searchPath.path, agentName, 'SKILL.md');

      try {
        const skill = await this.loader.loadSkill(skillPath);

        const result: LoadedSkills = {
          skills: [skill],
          allowedTools: skill.allowedTools ?? [],
          systemPromptContent: this.buildSystemPromptContent([skill]),
          errors: [],
        };

        this.skillsCache.set(agentName, result);
        this.logger.debug(
          { agentName, skillPath, allowedTools: result.allowedTools },
          'Skill loaded for agent'
        );

        return result;
      } catch (error) {
        // Skill not found in this path, try next
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          errors.push({
            path: skillPath,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    }

    // No skill found, return empty result
    this.logger.debug(
      { agentName, errors },
      'No skill file found for agent, using defaults'
    );

    const result: LoadedSkills = {
      skills: [],
      allowedTools: [],
      systemPromptContent: '',
      errors,
    };

    this.skillsCache.set(agentName, result);
    return result;
  }

  /**
   * Load skills from specific paths.
   *
   * @param paths - Search paths to load from
   * @returns Loaded skills with metadata
   */
  async loadSkillsFromPaths(paths: SkillSearchPath[]): Promise<LoadedSkills> {
    const skills = await this.loader.searchSkills(paths);
    const errors: Array<{ path: string; error: Error }> = [];

    // Collect all allowedTools
    const allowedToolsSet = new Set<string>();
    for (const skill of skills) {
      if (skill.allowedTools) {
        for (const tool of skill.allowedTools) {
          allowedToolsSet.add(tool);
        }
      }
    }

    const result: LoadedSkills = {
      skills,
      allowedTools: Array.from(allowedToolsSet),
      systemPromptContent: this.buildSystemPromptContent(skills),
      errors,
    };

    this.logger.debug(
      { skillCount: skills.length, allowedToolsCount: result.allowedTools.length },
      'Skills loaded from paths'
    );

    return result;
  }

  /**
   * Build system prompt content from loaded skills.
   *
   * @param skills - Array of loaded skills
   * @returns Combined system prompt content
   */
  private buildSystemPromptContent(skills: Skill[]): string {
    if (skills.length === 0) {
      return '';
    }

    const sections: string[] = [];

    for (const skill of skills) {
      // Extract content after frontmatter
      const content = this.extractContentWithoutFrontmatter(skill.content);

      if (content.trim()) {
        sections.push(`## Skill: ${skill.name}\n\n${content}`);
      }
    }

    if (sections.length === 0) {
      return '';
    }

    return `# Skills\n\n${sections.join('\n\n---\n\n')}`;
  }

  /**
   * Extract content without YAML frontmatter.
   *
   * @param content - Raw markdown content with optional frontmatter
   * @returns Content without frontmatter
   */
  private extractContentWithoutFrontmatter(content: string): string {
    // Match and remove YAML frontmatter
    const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n?/);
    if (frontmatterMatch) {
      return content.slice(frontmatterMatch[0].length);
    }
    return content;
  }

  /**
   * Find the package directory (where skills/ is located).
   *
   * @returns Package directory path
   */
  private findPackageDir(): string {
    // Try to find package directory from various sources
    // 1. Check if dist/skills exists (compiled TypeScript)
    // 2. Check if src/skills exists (source TypeScript)
    // 3. Fall back to current directory

    const possibleDirs = [
      path.resolve(__dirname, '..'), // src/ directory
      path.resolve(__dirname, '..', '..'), // package root
    ];

    for (const dir of possibleDirs) {
      const skillsDir = path.join(dir, 'skills');
      try {
        require('fs').existsSync(skillsDir);
        return dir;
      } catch {
        // Continue to next
      }
    }

    return process.cwd();
  }

  /**
   * Clear the skills cache.
   *
   * Useful when skills files have been modified and need to be reloaded.
   */
  clearCache(): void {
    this.skillsCache.clear();
    this.logger.debug('Skills cache cleared');
  }
}
