/**
 * Credential utilities for MCP tools.
 *
 * Shared utilities for accessing Feishu credentials and workspace configuration.
 * Uses static imports instead of dynamic require().
 *
 * @module mcp-server/tools/credentials
 */

import { Config } from '@disclaude/core';

/**
 * Get Feishu credentials from Config.
 * Returns undefined values if credentials are not configured.
 */
export function getFeishuCredentials(): { appId: string | undefined; appSecret: string | undefined } {
  return {
    appId: Config.FEISHU_APP_ID || undefined,
    appSecret: Config.FEISHU_APP_SECRET || undefined,
  };
}

/**
 * Get workspace directory from Config.
 * Used for resolving relative file paths in tools.
 */
export function getWorkspaceDir(): string {
  return Config.getWorkspaceDir();
}
