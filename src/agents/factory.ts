/**
 * AgentFactory - Factory for creating Agent instances with unified configuration.
 *
 * Implements AgentFactoryInterface from #282 Phase 3 for unified agent creation.
 * All agent creation goes through the type-specific methods:
 * - createChatAgent: Create chat agents (pilot)
 * - createSkillAgent: Create skill agents using skill files
 * - createSubagent: Create subagents (site-miner)
 *
 * Uses unified configuration types from Issue #327.
 * Simplified with SkillAgent (Issue #413).
 * Enhanced with dynamic skill loading (Issue #430).
 *
 * @example
 * ```typescript
 * // Create a Pilot (ChatAgent)
 * const pilot = AgentFactory.createChatAgent('pilot', callbacks);
 *
 * // Create skill agents by name (searches default paths)
 * const evaluator = AgentFactory.createSkillAgent('evaluator');
 * const executor = AgentFactory.createSkillAgent('executor');
 *
 * // Create skill agent from custom path
 * const customSkill = AgentFactory.createSkillAgentFromPath('skills/custom/SKILL.md');
 *
 * // Create a subagent
 * const siteMiner = AgentFactory.createSubagent('site-miner');
 * ```
 *
 * @module agents/factory
 */

import * as fs from 'fs';
import * as path from 'path';
import { Config } from '../config/index.js';
import { SkillAgent } from './skill-agent.js';
import { Pilot, type PilotConfig, type PilotCallbacks } from './pilot.js';
import { createSiteMiner, isPlaywrightAvailable } from './site-miner.js';
import { skillLoader } from '../skills/skill-loader.js';
import type { ChatAgent, SkillAgent as SkillAgentInterface, Subagent, BaseAgentConfig, AgentProvider } from './types.js';

/**
 * Options for creating agents with custom configuration.
 * Uses unified configuration structure (Issue #327).
 */
export interface AgentCreateOptions {
  /** Override API key */
  apiKey?: string;
  /** Override model */
  model?: string;
  /** Override API provider */
  provider?: AgentProvider;
  /** Override API base URL */
  apiBaseUrl?: string;
  /** Override permission mode */
  permissionMode?: 'default' | 'bypassPermissions';
}

/**
 * Factory for creating Agent instances with unified configuration.
 *
 * This class implements AgentFactoryInterface with type-specific factory methods:
 * - createChatAgent(name, ...args): ChatAgent
 * - createSkillAgent(name, ...args): SkillAgent
 * - createSubagent(name, ...args): Subagent
 *
 * Each method fetches default configuration from Config.getAgentConfig()
 * and allows optional overrides.
 */
export class AgentFactory {
  /**
   * Get base agent configuration from Config with optional overrides.
   *
   * @param options - Optional configuration overrides
   * @returns BaseAgentConfig with merged configuration
   */
  private static getBaseConfig(options: AgentCreateOptions = {}): BaseAgentConfig {
    const defaultConfig = Config.getAgentConfig();

    return {
      apiKey: options.apiKey ?? defaultConfig.apiKey,
      model: options.model ?? defaultConfig.model,
      provider: options.provider ?? defaultConfig.provider,
      apiBaseUrl: options.apiBaseUrl ?? defaultConfig.apiBaseUrl,
      permissionMode: options.permissionMode ?? 'bypassPermissions',
    };
  }

  // ============================================================================
  // AgentFactoryInterface Implementation
  // ============================================================================

  /**
   * Create a ChatAgent instance by name.
   *
   * @param name - Agent name ('pilot')
   * @param args - Additional arguments:
   *   - args[0]: PilotCallbacks - Platform-specific callbacks
   *   - args[1]: AgentCreateOptions - Optional configuration overrides
   * @returns ChatAgent instance
   *
   * @example
   * ```typescript
   * const pilot = AgentFactory.createChatAgent('pilot', {
   *   sendMessage: async (chatId, text) => { ... },
   *   sendCard: async (chatId, card) => { ... },
   *   sendFile: async (chatId, filePath) => { ... },
   * });
   * ```
   */
  static createChatAgent(name: string, ...args: unknown[]): ChatAgent {
    if (name === 'pilot') {
      const callbacks = args[0] as PilotCallbacks;
      const options = (args[1] as AgentCreateOptions) || {};

      const baseConfig = this.getBaseConfig(options);
      const config: PilotConfig = {
        ...baseConfig,
        callbacks,
      };

      return new Pilot(config);
    }
    throw new Error(`Unknown ChatAgent: ${name}`);
  }

  /**
   * Create a SkillAgent instance by name.
   *
   * Uses the simplified SkillAgent architecture (Issue #413).
   * Skill agents are created by searching for skill files in default paths.
   * Enhanced with dynamic skill loading (Issue #430).
   *
   * Search priority:
   * 1. Project domain: `.claude/skills/`
   * 2. Workspace domain: `workspace/.claude/skills/`
   * 3. Package domain: `skills/` (built-in skills)
   *
   * @param name - Agent name (skill directory name, e.g., 'evaluator', 'executor')
   * @param args - Additional arguments:
   *   - args[0]: AgentCreateOptions - Optional configuration overrides
   * @returns SkillAgent instance
   *
   * @example
   * ```typescript
   * // Evaluator with default config
   * const evaluator = AgentFactory.createSkillAgent('evaluator');
   *
   * // Executor with custom config
   * const executor = AgentFactory.createSkillAgent('executor', { model: 'claude-3-opus' });
   *
   * // Custom skill from project domain
   * const mySkill = AgentFactory.createSkillAgent('my-custom-skill');
   * ```
   */
  static createSkillAgent(name: string, ...args: unknown[]): SkillAgentInterface {
    const options = (args[0] as AgentCreateOptions) || {};
    const baseConfig = this.getBaseConfig(options);

    // Search for skill in default paths
    const searchPaths = skillLoader.getDefaultSearchPaths();
    const skillFileName = 'SKILL.md';

    for (const searchPath of searchPaths) {
      const skillPath = path.join(searchPath, name, skillFileName);
      if (fs.existsSync(skillPath)) {
        return new SkillAgent(baseConfig, skillPath);
      }
    }

    // Fallback: try the old hardcoded paths for backwards compatibility
    const legacySkillFileMap: Record<string, string> = {
      evaluator: 'skills/evaluator/SKILL.md',
      executor: 'skills/executor/SKILL.md',
    };

    const legacyPath = legacySkillFileMap[name];
    if (legacyPath) {
      const fullPath = path.join(Config.getWorkspaceDir(), legacyPath);
      if (fs.existsSync(fullPath)) {
        return new SkillAgent(baseConfig, legacyPath);
      }
    }

    throw new Error(
      `Unknown SkillAgent: ${name}. ` +
      `Searched in: ${searchPaths.join(', ')}. ` +
      'Use createSkillAgentFromPath() for custom skill paths.'
    );
  }

  /**
   * Create a SkillAgent from a specific skill file path.
   *
   * This method allows creating a SkillAgent from any skill file,
   * bypassing the default search paths.
   *
   * @param skillPath - Path to the skill file (absolute or relative to workspace)
   * @param options - Optional configuration overrides
   * @returns SkillAgent instance
   *
   * @example
   * ```typescript
   * // From absolute path
   * const skill = AgentFactory.createSkillAgentFromPath('/path/to/skill/SKILL.md');
   *
   * // From relative path (relative to workspace)
   * const skill = AgentFactory.createSkillAgentFromPath('custom/skills/my-skill/SKILL.md');
   *
   * // With custom config
   * const skill = AgentFactory.createSkillAgentFromPath('skills/custom/SKILL.md', {
   *   model: 'claude-3-opus',
   * });
   * ```
   */
  static createSkillAgentFromPath(
    skillPath: string,
    options: AgentCreateOptions = {}
  ): SkillAgentInterface {
    const baseConfig = this.getBaseConfig(options);
    return new SkillAgent(baseConfig, skillPath);
  }

  /**
   * List available skills from all search paths.
   *
   * @returns Array of skill names available in the search paths
   *
   * @example
   * ```typescript
   * const skills = AgentFactory.listAvailableSkills();
   * console.log('Available skills:', skills);
   * // ['evaluator', 'executor', 'reporter', 'schedule', ...]
   * ```
   */
  static async listAvailableSkills(): Promise<string[]> {
    const skills = await skillLoader.searchSkills();
    return skills.map(s => s.name);
  }

  /**
   * Create a Subagent instance by name.
   *
   * @param name - Agent name ('site-miner')
   * @param args - Additional arguments:
   *   - args[0]: Partial<BaseAgentConfig> - Optional configuration overrides
   * @returns Subagent instance
   *
   * @example
   * ```typescript
   * const siteMiner = AgentFactory.createSubagent('site-miner');
   * ```
   */
  static createSubagent(name: string, ...args: unknown[]): Subagent {
    if (name === 'site-miner') {
      const config = args[0] as Partial<BaseAgentConfig> | undefined;

      // Check if Playwright is available
      if (!isPlaywrightAvailable()) {
        throw new Error('SiteMiner requires Playwright MCP to be configured');
      }

      // Create and return the SiteMiner instance
      const siteMinerFactory = createSiteMiner(config);
      return siteMinerFactory as unknown as Subagent;
    }
    throw new Error(`Unknown Subagent: ${name}`);
  }
}
