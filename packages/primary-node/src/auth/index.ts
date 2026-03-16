/**
 * Authentication module for secure third-party OAuth.
 *
 * This module provides:
 * - OAuth 2.0 PKCE flow management (re-exported from @disclaude/core)
 * - Encrypted token storage (re-exported from @disclaude/core)
 * - MCP tools for agent integration (primary-node specific)
 *
 * Key principle: Tokens are NEVER exposed to the LLM.
 *
 * @see Issue #1041 - Auth implementations migrated to @disclaude/core
 */

// Re-export types from @disclaude/core
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
} from '@disclaude/core';

// Re-export crypto utilities from @disclaude/core
export {
  encrypt,
  decrypt,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from '@disclaude/core';

// Re-export token storage from @disclaude/core
export { TokenStore, getTokenStore } from '@disclaude/core';

// Re-export OAuth manager from @disclaude/core
export { OAuthManager, getOAuthManager } from '@disclaude/core';

// MCP tools (primary-node specific)
export { createAuthCard } from './auth-mcp.js';
