/**
 * Authentication module for secure third-party OAuth.
 *
 * This module provides:
 * - OAuth 2.0 PKCE flow management
 * - Device Code Flow (RFC 8628) for server/chat scenarios
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
  DeviceCodeProviderConfig,
  DeviceCodeState,
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
export {
  DeviceCodeFlowManager,
  getDeviceCodeFlowManager,
  initiateDeviceCode,
  pollForToken,
} from './device-code-flow.js';

// Provider templates
export {
  OAUTH_PROVIDER_TEMPLATES,
  getProviderTemplate,
  supportsDeviceCode,
  createProviderConfig,
} from './provider-templates.js';

// MCP tools
export {
  authSdkTools,
  createAuthSdkMcpServer,
  createAuthCard,
  createDeviceCodeCard,
  authToolDefinitions,
} from './auth-mcp.js';
