/**
 * Authentication module.
 *
 * This module provides:
 * - Types for OAuth 2.0 PKCE flow
 * - Cryptographic utilities for secure token storage
 * - Token storage for OAuth tokens
 * - OAuth manager for handling authorization flows
 *
 * @module auth
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
  isEncrypted,
  getEncryptionKey,
} from './crypto.js';

// Token storage
export { TokenStore, getTokenStore } from './token-store.js';

// OAuth manager
export { OAuthManager, getOAuthManager } from './oauth-manager.js';
