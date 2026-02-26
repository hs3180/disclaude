/**
 * AgentFactory - Factory for creating Agent instances with unified configuration.
 *
 * Provides factory methods to create Agent instances with default configuration
 * from Config.getAgentConfig(), simplifying agent instantiation and ensuring
 * consistent configuration across all agents.
 *
 * @example
 * ```typescript
 * // Before
 * const config = Config.getAgentConfig();
 * const agent = new Evaluator({
 *   apiKey: config.apiKey,
 *   model: config.model,
 *   apiBaseUrl: config.apiBaseUrl,
 * });
 *
 * // After
 * const agent = AgentFactory.createEvaluator();
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
}
