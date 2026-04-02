/**
 * OpenAI Agent Provider
 *
 * Provides agent functionality through OpenAI's Codex CLI via the
 * Agent Client Protocol (ACP). This is a convenience preset that
 * wraps ACPProvider with OpenAI-specific defaults.
 *
 * Architecture:
 * ```
 * IAgentSDKProvider
 * ├── ClaudeSDKProvider  (existing, wraps @anthropic-ai/claude-agent-sdk)
 * ├── ACPProvider         (generic ACP protocol adapter)
 * └── OpenAIProvider      (this, ACP + Codex CLI defaults)
 *         │
 *         └── ACPProvider → ACPConnection → spawn(codex --full-auto)
 *                                                ↕ NDJSON over stdio
 *                                         OpenAI Codex CLI
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * import { registerProvider, OpenAIProvider } from '@disclaude/core';
 *
 * // Register as 'openai' provider
 * registerProvider('openai', () => new OpenAIProvider());
 *
 * // Or via config file
 * // agent:
 * //   provider: "openai"
 * // openai:
 * //   model: "o4-mini"
 * ```
 *
 * ## Prerequisites
 *
 * - [Codex CLI](https://github.com/openai/codex) must be installed and available on PATH
 * - `OPENAI_API_KEY` environment variable must be set
 *
 * @module sdk/providers/openai/provider
 * @see Issue #1333
 */

import { ACPProvider } from '../acp/provider.js';
import type { ACPProviderConfig } from '../acp/types.js';

// ============================================================================
// OpenAI Agent Presets
// ============================================================================

/**
 * Supported OpenAI agent types.
 *
 * Each agent type maps to a specific CLI command and default arguments.
 */
export type OpenAIAgentType = 'codex';

/**
 * OpenAI Codex CLI preset configurations.
 *
 * Codex CLI is OpenAI's terminal-based coding agent that supports ACP.
 * @see https://github.com/openai/codex
 */
const OPENAI_PRESETS: Record<OpenAIAgentType, {
  command: string;
  args: string[];
  envKeys: string[];
}> = {
  codex: {
    command: 'codex',
    args: ['--full-auto'],
    envKeys: ['OPENAI_API_KEY'],
  },
};

/** Default agent type */
const DEFAULT_AGENT_TYPE: OpenAIAgentType = 'codex';

// ============================================================================
// OpenAI Provider Configuration
// ============================================================================

/**
 * OpenAI provider configuration.
 *
 * Extends ACP provider config with OpenAI-specific options.
 */
export interface OpenAIProviderConfig {
  /**
   * OpenAI agent type to use.
   * Currently only 'codex' is supported.
   * @default 'codex'
   */
  agentType?: OpenAIAgentType;

  /**
   * OpenAI model to use (e.g., 'o4-mini', 'gpt-4.1').
   * Passed to the agent subprocess via OPENAI_MODEL env var.
   */
  model?: string;

  /**
   * Custom agent command (overrides preset default).
   * Useful for custom Codex CLI installations.
   */
  command?: string;

  /**
   * Custom agent arguments (overrides preset defaults).
   */
  args?: string[];

  /**
   * Additional environment variables for the agent process.
   * OPENAI_API_KEY is automatically forwarded if available.
   */
  env?: Record<string, string>;

  /**
   * Client info for ACP capability negotiation.
   */
  clientInfo?: {
    name: string;
    version: string;
  };
}

// ============================================================================
// OpenAI Provider
// ============================================================================

/**
 * OpenAI Agent Provider.
 *
 * A convenience wrapper around ACPProvider that pre-configures
 * the connection for OpenAI's Codex CLI.
 *
 * Key features:
 * - Automatic OPENAI_API_KEY forwarding to subprocess
 * - Sensible defaults for Codex CLI (`--full-auto` mode)
 * - Customizable agent command and arguments
 * - Model selection via configuration
 */
export class OpenAIProvider extends ACPProvider {
  readonly name = 'openai';
  readonly version = '0.1.0';

  /**
   * Create a new OpenAI provider.
   *
   * @param config - OpenAI provider configuration
   *
   * @example
   * ```typescript
   * // Default: codex --full-auto
   * const provider = new OpenAIProvider();
   *
   * // With model selection
   * const provider = new OpenAIProvider({ model: 'o4-mini' });
   *
   * // With custom command
   * const provider = new OpenAIProvider({
   *   command: '/usr/local/bin/codex',
   *   args: ['--full-auto', '--model', 'o4-mini'],
   * });
   * ```
   */
  constructor(config?: OpenAIProviderConfig) {
    const agentType = config?.agentType ?? DEFAULT_AGENT_TYPE;
    const preset = OPENAI_PRESETS[agentType];

    // Build environment variables for the subprocess
    const agentEnv: Record<string, string> = {
      ...config?.env,
    };

    // Forward required API keys from the parent process
    for (const key of preset.envKeys) {
      if (process.env[key]) {
        agentEnv[key] = process.env[key]!;
      }
    }

    // Set model via environment variable if specified
    if (config?.model) {
      agentEnv.OPENAI_MODEL = config.model;
    }

    // Build the ACP provider config
    const acpConfig: ACPProviderConfig = {
      agent: {
        command: config?.command ?? preset.command,
        args: config?.args ?? preset.args,
        env: Object.keys(agentEnv).length > 0 ? agentEnv : undefined,
      },
      clientInfo: config?.clientInfo ?? {
        name: 'disclaude-openai',
        version: '0.4.0',
      },
    };

    super(acpConfig);
  }

  /**
   * Validate that the OpenAI provider is properly configured.
   *
   * Checks that:
   * 1. The agent command is available (or custom command is set)
   * 2. OPENAI_API_KEY is set (for Codex CLI)
   */
  override validateConfig(): boolean {
    // Must have OPENAI_API_KEY
    if (!process.env.OPENAI_API_KEY) {
      return false;
    }

    // Delegate to parent ACP validation
    return super.validateConfig();
  }

  /**
   * Get provider information including OpenAI-specific details.
   */
  override getInfo(): import('../../types.js').ProviderInfo {
    const available = this.validateConfig();

    let unavailableReason: string | undefined;
    if (!available) {
      if (!process.env.OPENAI_API_KEY) {
        unavailableReason = 'OPENAI_API_KEY environment variable is not set';
      } else {
        unavailableReason = 'Codex CLI command not found on PATH';
      }
    }

    return {
      name: this.name,
      version: this.version,
      available,
      unavailableReason,
    };
  }
}
