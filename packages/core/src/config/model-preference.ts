/**
 * Model preference resolution for per-agent-type model selection.
 *
 * Issue #1338: Allows different agent types to use different models
 * based on a simple configuration section in disclaude.config.yaml.
 *
 * This is intentionally minimal - no classes, no routing logic,
 * just a pure function that resolves model overrides.
 *
 * @example
 * ```yaml
 * # disclaude.config.yaml
 * modelPreference:
 *   chatAgent:
 *     model: "glm-4.7"
 *   skillAgent:
 *     model: "claude-sonnet-4-20250514"
 *     provider: "anthropic"
 * ```
 */

import type { AgentProvider } from '../agents/types.js';
import type { ModelPreferenceConfig } from './types.js';

// Re-export types for convenience
export type { ModelPreferenceConfig, ModelPreferenceEntry } from './types.js';

/**
 * Known agent type names for model preference configuration.
 */
export const AGENT_TYPES = {
  CHAT: 'chatAgent',
  SCHEDULE: 'scheduleAgent',
  TASK: 'taskAgent',
  SKILL: 'skillAgent',
  SUBAGENT: 'subagent',
} as const;

export type AgentType = (typeof AGENT_TYPES)[keyof typeof AGENT_TYPES];

/**
 * Resolve model preference for a given agent type.
 *
 * Resolution priority:
 * 1. Explicit override in options (highest)
 * 2. Agent-type specific preference from config
 * 3. Global model from Config.getAgentConfig() (unchanged)
 *
 * @param agentType - The agent type to resolve for
 * @param modelPreferenceConfig - The model preference config section (may be undefined)
 * @param globalConfig - The global agent config from Config.getAgentConfig()
 * @param options - Explicit overrides (from AgentCreateOptions)
 * @returns Resolved model configuration
 */
export function resolveModelPreference(
  agentType: string,
  modelPreferenceConfig: ModelPreferenceConfig | undefined,
  globalConfig: { apiKey: string; model: string; apiBaseUrl?: string; provider: AgentProvider },
  options: { model?: string; provider?: AgentProvider; apiBaseUrl?: string; apiKey?: string } = {}
): { apiKey: string; model: string; apiBaseUrl?: string; provider: AgentProvider } {
  // Priority 1: Explicit override in options (highest)
  if (options.model || options.provider) {
    return {
      apiKey: options.apiKey ?? globalConfig.apiKey,
      model: options.model ?? globalConfig.model,
      provider: options.provider ?? globalConfig.provider,
      apiBaseUrl: options.apiBaseUrl ?? globalConfig.apiBaseUrl,
    };
  }

  // Priority 2: Agent-type specific preference from config
  const preference = modelPreferenceConfig?.[agentType];
  if (preference?.model) {
    return {
      apiKey: globalConfig.apiKey,
      model: preference.model,
      provider: preference.provider ?? globalConfig.provider,
      apiBaseUrl: preference.apiBaseUrl ?? globalConfig.apiBaseUrl,
    };
  }

  // Priority 3: Global model (no change)
  return globalConfig;
}
