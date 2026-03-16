/**
 * Authentication types for OAuth 2.0 PKCE flow.
 *
 * This module defines types for secure third-party authentication
 * that keeps tokens isolated from the LLM.
 *
 * These types are shared between @disclaude/core and @disclaude/primary-node.
 */

/**
 * OAuth provider configuration.
 * Not pre-defined - agents can use any OAuth-compatible service.
 */
export interface OAuthProviderConfig {
  /** Provider name (e.g., 'github', 'gitlab', 'notion') */
  name: string;
  /** OAuth 2.0 authorization endpoint URL */
  authUrl: string;
  /** OAuth 2.0 token endpoint URL */
  tokenUrl: string;
  /** OAuth client ID */
  clientId: string;
  /** OAuth client secret */
  clientSecret: string;
  /** OAuth scopes to request */
  scopes: string[];
  /** Callback URL for OAuth redirect */
  callbackUrl: string;
}

/**
 * OAuth token stored for a chat.
 */
export interface OAuthToken {
  /** Access token (encrypted) */
  accessToken: string;
  /** Refresh token (encrypted, optional) */
  refreshToken?: string;
  /** Token type (usually 'Bearer') */
  tokenType: string;
  /** Expiration timestamp (Unix milliseconds) */
  expiresAt?: number;
  /** Granted scopes */
  scope?: string;
  /** When the token was created */
  createdAt: number;
}

/**
 * PKCE code verifier and challenge.
 */
export interface PKCECodes {
  /** Random code verifier (43-128 characters) */
  codeVerifier: string;
  /** SHA256 hash of verifier, base64url encoded */
  codeChallenge: string;
}

/**
 * OAuth state for tracking authorization flows.
 */
export interface OAuthState {
  /** Unique state identifier */
  state: string;
  /** Chat ID that initiated the flow */
  chatId: string;
  /** Provider name */
  provider: string;
  /** PKCE codes for this flow */
  pkce: PKCECodes;
  /** When this state was created */
  createdAt: number;
  /** Provider configuration (stored temporarily) */
  providerConfig: OAuthProviderConfig;
}

/**
 * Result of OAuth authorization URL generation.
 */
export interface AuthUrlResult {
  /** Authorization URL to redirect user to */
  url: string;
  /** State identifier for tracking */
  state: string;
}

/**
 * Result of OAuth callback handling.
 */
export interface CallbackResult {
  /** Whether authorization was successful */
  success: boolean;
  /** Chat ID that initiated the flow */
  chatId: string;
  /** Provider name */
  provider: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of token check.
 */
export interface TokenCheckResult {
  /** Whether a valid token exists */
  hasToken: boolean;
  /** Whether the token is expired */
  isExpired?: boolean;
  /** Provider name */
  provider: string;
}

/**
 * API request configuration for authenticated requests.
 */
export interface ApiRequestConfig {
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** API endpoint URL */
  url: string;
  /** Request headers */
  headers?: Record<string, string>;
  /** Request body (for POST/PUT/PATCH) */
  body?: unknown;
}

/**
 * API response from authenticated request.
 */
export interface ApiResponse<T = unknown> {
  /** Whether the request was successful */
  success: boolean;
  /** Response status code */
  status: number;
  /** Response data */
  data?: T;
  /** Error message if failed */
  error?: string;
}

/**
 * Authorization configuration in disclaude.config.yaml.
 */
export interface AuthConfig {
  /** Encryption key for token storage (or env var name) */
  encryptionKey?: string;
  /** Token storage path */
  storagePath?: string;
  /** Callback server port */
  callbackPort?: number;
  /** Callback URL base */
  callbackUrl?: string;
}
