/**
 * AgentFactory - Unified factory for creating Agent instances.
 *
 * Solves Issue #129: Unified Agent architecture design.
 *
 * Before:
 * - Pilot: Had special default value logic (from Config.getAgentConfig())
 * - Evaluator/Executor/Reporter: Required explicit config
 *
 * After:
 * - All Agents: Created via AgentFactory with consistent configuration
 * - Factory handles default values internally
 * - Callers don't need to know about config details
 *
 * @module agents/agent-factory
 */

import { Config } from '../config/index.js';
import { Pilot, type PilotConfig, type PilotCallbacks } from './pilot.js';
import { Evaluator, type EvaluatorConfig } from './evaluator.js';
import { Executor, type ExecutorConfig } from './executor.js';
import { Reporter, type ReporterConfig } from './reporter.js';
import type { BaseAgentConfig } from './base-agent.js';

/**
 * Agent type identifiers.
 */
export type AgentType = 'pilot' | 'evaluator' | 'executor' | 'reporter';

/**
 * Options for creating a Pilot agent.
 */
export interface CreatePilotOptions {
  /** Callbacks for platform-specific operations */
  callbacks: PilotCallbacks;
  /** Whether running in CLI mode */
  isCliMode?: boolean;
  /** Override API key (optional, uses Config if not provided) */
  apiKey?: string;
  /** Override model (optional, uses Config if not provided) */
  model?: string;
  /** Override API base URL (optional, uses Config if not provided) */
  apiBaseUrl?: string;
}

/**
 * Options for creating an Evaluator agent.
 */
export interface CreateEvaluatorOptions {
  /** Optional subdirectory for task files */
  subdirectory?: string;
  /** Override API key (optional, uses Config if not provided) */
  apiKey?: string;
  /** Override model (optional, uses Config if not provided) */
  model?: string;
  /** Override API base URL (optional, uses Config if not provided) */
  apiBaseUrl?: string;
}

/**
 * Options for creating an Executor agent.
 */
export interface CreateExecutorOptions {
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Override API key (optional, uses Config if not provided) */
  apiKey?: string;
  /** Override model (optional, uses Config if not provided) */
  model?: string;
  /** Override API base URL (optional, uses Config if not provided) */
  apiBaseUrl?: string;
}

/**
 * Options for creating a Reporter agent.
 */
export interface CreateReporterOptions {
  /** Override API key (optional, uses Config if not provided) */
  apiKey?: string;
  /** Override model (optional, uses Config if not provided) */
  model?: string;
  /** Override API base URL (optional, uses Config if not provided) */
  apiBaseUrl?: string;
}

/**
 * AgentFactory - Unified factory for creating Agent instances.
 *
 * All creation methods follow the same pattern:
 * 1. Get default config from Config.getAgentConfig()
 * 2. Apply any overrides from options
 * 3. Create and return the agent instance
 *
 * @example
 * ```typescript
 * // Create a Pilot with callbacks
 * const pilot = AgentFactory.createPilot({
 *   callbacks: { sendMessage, sendCard, sendFile }
 * });
 *
 * // Create an Evaluator for CLI tasks
 * const evaluator = AgentFactory.createEvaluator({
 *   subdirectory: 'regular'
 * });
 * ```
 */
export class AgentFactory {
  /**
   * Get the default agent configuration from Config.
   * This is the single source of truth for default values.
   */
  private static getDefaultConfig(): BaseAgentConfig {
    const config = Config.getAgentConfig();
    return {
      apiKey: config.apiKey,
      model: config.model,
      apiBaseUrl: config.apiBaseUrl,
      permissionMode: 'bypassPermissions',
    };
  }

  /**
   * Merge options with default config.
   */
  private static mergeConfig(
    options: {
      apiKey?: string;
      model?: string;
      apiBaseUrl?: string;
    },
    defaults: BaseAgentConfig
  ): BaseAgentConfig {
    return {
      apiKey: options.apiKey || defaults.apiKey,
      model: options.model || defaults.model,
      apiBaseUrl: options.apiBaseUrl || defaults.apiBaseUrl,
      permissionMode: 'bypassPermissions',
    };
  }

  /**
   * Create a Pilot agent.
   *
   * @param options - Pilot creation options
   * @returns Pilot instance
   */
  static createPilot(options: CreatePilotOptions): Pilot {
    const defaults = this.getDefaultConfig();
    const config: PilotConfig = {
      apiKey: options.apiKey || defaults.apiKey,
      model: options.model || defaults.model,
      apiBaseUrl: options.apiBaseUrl || defaults.apiBaseUrl,
      permissionMode: 'bypassPermissions',
      callbacks: options.callbacks,
      isCliMode: options.isCliMode ?? false,
    };

    return new Pilot(config);
  }

  /**
   * Create an Evaluator agent.
   *
   * @param options - Evaluator creation options
   * @returns Evaluator instance
   */
  static createEvaluator(options: CreateEvaluatorOptions = {}): Evaluator {
    const defaults = this.getDefaultConfig();
    const config: EvaluatorConfig = {
      ...this.mergeConfig(options, defaults),
      subdirectory: options.subdirectory,
    };

    return new Evaluator(config);
  }

  /**
   * Create an Executor agent.
   *
   * @param options - Executor creation options
   * @returns Executor instance
   */
  static createExecutor(options: CreateExecutorOptions = {}): Executor {
    const defaults = this.getDefaultConfig();
    const config: ExecutorConfig = {
      ...this.mergeConfig(options, defaults),
      abortSignal: options.abortSignal,
    };

    return new Executor(config);
  }

  /**
   * Create a Reporter agent.
   *
   * @param options - Reporter creation options
   * @returns Reporter instance
   */
  static createReporter(options: CreateReporterOptions = {}): Reporter {
    const defaults = this.getDefaultConfig();
    const config: ReporterConfig = this.mergeConfig(options, defaults);

    return new Reporter(config);
  }
}
