/**
 * ACP Options Adapter
 *
 * Converts unified AgentQueryOptions to ACP session configuration.
 *
 * @module sdk/providers/acp/options-adapter
 */

import type { AgentQueryOptions, McpServerConfig } from '../../types.js';

// ============================================================================
// ACP Session Configuration Types
// ============================================================================

/**
 * ACP MCP server configuration (passed to session/new).
 */
export interface ACPMcpServerConfig {
  type: 'stdio' | 'sse' | 'http';
  name?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

/**
 * ACP new session parameters.
 */
export interface ACPSessionParams {
  /** Working directory for the agent */
  cwd?: string;
  /** MCP servers to attach to the session */
  mcpServers?: ACPMcpServerConfig[];
}

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * Convert unified AgentQueryOptions to ACP session parameters.
 *
 * @param options - Unified query options
 * @returns ACP session parameters
 */
export function adaptOptionsToSession(options: AgentQueryOptions): ACPSessionParams {
  const params: ACPSessionParams = {};

  if (options.cwd) {
    params.cwd = options.cwd;
  }

  if (options.mcpServers) {
    params.mcpServers = adaptMcpServers(options.mcpServers);
  }

  return params;
}

/**
 * Convert unified MCP server configs to ACP MCP server configs.
 *
 * Only stdio MCP servers are supported in ACP mode.
 * Inline MCP servers are not supported (tools must be external processes).
 *
 * @param mcpServers - Unified MCP server configurations
 * @returns ACP MCP server configurations
 * @throws Error if inline MCP servers are configured
 */
export function adaptMcpServers(
  mcpServers: Record<string, McpServerConfig>
): ACPMcpServerConfig[] {
  const result: ACPMcpServerConfig[] = [];

  for (const [name, config] of Object.entries(mcpServers)) {
    if (config.type === 'stdio') {
      result.push({
        type: 'stdio',
        name,
        command: config.command,
        args: config.args,
        env: config.env,
      });
    }
    // Skip inline MCP servers — not supported in ACP mode
    // Tools should be provided as external MCP servers
  }

  return result;
}

/**
 * Parse ACP provider configuration from environment variable.
 *
 * The configuration is stored as JSON in the `ACP_PROVIDER_CONFIG` env var.
 *
 * @example
 * ```bash
 * export ACP_PROVIDER_CONFIG='{"agent":{"command":"claude","args":["--dangerously-skip-permissions"]}}'
 * ```
 *
 * @returns Parsed configuration or null if not set
 */
export function parseACPConfigFromEnv(): import('./types.js').ACPProviderConfig | null {
  const configStr = process.env.ACP_PROVIDER_CONFIG;
  if (!configStr) {
    return null;
  }

  try {
    return JSON.parse(configStr) as import('./types.js').ACPProviderConfig;
  } catch {
    return null;
  }
}
