/**
 * AgentFactory - Factory for creating Agent instances with unified configuration.
 *
 * Implements AgentFactoryInterface from #282 Phase 3 for unified agent creation.
 * All agent creation goes through the type-specific methods:
 * - createChatAgent: Create chat agents (pilot) - long-lived, stored in AgentPool
 * - createScheduleAgent: Create schedule agents - short-lived, max 24h lifetime
 * - createTaskAgent: Create task agents - short-lived, disposed after task
 * - createSkillAgent: Create skill agents using skill files - short-lived
 * - createSubagent: Create subagents (site-miner) - short-lived
 *
 * Issue #711: Agent Lifecycle Management Strategy
 *
 * | Agent Type     | chatId Binding | Max Lifetime | Storage Location |
 * |----------------|----------------|--------------|------------------|
 * | ChatAgent      | ✅ Yes         | Unlimited    | AgentPool        |
 * | ScheduleAgent  | ❌ No          | 24 hours     | None (temporary) |
 * | TaskAgent      | ❌ No          | Task finish  | None (temporary) |
 * | SkillAgent     | ❌ No          | Task finish  | None (temporary) |
 *
 * Uses unified configuration types from Issue #327.
 * Simplified with SkillAgent (Issue #413).
 * Dynamic skill discovery (Issue #430).
 *
 * @example
 * ```typescript
 * // Create a Pilot (ChatAgent) - long-lived, store in AgentPool
 * const pilot = AgentFactory.createChatAgent('pilot', 'chat-123', callbacks);
 *
 * // Create a ScheduleAgent - short-lived, dispose after execution
 * const scheduleAgent = AgentFactory.createScheduleAgent('chat-123', callbacks);
 * try {
 *   await scheduleAgent.executeOnce(chatId, prompt);
 * } finally {
 *   scheduleAgent.dispose();
 * }
 *
 * // Create skill agents (built-in)
 * const evaluator = AgentFactory.createSkillAgent('evaluator');
 *
 * // Create a subagent
 * const siteMiner = AgentFactory.createSubagent('site-miner');
 * ```
 *
 * @module agents/factory
 */

import { Config, findSkill, type ChatAgent, type SkillAgent as SkillAgentInterface, type Subagent, type BaseAgentConfig, type AgentProvider, type SchedulerCallbacks, ModelRouter, type AgentType } from '@disclaude/core';
import { Pilot, type PilotConfig, type PilotCallbacks } from './pilot/index.js';
import { createSiteMiner, isPlaywrightAvailable } from './site-miner.js';

// ============================================================================
// Issue #1412: Helper function for converting SchedulerCallbacks to PilotCallbacks
// ============================================================================

/**
 * Convert SchedulerCallbacks to PilotCallbacks with no-op implementations.
 *
 * Scheduled tasks typically only need sendMessage capability. This helper
 * provides no-op implementations for sendCard, sendFile, and onDone to
 * satisfy the PilotCallbacks interface.
 *
 * Issue #1412: Removes duplicate empty implementations from Primary Node.
 *
 * @param callbacks - SchedulerCallbacks with sendMessage method
 * @returns PilotCallbacks with functional sendMessage and no-op other methods
 *
 * @example
 * ```typescript
 * const schedulerCallbacks: SchedulerCallbacks = {
 *   sendMessage: async (chatId, msg) => { ... }
 * };
 * const pilotCallbacks = toPilotCallbacks(schedulerCallbacks);
 * const agent = AgentFactory.createScheduleAgent(chatId, pilotCallbacks);
 * ```
 */
export function toPilotCallbacks(callbacks: SchedulerCallbacks): PilotCallbacks {
  return {
    sendMessage: callbacks.sendMessage,
    // No-op: Card sending not typically needed for scheduled tasks
    sendCard: async () => {},
    // No-op: File sending not typically needed for scheduled tasks
    sendFile: async () => {},
    // No-op: Completion handled by scheduler
    onDone: async () => {},
  };
}

// Lazy-loaded SkillAgent class reference
let _SkillAgentClass: typeof import('@disclaude/core').SkillAgentBase | null = null;

/**
 * Get the SkillAgent class from core (lazy-loaded to avoid type-only import issues).
 */
async function getSkillAgentClass() {
  if (!_SkillAgentClass) {
    const module = await import('@disclaude/core');
    _SkillAgentClass = module.SkillAgentBase;
  }
  return _SkillAgentClass;
}

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
 * and allows optional overrides. Model routing (Issue #1338) is applied
 * to select optimal models per agent type when configured.
 */
export class AgentFactory {
  /** Singleton ModelRouter instance (Issue #1338) */
  private static modelRouter: ModelRouter | null = null;

  /**
   * Get or create the ModelRouter instance.
   * Lazily initialized from configuration.
   */
  private static getModelRouter(): ModelRouter {
    if (!this.modelRouter) {
      const routerConfig = Config.getModelRouterConfig();
      this.modelRouter = new ModelRouter(routerConfig);
    }
    return this.modelRouter;
  }

  /**
   * Get base agent configuration from Config with optional overrides.
   * Applies ModelRouter (Issue #1338) for agent-type-specific model selection.
   *
   * Resolution priority:
   * 1. Explicit override in options (e.g., AgentCreateOptions.model)
   * 2. Agent-type specific model from modelRouter config
   * 3. Global model from Config.getAgentConfig()
   *
   * @param agentType - The type of agent being created
   * @param options - Optional configuration overrides
   * @returns BaseAgentConfig with merged configuration
   */
  private static getBaseConfig(agentType: AgentType, options: AgentCreateOptions = {}): BaseAgentConfig {
    const defaultConfig = Config.getAgentConfig();

    // Apply ModelRouter if enabled (Issue #1338)
    const router = this.getModelRouter();
    const resolved = router.resolve(agentType, defaultConfig);

    return {
      apiKey: options.apiKey ?? defaultConfig.apiKey,
      model: options.model ?? resolved.model,
      provider: options.provider ?? resolved.provider,
      apiBaseUrl: options.apiBaseUrl ?? resolved.apiBaseUrl,
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
   * Issue #711: ChatAgents are long-lived and should be stored in AgentPool.
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
        const [id, cb, opt] = args as [string, PilotCallbacks, AgentCreateOptions?];
        chatId = id;
        callbacks = cb;
        options = opt || {};
      } else {
        // Legacy pattern: createChatAgent('pilot', callbacks, options)
        // This is deprecated but kept for backward compatibility
        const [cb, opt] = args as [PilotCallbacks, AgentCreateOptions?];
        chatId = 'default';
        callbacks = cb;
        options = opt || {};
      }

      const baseConfig = this.getBaseConfig('chatAgent', options);
      const config: PilotConfig = {
        ...baseConfig,
        chatId,
        callbacks,
      };

      return new Pilot(config);
    }
    throw new Error(`Unknown ChatAgent: ${name}`);
  }

  // ============================================================================
  // Issue #711: Short-lived Agent Creation Methods
  // ============================================================================

  /**
   * Create a ScheduleAgent for executing scheduled tasks.
   *
   * Issue #711: ScheduleAgents are short-lived and should NOT be stored in AgentPool.
   * - Maximum lifetime: 24 hours
   * - Caller is responsible for disposing after execution
   *
   * @param chatId - Chat ID for message delivery
   * @param callbacks - Callbacks for sending messages
   * @param options - Optional configuration overrides
   * @returns ChatAgent instance (caller must dispose)
   *
   * @example
   * ```typescript
   * const agent = AgentFactory.createScheduleAgent('chat-123', callbacks);
   * try {
   *   await agent.executeOnce(chatId, prompt);
   * } finally {
   *   agent.dispose();
   * }
   * ```
   */
  static createScheduleAgent(
    chatId: string,
    callbacks: PilotCallbacks,
    options: AgentCreateOptions = {}
  ): ChatAgent {
    const baseConfig = this.getBaseConfig('scheduleAgent', options);
    const config: PilotConfig = {
      ...baseConfig,
      chatId,
      callbacks,
    };

    return new Pilot(config);
  }

  /**
   * Create a TaskAgent for executing one-time tasks.
   *
   * Issue #711: TaskAgents are short-lived and should NOT be stored in AgentPool.
   * - Maximum lifetime: Until task completion
   * - Caller is responsible for disposing after execution
   *
   * @param chatId - Chat ID for message delivery
   * @param callbacks - Callbacks for sending messages
   * @param options - Optional configuration overrides
   * @returns ChatAgent instance (caller must dispose)
   *
   * @example
   * ```typescript
   * const agent = AgentFactory.createTaskAgent('chat-123', callbacks);
   * try {
   *   await agent.executeOnce(chatId, prompt);
   * } finally {
   *   agent.dispose();
   * }
   * ```
   */
  static createTaskAgent(
    chatId: string,
    callbacks: PilotCallbacks,
    options: AgentCreateOptions = {}
  ): ChatAgent {
    const baseConfig = this.getBaseConfig('taskAgent', options);
    const config: PilotConfig = {
      ...baseConfig,
      chatId,
      callbacks,
    };

    return new Pilot(config);
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
    const baseConfig = this.getBaseConfig('skillAgent', options);

    // Use dynamic skill discovery (Issue #430)
    const skillPath = await findSkill(name);

    if (!skillPath) {
      throw new Error(
        `Skill not found: ${name}. ` +
          'Searched in: .claude/skills/, workspace/.claude/skills/, and package skills/'
      );
    }

    const SkillAgentClass = await getSkillAgentClass();
    return new SkillAgentClass(baseConfig, skillPath);
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

      // Apply ModelRouter for subagent type (Issue #1338)
      const baseConfig = this.getBaseConfig('subagent', {
        model: config?.model,
        provider: config?.provider,
        apiBaseUrl: config?.apiBaseUrl,
        permissionMode: config?.permissionMode,
      });

      // Create and return the SiteMiner instance with routed config
      const siteMinerFactory = createSiteMiner(baseConfig);
      return siteMinerFactory as unknown as Subagent;
    }
    throw new Error(`Unknown Subagent: ${name}`);
  }
}
