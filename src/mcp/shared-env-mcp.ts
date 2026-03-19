/**
 * Shared Environment Variables MCP Tools.
 *
 * This module provides tools for managing runtime environment variables
 * that can be shared across all Agent sessions and Tool uses within the
 * same Node process.
 *
 * Issue #1361: Support runtime dynamic shared environment variables
 *
 * Tools provided:
 * - set_shared_env: Set a shared environment variable with optional TTL
 * - get_shared_env: Get a specific shared environment variable
 * - list_shared_env: List all shared environment variables
 * - delete_shared_env: Delete a shared environment variable
 *
 * Architecture:
 * ```
 * ┌─────────────────┐
 * │   Skill/Tool    │
 * └────────┬────────┘
 *          │ set_shared_env({ key: "GH_TOKEN", value: "ghs_xxx" })
 *          ▼
 * ┌─────────────────┐
 * │  Config Runtime │  ← In-memory storage
 * │  Env Store      │
 * └────────┬────────┘
 *          │
 *          ▼
 * ┌─────────────────┐
 * │   All Agents    │  ← Access via Config.getMergedEnv()
 * │   & Tool Uses   │
 * └─────────────────┘
 * ```
 */

import { z } from 'zod';
import { createLogger } from '../utils/logger.js';
import { getProvider, type InlineToolDefinition } from '../sdk/index.js';
import { Config } from '../config/index.js';

const logger = createLogger('SharedEnvMCP');

// ============================================================================
// Tool Definitions
// ============================================================================

/**
 * Result from set_shared_env tool.
 */
export interface SetSharedEnvResult {
  success: boolean;
  message: string;
  key: string;
}

/**
 * Result from get_shared_env tool.
 */
export interface GetSharedEnvResult {
  success: boolean;
  message: string;
  key: string;
  value?: string;
  ttl?: number;
}

/**
 * Result from list_shared_env tool.
 */
export interface ListSharedEnvResult {
  success: boolean;
  message: string;
  variables: Array<{
    key: string;
    ttl?: number;
  }>;
}

/**
 * Result from delete_shared_env tool.
 */
export interface DeleteSharedEnvResult {
  success: boolean;
  message: string;
  key: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Helper to create a successful tool result.
 */
function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text }],
  };
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Set a shared environment variable.
 *
 * @param params - Tool parameters
 * @returns Result with success status
 */
export async function set_shared_env(params: {
  key: string;
  value: string;
  ttl?: number;
}): Promise<SetSharedEnvResult> {
  const { key, value, ttl } = params;

  logger.info({ key, ttl: ttl ?? 'no TTL' }, 'Setting shared env variable');

  try {
    Config.setRuntimeEnv(key, value, ttl);

    return {
      success: true,
      message: `✅ Shared environment variable "${key}" has been set${ttl ? ` (TTL: ${ttl}s)` : ''}`,
      key,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, key }, 'Failed to set shared env variable');

    return {
      success: false,
      message: `❌ Failed to set "${key}": ${errorMessage}`,
      key,
    };
  }
}

/**
 * Get a specific shared environment variable.
 *
 * @param params - Tool parameters
 * @returns Result with variable value
 */
export async function get_shared_env(params: {
  key: string;
}): Promise<GetSharedEnvResult> {
  const { key } = params;

  logger.debug({ key }, 'Getting shared env variable');

  const value = Config.getRuntimeEnvValue(key);

  if (value === undefined) {
    return {
      success: false,
      message: `❌ Shared environment variable "${key}" not found or expired`,
      key,
    };
  }

  return {
    success: true,
    message: `✅ Found shared environment variable "${key}"`,
    key,
    value,
  };
}

/**
 * List all shared environment variables (keys only, not values for security).
 *
 * @returns Result with list of variable keys
 */
export async function list_shared_env(): Promise<ListSharedEnvResult> {
  logger.debug('Listing shared env variables');

  const runtimeEnv = Config.getRuntimeEnv();
  const variables = Object.keys(runtimeEnv).map(key => ({
    key,
  }));

  return {
    success: true,
    message: `📋 Found ${variables.length} shared environment variable(s)`,
    variables,
  };
}

/**
 * Delete a shared environment variable.
 *
 * @param params - Tool parameters
 * @returns Result with deletion status
 */
export async function delete_shared_env(params: {
  key: string;
}): Promise<DeleteSharedEnvResult> {
  const { key } = params;

  logger.info({ key }, 'Deleting shared env variable');

  const deleted = Config.deleteRuntimeEnv(key);

  if (deleted) {
    return {
      success: true,
      message: `✅ Shared environment variable "${key}" has been deleted`,
      key,
    };
  }

  return {
    success: false,
    message: `❌ Shared environment variable "${key}" not found`,
    key,
  };
}

// ============================================================================
// Tool Definitions for SDK
// ============================================================================

/**
 * Shared environment variables tool definitions for Agent SDK.
 */
export const sharedEnvToolDefinitions: InlineToolDefinition[] = [
  {
    name: 'set_shared_env',
    description: `Set a shared environment variable that will be available to all subsequent Agent sessions and Tool uses within this Node process.

This is useful for:
- GitHub App Installation Tokens (GH_TOKEN)
- OAuth Token refresh
- Temporary credentials (AWS STS, GCP Service Account)

**IMPORTANT:** The value is stored in memory and will be lost when the process restarts.

## Parameters
- **key**: Environment variable name (e.g., "GH_TOKEN")
- **value**: Environment variable value
- **ttl**: Optional time-to-live in seconds (e.g., 3600 for 1 hour)

## Example
\`\`\`json
{
  "key": "GH_TOKEN",
  "value": "ghs_xxxxxxxxxxxx",
  "ttl": 3600
}
\`\`\``,
    parameters: z.object({
      key: z.string().min(1).describe('Environment variable name'),
      value: z.string().describe('Environment variable value'),
      ttl: z.number().int().positive().optional().describe('Optional TTL in seconds'),
    }),
    handler: async ({ key, value, ttl }) => {
      const result = await set_shared_env({ key, value, ttl });
      return toolSuccess(result.message);
    },
  },

  {
    name: 'get_shared_env',
    description: `Get the value of a shared environment variable.

## Parameters
- **key**: Environment variable name

## Example
\`\`\`json
{ "key": "GH_TOKEN" }
\`\`\``,
    parameters: z.object({
      key: z.string().min(1).describe('Environment variable name'),
    }),
    handler: async ({ key }) => {
      const result = await get_shared_env({ key });
      if (result.success && result.value) {
        return toolSuccess(`${result.message}\nValue: ${result.value}`);
      }
      return toolSuccess(result.message);
    },
  },

  {
    name: 'list_shared_env',
    description: `List all shared environment variable keys (values are not shown for security).

## Example
\`\`\`json
{}
\`\`\``,
    parameters: z.object({}),
    handler: async () => {
      const result = await list_shared_env();
      if (result.variables.length === 0) {
        return toolSuccess('📋 No shared environment variables set');
      }
      const keys = result.variables.map(v => `  - ${v.key}`).join('\n');
      return toolSuccess(`${result.message}:\n${keys}`);
    },
  },

  {
    name: 'delete_shared_env',
    description: `Delete a shared environment variable.

## Parameters
- **key**: Environment variable name

## Example
\`\`\`json
{ "key": "GH_TOKEN" }
\`\`\``,
    parameters: z.object({
      key: z.string().min(1).describe('Environment variable name'),
    }),
    handler: async ({ key }) => {
      const result = await delete_shared_env({ key });
      return toolSuccess(result.message);
    },
  },
];

// ============================================================================
// MCP Server Factory
// ============================================================================

/**
 * SDK MCP Server factory for shared environment variables tools.
 *
 * **Usage:**
 * ```typescript
 * query({
 *   prompt: "...",
 *   options: {
 *     mcpServers: {
 *       'shared-env': createSharedEnvMcpServer(),
 *     },
 *   },
 * })
 * ```
 */
export function createSharedEnvMcpServer() {
  return getProvider().createMcpServer({
    type: 'inline',
    name: 'shared-env',
    version: '1.0.0',
    tools: sharedEnvToolDefinitions,
  });
}
