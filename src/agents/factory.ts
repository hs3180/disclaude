/**
 * AgentFactory - Factory for creating Agent instances with unified configuration.
 *
 * Provides factory methods to create Agent instances with default configuration
 * from Config.getAgentConfig(), simplifying agent instantiation and ensuring
 * consistent configuration across all agents.
 *
 * Implements AgentFactoryInterface from #282 Phase 3 for unified agent creation.
 *
 * @example
 * ```typescript
 * // Using typed factory methods (AgentFactoryInterface)
 * const pilot = AgentFactory.createChatAgent('pilot', callbacks);
 * const evaluator = AgentFactory.createSkillAgent('evaluator');
 *
 * // Using convenience methods (backward compatible)
 * const evaluator = AgentFactory.createEvaluator();
 * const executor = AgentFactory.createExecutor();
 * ```
 *
 * @module agents/factory
 */

import { Config } from '../config/index.js';
import type { BaseAgentConfig } from './base-agent.js';
import { Evaluator, type EvaluatorConfig } from './evaluator.js';
import { Executor, type ExecutorConfig } from './executor.js';
import { Reporter } from './reporter.js';
import { Pilot, type PilotConfig, type PilotCallbacks } from './pilot.js';
import { createSiteMiner, isPlaywrightAvailable } from './site-miner.js';
import type { ChatAgent, SkillAgent, Subagent } from './types.js';

/**
 * Options for creating agents with custom configuration.
 */
export interface AgentCreateOptions {
  /** Override API key */
  apiKey?: string;
  /** Override model */
  model?: string;
  /** Override API base URL */
  apiBaseUrl?: string;
  /** Override permission mode */
  permissionMode?: 'default' | 'bypassPermissions';
}

/**
 * Factory for creating Agent instances with unified configuration.
 *
 * This class provides static factory methods for creating all agent types.
 * Each method fetches default configuration from Config.getAgentConfig()
 * and allows optional overrides.
 *
 * The static methods createChatAgent, createSkillAgent, createSubagent
 * follow the AgentFactoryInterface contract for unified agent creation by type.
 *
 * Note: Uses static methods for backward compatibility. The static methods
 * follow the AgentFactoryInterface signature pattern.
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
      apiBaseUrl: options.apiBaseUrl ?? defaultConfig.apiBaseUrl,
      permissionMode: options.permissionMode ?? 'bypassPermissions',
    };
  }

  /**
   * Create an Evaluator agent.
   *
   * @param options - Optional configuration overrides
   * @param subdirectory - Optional subdirectory for task files
   * @returns Configured Evaluator instance
   *
   * @example
   * ```typescript
   * // With default config
   * const evaluator = AgentFactory.createEvaluator();
   *
   * // With custom subdirectory
   * const evaluator = AgentFactory.createEvaluator({}, 'regular');
   * ```
   */
  static createEvaluator(options: AgentCreateOptions = {}, subdirectory?: string): Evaluator {
    const config: EvaluatorConfig = {
      ...this.getBaseConfig(options),
      subdirectory,
    };

    return new Evaluator(config);
  }

  /**
   * Create an Executor agent.
   *
   * @param options - Optional configuration overrides
   * @param abortSignal - Optional abort signal for cancellation
   * @returns Configured Executor instance
   *
   * @example
   * ```typescript
   * // With default config
   * const executor = AgentFactory.createExecutor();
   *
   * // With abort signal
   * const controller = new AbortController();
   * const executor = AgentFactory.createExecutor({}, controller.signal);
   * ```
   */
  static createExecutor(options: AgentCreateOptions = {}, abortSignal?: AbortSignal): Executor {
    const config: ExecutorConfig = {
      ...this.getBaseConfig(options),
      abortSignal,
    };

    return new Executor(config);
  }

  /**
   * Create a Reporter agent.
   *
   * @param options - Optional configuration overrides
   * @returns Configured Reporter instance
   *
   * @example
   * ```typescript
   * const reporter = AgentFactory.createReporter();
   * ```
   */
  static createReporter(options: AgentCreateOptions = {}): Reporter {
    const config: BaseAgentConfig = this.getBaseConfig(options);

    return new Reporter(config);
  }

  /**
   * Create a Pilot agent.
   *
   * @param callbacks - Platform-specific callbacks for Pilot
   * @param options - Optional configuration overrides
   * @returns Configured Pilot instance
   *
   * @example
   * ```typescript
   * const pilot = AgentFactory.createPilot({
   *   sendMessage: async (chatId, text) => { ... },
   *   sendCard: async (chatId, card) => { ... },
   *   sendFile: async (chatId, filePath) => { ... },
   * });
   * ```
   */
  static createPilot(
    callbacks: PilotCallbacks,
    options: AgentCreateOptions = {}
  ): Pilot {
    const baseConfig = this.getBaseConfig(options);
    const config: PilotConfig = {
      ...baseConfig,
      callbacks,
    };

    return new Pilot(config);
  }

  // ============================================================================
  // AgentFactoryInterface Implementation (Issue #282 Phase 3)
  // ============================================================================

  /**
   * Create a ChatAgent instance by name.
   *
   * Part of AgentFactoryInterface - provides unified agent creation by type.
   *
   * @param name - Agent name ('pilot')
   * @param args - Additional arguments (callbacks for Pilot)
   * @returns ChatAgent instance
   *
   * @example
   * ```typescript
   * const pilot = AgentFactory.createChatAgent('pilot', callbacks);
   * ```
   */
  static createChatAgent(name: string, ...args: unknown[]): ChatAgent {
    if (name === 'pilot') {
      const callbacks = args[0] as PilotCallbacks;
      const options = (args[1] as AgentCreateOptions) || {};
      return this.createPilot(callbacks, options);
    }
    throw new Error(`Unknown ChatAgent: ${name}`);
  }

  /**
   * Create a SkillAgent instance by name.
   *
   * Part of AgentFactoryInterface - provides unified agent creation by type.
   *
   * @param name - Agent name ('evaluator', 'executor', 'reporter')
   * @param args - Additional arguments (options, subdirectory, abortSignal, etc.)
   * @returns SkillAgent instance
   *
   * @example
   * ```typescript
   * const evaluator = AgentFactory.createSkillAgent('evaluator');
   * const executor = AgentFactory.createSkillAgent('executor');
   * const reporter = AgentFactory.createSkillAgent('reporter');
   * ```
   */
  static createSkillAgent(name: string, ...args: unknown[]): SkillAgent {
    const options = (args[0] as AgentCreateOptions) || {};

    switch (name) {
      case 'evaluator':
        const subdirectory = args[1] as string | undefined;
        // Evaluator has type='skill' and will implement SkillAgent fully after PR #335
        return this.createEvaluator(options, subdirectory) as unknown as SkillAgent;
      case 'executor':
        const abortSignal = args[1] as AbortSignal | undefined;
        // Executor has type='skill' and will implement SkillAgent fully after PR #335
        return this.createExecutor(options, abortSignal) as unknown as SkillAgent;
      case 'reporter':
        // Reporter has type='skill' and will implement SkillAgent fully after PR #335
        return this.createReporter(options) as unknown as SkillAgent;
      default:
        throw new Error(`Unknown SkillAgent: ${name}`);
    }
  }

  /**
   * Create a Subagent instance by name.
   *
   * Part of AgentFactoryInterface - provides unified agent creation by type.
   *
   * @param name - Agent name ('site-miner')
   * @param args - Additional arguments
   * @returns Subagent instance
   *
   * @example
   * ```typescript
   * const siteMiner = AgentFactory.createSubagent('site-miner');
   * ```
   */
  static createSubagent(name: string, ...args: unknown[]): Subagent {
    if (name === 'site-miner') {
      // SiteMiner uses global config, createSiteMiner returns the runSiteMiner function
      // The returned object needs to implement Subagent interface
      const config = args[0] as Partial<BaseAgentConfig> | undefined;

      // Check if Playwright is available
      if (!isPlaywrightAvailable()) {
        throw new Error('SiteMiner requires Playwright MCP to be configured');
      }

      // Create and return the SiteMiner instance
      // Note: This assumes SiteMiner has been refactored to implement Subagent
      // (PR #336). For now, we return the factory function wrapped as Subagent.
      const siteMinerFactory = createSiteMiner(config);

      // Return as Subagent (will be properly typed after PR #336 merges)
      return siteMinerFactory as unknown as Subagent;
    }
    throw new Error(`Unknown Subagent: ${name}`);
  }
}
