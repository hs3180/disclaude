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
 * Dynamic skill discovery (Issue #430).
 *
 * @example
 * ```typescript
 * // Create a Pilot (ChatAgent)
 * const pilot = AgentFactory.createChatAgent('pilot', callbacks);
 *
 * // Create skill agents (built-in)
 * const evaluator = AgentFactory.createSkillAgent('evaluator');
 * const executor = AgentFactory.createSkillAgent('executor');
 *
 * // Create skill agents (custom skills)
 * const customAgent = AgentFactory.createSkillAgent('my-custom-skill');
 *
 * // Create a subagent
 * const siteMiner = AgentFactory.createSubagent('site-miner');
 * ```
 *
 * @module agents/factory
 */

import { Config } from '../config/index.js';
import { findSkill } from '../skills/index.js';
import { SkillAgent } from './skill-agent.js';
import { Pilot, type PilotConfig, type PilotCallbacks } from './pilot.js';
import { createSiteMiner, isPlaywrightAvailable } from './site-miner.js';
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
   * Issue #644: Pilot now requires chatId binding at creation time.
   *
   * @param name - Agent name ('pilot')
   * @param args - Additional arguments:
   *   - args[0]: chatId | PilotCallbacks - ChatId string OR callbacks object (legacy)
   *   - args[1]: PilotCallbacks | AgentCreateOptions - Callbacks OR options
   *   - args[2]: AgentCreateOptions - Optional configuration overrides (when chatId provided)
   * @returns ChatAgent instance
   *
   * @example
   * ```typescript
   * // Issue #644: New pattern with chatId binding
   * const pilot = AgentFactory.createChatAgent('pilot', 'chat-123', {
   *   sendMessage: async (chatId, text) => { ... },
   *   sendCard: async (chatId, card) => { ... },
   *   sendFile: async (chatId, filePath) => { ... },
   * });
   * ```
   */
  static createChatAgent(name: string, ...args: unknown[]): ChatAgent {
    if (name === 'pilot') {
      // Issue #644: Support both new (chatId, callbacks, options) and legacy (callbacks, options) patterns
      let chatId: string;
      let callbacks: PilotCallbacks;
      let options: AgentCreateOptions;

      if (typeof args[0] === 'string') {
        // New pattern: createChatAgent('pilot', chatId, callbacks, options)
        chatId = args[0];
        callbacks = args[1] as PilotCallbacks;
        options = (args[2] as AgentCreateOptions) || {};
      } else {
        // Legacy pattern: createChatAgent('pilot', callbacks, options)
        // This is deprecated but kept for backward compatibility
        chatId = 'default';
        callbacks = args[0] as PilotCallbacks;
        options = (args[1] as AgentCreateOptions) || {};
      }

      const baseConfig = this.getBaseConfig(options);
      const config: PilotConfig = {
        ...baseConfig,
        chatId,
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
   * Skill agents are created with their corresponding skill files.
   *
   * Dynamic skill discovery (Issue #430):
   * - Searches for skills across project, workspace, and package domains
   * - Supports both built-in skills (evaluator, executor) and custom skills
   *
   * @param name - Agent name (e.g., 'evaluator', 'executor', or custom skill name)
   * @param args - Additional arguments:
   *   - args[0]: AgentCreateOptions - Optional configuration overrides
   * @returns SkillAgent instance
   * @throws Error if skill not found
   *
   * @example
   * ```typescript
   * // Evaluator with default config
   * const evaluator = AgentFactory.createSkillAgent('evaluator');
   *
   * // Executor with custom config
   * const executor = AgentFactory.createSkillAgent('executor', { model: 'claude-3-opus' });
   *
   * // Custom skill
   * const custom = AgentFactory.createSkillAgent('my-custom-skill');
   * ```
   */
  static async createSkillAgent(name: string, ...args: unknown[]): Promise<SkillAgentInterface> {
    const options = (args[0] as AgentCreateOptions) || {};
    const baseConfig = this.getBaseConfig(options);

    // Use dynamic skill discovery (Issue #430)
    const skillPath = await findSkill(name);

    if (!skillPath) {
      throw new Error(
        `Skill not found: ${name}. ` +
          'Searched in: .claude/skills/, workspace/.claude/skills/, and package skills/'
      );
    }

    return new SkillAgent(baseConfig, skillPath);
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
