/**
 * AgentFactory - Factory for creating Agent instances with unified configuration.
 *
 * Implements AgentFactoryInterface from #282 Phase 3 for unified agent creation.
 * All agent creation goes through the type-specific methods:
 * - createChatAgent: Create chat agents (pilot)
 * - createSkillAgent: Create skill agents (evaluator, executor, reporter)
 * - createSubagent: Create subagents (site-miner)
 *
 * Uses unified configuration types from Issue #327.
 * Refactored (Issue #413): Uses generic SkillAgent instead of specialized classes.
 *
 * @example
 * ```typescript
 * // Create a Pilot (ChatAgent)
 * const pilot = AgentFactory.createChatAgent('pilot', callbacks);
 *
 * // Create skill agents
 * const evaluator = AgentFactory.createSkillAgent('evaluator');
 * const executor = AgentFactory.createSkillAgent('executor', {}, abortSignal);
 * const reporter = AgentFactory.createSkillAgent('reporter');
 *
 * // Create a subagent
 * const siteMiner = AgentFactory.createSubagent('site-miner');
 * ```
 *
 * @module agents/factory
 */

import { Config } from '../config/index.js';
import { SkillAgent as SkillAgentImpl, type SkillAgentImplConfig } from './skill-agent.js';
import { Pilot, type PilotConfig, type PilotCallbacks } from './pilot.js';
import { createSiteMiner, isPlaywrightAvailable } from './site-miner.js';
import type { ChatAgent, SkillAgent as ISkillAgent, Subagent, BaseAgentConfig, AgentProvider } from './types.js';

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
   * Refactored (Issue #413): Uses generic SkillAgent with skill file.
   *
   * @param name - Agent name ('evaluator', 'executor', 'reporter')
   * @param args - Additional arguments:
   *   - args[0]: AgentCreateOptions - Optional configuration overrides
   * @returns SkillAgent instance
   *
   * @example
   * ```typescript
   * // Evaluator with default config
   * const evaluator = AgentFactory.createSkillAgent('evaluator');
   *
   * // Executor
   * const executor = AgentFactory.createSkillAgent('executor');
   *
   * // Reporter
   * const reporter = AgentFactory.createSkillAgent('reporter');
   * ```
   */
  static createSkillAgent(name: string, ...args: unknown[]): ISkillAgent {
    const options = (args[0] as AgentCreateOptions) || {};
    const baseConfig = this.getBaseConfig(options);

    // Skill configurations (Issue #413)
    const skillConfigs: Record<string, { path: string; tools: string[] }> = {
      evaluator: {
        path: 'evaluator/SKILL.md',
        tools: ['Read', 'Grep', 'Glob', 'Write'],
      },
      executor: {
        path: 'executor/SKILL.md',
        tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      },
      reporter: {
        path: 'reporter/SKILL.md',
        tools: ['send_user_feedback', 'send_file_to_feishu'],
      },
    };

    const skillConfig = skillConfigs[name];
    if (!skillConfig) {
      throw new Error(`Unknown SkillAgent: ${name}`);
    }

    const config: SkillAgentImplConfig = {
      ...baseConfig,
      skillPath: skillConfig.path,
      allowedTools: skillConfig.tools,
    };

    return new SkillAgentImpl(config);
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
