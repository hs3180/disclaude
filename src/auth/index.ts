/**
 * Authentication module for secure third-party OAuth.
 *
 * This module provides:
 * - OAuth 2.0 PKCE flow management
 * - Device Code Flow (RFC 8628) for server/container deployments
 * - Encrypted token storage
 * - MCP tools for agent integration
 *
 * Key principle: Tokens are NEVER exposed to the LLM.
 */

// Types
export type {
  OAuthProviderConfig,
  OAuthToken,
  PKCECodes,
  OAuthState,
  AuthUrlResult,
  CallbackResult,
  TokenCheckResult,
  ApiRequestConfig,
  ApiResponse,
  AuthConfig,
  DeviceCodeResponse,
  DeviceTokenResponse,
  DeviceCodeState,
  DeviceCodeProviderConfig,
  DeviceCodeFlowResult,
  DeviceCodePollResult,
} from './types.js';

// Crypto utilities
export {
  encrypt,
  decrypt,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from './crypto.js';

// Token storage
export { TokenStore, getTokenStore } from './token-store.js';

// OAuth manager
export { OAuthManager, getOAuthManager } from './oauth-manager.js';

// Device Code Flow
export { DeviceCodeFlow, getDeviceCodeFlow, createDeviceCodeCard } from './device-code-flow.js';

// MCP tools
export { authSdkTools, createAuthSdkMcpServer, createAuthCard } from './auth-mcp.js';
