/**
 * ModelRouter - Intelligent model selection based on task scenarios and agent types.
 *
 * Issue #1338: Feature Request - 针对不同场景智能选择最优基座模型
 *
 * Instead of using a single global model for all agents, ModelRouter allows
 * configuring different models for different agent types and task scenarios.
 *
 * Configuration example (disclaude.config.yaml):
 * ```yaml
 * modelRouter:
 *   enabled: true
 *   # Per-agent-type model overrides
 *   agents:
 *     chatAgent:
 *       model: "glm-4.7"
 *       provider: "glm"
 *     skillAgent:
 *       model: "claude-3-5-sonnet-20241022"
 *       provider: "anthropic"
 *     scheduleAgent:
 *       model: "glm-4.7"
 *       provider: "glm"
 *     taskAgent:
 *       model: "claude-3-5-sonnet-20241022"
 *       provider: "anthropic"
 *     subagent:
 *       model: "claude-3-5-sonnet-20241022"
 *       provider: "anthropic"
 * ```
 *
 * Resolution priority:
 * 1. Explicit model override passed to getBaseConfig() (e.g., from AgentCreateOptions)
 * 2. Agent-type specific model from modelRouter.agents config
 * 3. Global model from Config.getAgentConfig() (existing behavior)
 *
 * @module config/model-router
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('ModelRouter');

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Supported agent types for model routing.
 *
 * Maps to the agent types defined in the AgentFactory:
 * - chatAgent: Pilot (long-lived conversation agent)
 * - skillAgent: Single-shot task execution (evaluator, executor, etc.)
 * - scheduleAgent: Scheduled task execution
 * - taskAgent: One-time task execution
 * - subagent: Tool-encapsulated agent (site-miner, etc.)
 */
export type AgentType = 'chatAgent' | 'skillAgent' | 'scheduleAgent' | 'taskAgent' | 'subagent';

/**
 * Model configuration for a specific agent type.
 */
export interface AgentModelConfig {
  /** Model identifier */
  model: string;
  /** API provider */
  provider?: 'anthropic' | 'glm';
  /** Optional API base URL override */
  apiBaseUrl?: string;
}

/**
 * ModelRouter configuration section.
 *
 * This is the top-level `modelRouter` section in disclaude.config.yaml.
 */
export interface ModelRouterConfig {
  /** Enable/disable model routing (default: false) */
  enabled?: boolean;
  /** Per-agent-type model overrides */
  agents?: Partial<Record<AgentType, AgentModelConfig>>;
}

/**
 * Result from model resolution.
 */
export interface ModelResolution {
  /** Resolved model identifier */
  model: string;
  /** Resolved API provider */
  provider: 'anthropic' | 'glm';
  /** Resolved API base URL */
  apiBaseUrl?: string;
  /** Whether a scenario-specific model was used (vs global fallback) */
  routed: boolean;
  /** Which agent type triggered the routing */
  agentType: AgentType;
}

// ============================================================================
// ModelRouter Class
// ============================================================================

/**
 * ModelRouter - Selects optimal model based on agent type and configuration.
 *
 * This class provides intelligent model routing that allows different agent
 * types to use different models based on their specific needs:
 *
 * - **Coding tasks** (SkillAgent, TaskAgent) → Use models optimized for code generation
 * - **General chat** (ChatAgent) → Use faster, cost-effective models
 * - **Scheduled tasks** (ScheduleAgent) → Use efficient models for routine operations
 * - **Specialized tools** (Subagent) → Use models optimized for specific domains
 *
 * The router integrates seamlessly with the existing configuration system:
 * - When disabled or no override exists, falls back to global model config
 * - When enabled with overrides, returns the best model for each agent type
 * - Always respects explicit per-agent model overrides from AgentCreateOptions
 *
 * @example
 * ```typescript
 * const router = new ModelRouter(config.modelRouter);
 *
 * // Resolve model for a chat agent
 * const resolution = router.resolve('chatAgent', {
 *   model: 'claude-3-5-sonnet-20241022',
 *   provider: 'anthropic',
 * });
 * // Returns: { model: 'glm-4.7', provider: 'glm', routed: true, agentType: 'chatAgent' }
 *
 * // Resolve model for a skill agent (coding tasks)
 * const codingResolution = router.resolve('skillAgent', {
 *   model: 'glm-4.7',
 *   provider: 'glm',
 * });
 * // Returns: { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic', routed: true }
 * ```
 */
export class ModelRouter {
  private readonly enabled: boolean;
  private readonly agentOverrides: Partial<Record<AgentType, AgentModelConfig>>;

  constructor(config: ModelRouterConfig = {}) {
    this.enabled = config.enabled ?? false;
    this.agentOverrides = config.agents ?? {};
  }

  /**
   * Check if model routing is enabled.
   *
   * @returns true if routing is enabled and has at least one override configured
   */
  isEnabled(): boolean {
    return this.enabled && Object.keys(this.agentOverrides).length > 0;
  }

  /**
   * Resolve the optimal model for a given agent type.
   *
   * Resolution priority:
   * 1. If routing is disabled, return the global default (routed: false)
   * 2. If agent type has a specific override, use it (routed: true)
   * 3. Otherwise, return the global default (routed: false)
   *
   * @param agentType - The type of agent requesting a model
   * @param globalConfig - The global model configuration as fallback
   * @returns ModelResolution with the resolved model and metadata
   */
  resolve(
    agentType: AgentType,
    globalConfig: { model: string; provider: 'anthropic' | 'glm'; apiBaseUrl?: string }
  ): ModelResolution {
    // If routing is disabled, use global config directly
    if (!this.isEnabled()) {
      return {
        ...globalConfig,
        routed: false,
        agentType,
      };
    }

    // Check for agent-type specific override
    const override = this.agentOverrides[agentType];
    if (override && override.model) {
      logger.debug(
        {
          agentType,
          fromModel: globalConfig.model,
          toModel: override.model,
          fromProvider: globalConfig.provider,
          toProvider: override.provider,
        },
        'Model routed by ModelRouter'
      );

      return {
        model: override.model,
        provider: override.provider ?? globalConfig.provider,
        apiBaseUrl: override.apiBaseUrl ?? globalConfig.apiBaseUrl,
        routed: true,
        agentType,
      };
    }

    // No override for this agent type, use global config
    return {
      ...globalConfig,
      routed: false,
      agentType,
    };
  }

  /**
   * Get the list of configured agent type overrides.
   *
   * @returns Array of agent types that have model overrides
   */
  getConfiguredAgentTypes(): AgentType[] {
    return Object.keys(this.agentOverrides) as AgentType[];
  }

  /**
   * Get the model configuration for a specific agent type (if configured).
   *
   * @param agentType - The agent type to look up
   * @returns Agent model configuration or undefined if not configured
   */
  getAgentConfig(agentType: AgentType): AgentModelConfig | undefined {
    return this.agentOverrides[agentType];
  }
}
