/**
 * Authentication module for secure third-party OAuth.
 *
 * This module provides:
 * - OAuth 2.0 PKCE flow management
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

// MCP tools
export { authSdkTools, createAuthSdkMcpServer, createAuthCard } from './auth-mcp.js';
