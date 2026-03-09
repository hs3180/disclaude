/**
 * Authentication types for OAuth 2.0 PKCE flow.
 *
 * This module defines types for secure third-party authentication
 * that keeps tokens isolated from the LLM.
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

/**
 * Device Code Flow response from OAuth provider.
 * RFC 8628 Section 3.2
 */
export interface DeviceCodeResponse {
  /** The device verification code */
  device_code: string;
  /** The end-user verification code */
  user_code: string;
  /** The end-user verification URI */
  verification_uri: string;
  /** The verification URI with user code included (optional) */
  verification_uri_complete?: string;
  /** Lifetime in seconds of the device_code */
  expires_in: number;
  /** The minimum amount of time in seconds between polling requests */
  interval: number;
}

/**
 * Device Token response from OAuth provider.
 * RFC 8628 Section 3.5
 */
export interface DeviceTokenResponse {
  /** Access token (on success) */
  access_token?: string;
  /** Token type (usually 'Bearer') */
  token_type?: string;
  /** Refresh token (optional) */
  refresh_token?: string;
  /** Lifetime in seconds of the access token */
  expires_in?: number;
  /** Granted scopes */
  scope?: string;
  /** Error code (on pending/failure) */
  error?: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied';
  /** Human-readable error description */
  error_description?: string;
}

/**
 * Device Code Flow state for tracking pending authorizations.
 */
export interface DeviceCodeState {
  /** Unique identifier for this flow */
  id: string;
  /** Chat ID that initiated the flow */
  chatId: string;
  /** Provider name */
  provider: string;
  /** The device code */
  deviceCode: string;
  /** The user code to display */
  userCode: string;
  /** The verification URL */
  verificationUri: string;
  /** When this state was created */
  createdAt: number;
  /** Expiration timestamp */
  expiresAt: number;
  /** Polling interval in seconds */
  interval: number;
  /** Provider configuration */
  providerConfig: DeviceCodeProviderConfig;
  /** Whether polling is active */
  polling: boolean;
}

/**
 * Device Code Flow provider configuration.
 * Extends OAuthProviderConfig with Device Code specific endpoints.
 */
export interface DeviceCodeProviderConfig extends OAuthProviderConfig {
  /** Device code endpoint URL */
  deviceCodeUrl: string;
  /** Whether this provider supports Device Code Flow */
  supportsDeviceCode: boolean;
}

/**
 * Result of initiating Device Code Flow.
 */
export interface DeviceCodeFlowResult {
  /** Whether initiation was successful */
  success: boolean;
  /** User code to display */
  userCode?: string;
  /** Verification URL */
  verificationUri?: string;
  /** State ID for tracking */
  stateId?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of polling for Device Code token.
 */
export interface DeviceCodePollResult {
  /** Whether authorization is complete */
  complete: boolean;
  /** Whether authorized successfully */
  success?: boolean;
  /** Error message if failed */
  error?: string;
  /** Error type for specific handling */
  errorType?: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied';
}
