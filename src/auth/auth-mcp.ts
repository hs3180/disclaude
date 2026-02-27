/**
 * MCP tools for OAuth authentication.
 *
 * These tools allow agents to:
 * - Check if authorization is needed
 * - Generate authorization URLs for any OAuth provider
 * - Make authenticated API requests (token never exposed to LLM)
 * - List and revoke authorizations
 *
 * Key principle: Tokens are NEVER exposed to the LLM.
 * The LLM only knows whether authorization exists and can make API calls.
 */

import { z } from 'zod';
import { getProvider, type InlineToolDefinition } from '../sdk/index.js';
import { createLogger } from '../utils/logger.js';
import { getOAuthManager, OAuthManager } from './oauth-manager.js';
import type { OAuthProviderConfig } from './types.js';

const logger = createLogger('AuthMCP');

/**
 * Helper to create a successful tool result.
 */
function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Helper to create an error tool result (soft error, not thrown).
 */
function toolError(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: `⚠️ ${text}` }],
  };
}

/**
 * Create authorization card for Feishu.
 * This is a helper for agents to easily send authorization UI.
 */
export function createAuthCard(authUrl: string, provider: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🔗 ${provider} 授权` },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content: `需要授权访问您的 **${provider}** 账号。点击下方按钮完成授权。`,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `授权 ${provider}` },
            url: authUrl,
            type: 'primary',
          },
        ],
      },
      {
        tag: 'markdown',
        content: '_💡 授权信息将加密存储，AI 无法直接查看您的凭证_',
      },
    ],
  };
}

/**
 * Get OAuth manager instance (allows injection for testing).
 */
function getManager(): OAuthManager {
  return getOAuthManager();
}

/**
 * Auth MCP tool definitions for Agent SDK.
 *
 * Uses InlineToolDefinition format for SDK abstraction.
 */
export const authToolDefinitions: InlineToolDefinition[] = [
  {
    name: 'auth_check',
    description: 'Check if the user has authorized a service. Returns whether authorization exists and if the token is expired.',
    parameters: z.object({
      provider: z.string().describe('Provider name (e.g., "github", "gitlab", "notion")'),
      chatId: z.string().describe('Chat ID from the task context'),
    }),
    handler: async ({ provider, chatId }) => {
      try {
        const manager = getManager();
        const result = await manager.checkToken(chatId, provider);

        if (!result.hasToken) {
          return toolSuccess(`No authorization found for ${provider}. The user needs to authorize this service first.`);
        }

        if (result.isExpired) {
          return toolSuccess(`Authorization for ${provider} exists but has expired. The user needs to re-authorize.`);
        }

        return toolSuccess(`✅ Authorization for ${provider} is valid.`);
      } catch (error) {
        return toolError(`Failed to check authorization: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'auth_generate_url',
    description: 'Generate an OAuth authorization URL for a service. Returns the URL and state. The user must visit this URL to authorize. Use with send_user_feedback to send the URL to the user.',
    parameters: z.object({
      providerName: z.string().describe('Provider name (e.g., "github", "gitlab")'),
      authUrl: z.string().describe('OAuth authorization endpoint URL'),
      tokenUrl: z.string().describe('OAuth token endpoint URL'),
      clientId: z.string().describe('OAuth client ID'),
      clientSecret: z.string().describe('OAuth client secret'),
      scopes: z.string().describe('Space-separated OAuth scopes to request'),
      callbackUrl: z.string().describe('OAuth callback URL (must match the registered redirect URI)'),
      chatId: z.string().describe('Chat ID from the task context'),
    }),
    handler: async ({ providerName, authUrl, tokenUrl, clientId, clientSecret, scopes, callbackUrl, chatId }) => {
      try {
        const provider: OAuthProviderConfig = {
          name: providerName,
          authUrl,
          tokenUrl,
          clientId,
          clientSecret,
          scopes: scopes.split(' ').filter(Boolean),
          callbackUrl,
        };

        const manager = getManager();
        const result = manager.generateAuthUrl(provider, chatId);

        logger.info({ chatId, provider: providerName }, 'Authorization URL generated');

        return toolSuccess(
          `Authorization URL generated:\n\n` +
          `**URL:** ${result.url}\n\n` +
          `Send this URL to the user so they can authorize. After authorization, the user should return and continue.`
        );
      } catch (error) {
        return toolError(`Failed to generate authorization URL: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'auth_request',
    description: 'Make an authenticated API request on behalf of the user. The token is injected server-side and never exposed. Use this to call APIs after the user has authorized.',
    parameters: z.object({
      chatId: z.string().describe('Chat ID from the task context'),
      provider: z.string().describe('Provider name (e.g., "github", "gitlab")'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method'),
      url: z.string().describe('Full API URL to call'),
      headers: z.record(z.string(), z.string()).optional().describe('Additional headers (Authorization header is added automatically)'),
      body: z.unknown().optional().describe('Request body (for POST/PUT/PATCH)'),
    }),
    handler: async ({ chatId, provider, method, url, headers, body }) => {
      try {
        const manager = getManager();
        const result = await manager.makeAuthenticatedRequest(chatId, provider, {
          method,
          url,
          headers: headers as Record<string, string> | undefined,
          body,
        });

        if (!result.success) {
          if (result.status === 401) {
            return toolError(
              `Authentication required for ${provider}. The user needs to authorize this service first. ` +
              `Use auth_check to verify authorization status.`
            );
          }
          return toolError(`API request failed (${result.status}): ${result.error}`);
        }

        // Return data as formatted JSON
        const dataStr = typeof result.data === 'string'
          ? result.data
          : JSON.stringify(result.data, null, 2);

        return toolSuccess(`API request successful (${result.status}):\n\n\`\`\`json\n${dataStr}\n\`\`\``);
      } catch (error) {
        return toolError(`API request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'auth_list',
    description: 'List all services the user has authorized in this chat.',
    parameters: z.object({
      chatId: z.string().describe('Chat ID from the task context'),
    }),
    handler: async ({ chatId }) => {
      try {
        const manager = getManager();
        const providers = await manager.listAuthorizations(chatId);

        if (providers.length === 0) {
          return toolSuccess('No authorizations found for this chat.');
        }

        return toolSuccess(
          `Authorized services:\n${providers.map(p => `- ${p}`).join('\n')}`
        );
      } catch (error) {
        return toolError(`Failed to list authorizations: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'auth_revoke',
    description: 'Revoke authorization for a service. This deletes the stored token.',
    parameters: z.object({
      chatId: z.string().describe('Chat ID from the task context'),
      provider: z.string().describe('Provider name to revoke'),
    }),
    handler: async ({ chatId, provider }) => {
      try {
        const manager = getManager();
        const deleted = await manager.revokeToken(chatId, provider);

        if (deleted) {
          return toolSuccess(`✅ Authorization for ${provider} has been revoked.`);
        } else {
          return toolSuccess(`No authorization found for ${provider} to revoke.`);
        }
      } catch (error) {
        return toolError(`Failed to revoke authorization: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];

/**
 * Auth MCP tools for Agent SDK (SDK-compatible format).
 *
 * @deprecated Use authToolDefinitions with getProvider().createMcpServer() instead.
 */
export const authSdkTools = authToolDefinitions.map(def => getProvider().createInlineTool(def));

/**
 * Create SDK MCP server for authentication tools.
 */
export function createAuthSdkMcpServer() {
  return getProvider().createMcpServer({
    type: 'inline',
    name: 'auth',
    version: '1.0.0',
    tools: authToolDefinitions,
  });
}
