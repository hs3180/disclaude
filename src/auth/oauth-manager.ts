/**
 * OAuth 2.0 PKCE flow manager.
 *
 * Manages OAuth authorization flows with PKCE for security.
 * Supports any OAuth 2.0 compatible provider.
 */

import * as http from 'http';
import * as url from 'url';
import { createLogger } from '../utils/logger.js';
import { getTokenStore, TokenStore } from './token-store.js';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from './crypto.js';
import type {
  OAuthProviderConfig,
  OAuthToken,
  OAuthState,
  AuthUrlResult,
  CallbackResult,
  TokenCheckResult,
  ApiRequestConfig,
  ApiResponse,
  DeviceCodeProviderConfig,
  DeviceCodeFlowResult,
  DeviceCodePollResult,
} from './types.js';
import { DeviceCodeFlow, getDeviceCodeFlow } from './device-code-flow.js';

const logger = createLogger('OAuthManager');

/**
 * In-memory store for pending OAuth states.
 * States are short-lived (5 minutes) so memory storage is acceptable.
 */
const pendingStates = new Map<string, OAuthState>();

/**
 * Clean up expired states (older than 5 minutes).
 */
function cleanupExpiredStates(): void {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes

  for (const [state, data] of pendingStates.entries()) {
    if (now - data.createdAt > maxAge) {
      pendingStates.delete(state);
      logger.debug({ state }, 'Expired OAuth state removed');
    }
  }
}

/**
 * OAuth manager for handling authorization flows.
 */
export class OAuthManager {
  private readonly tokenStore: TokenStore;
  private callbackServer: http.Server | null = null;
  private readonly deviceCodeFlow: DeviceCodeFlow;

  constructor(tokenStore?: TokenStore) {
    this.tokenStore = tokenStore || getTokenStore();
    this.deviceCodeFlow = getDeviceCodeFlow();
  }

  /**
   * Generate an authorization URL for a provider.
   *
   * @param provider - Provider configuration
   * @param chatId - Chat ID initiating the flow
   * @returns Authorization URL and state for tracking
   */
  generateAuthUrl(
    provider: OAuthProviderConfig,
    chatId: string
  ): AuthUrlResult {
    // Clean up old states
    cleanupExpiredStates();

    // Generate PKCE codes
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Generate state for CSRF protection
    const state = generateState();

    // Store state for callback verification
    const oauthState: OAuthState = {
      state,
      chatId,
      provider: provider.name,
      pkce: { codeVerifier, codeChallenge },
      createdAt: Date.now(),
      providerConfig: provider,
    };
    pendingStates.set(state, oauthState);

    // Build authorization URL
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: provider.clientId,
      redirect_uri: provider.callbackUrl,
      scope: provider.scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const authUrl = `${provider.authUrl}?${params.toString()}`;

    logger.info({ chatId, provider: provider.name, state }, 'Authorization URL generated');

    return { url: authUrl, state };
  }

  /**
   * Handle OAuth callback - exchange code for token.
   *
   * @param code - Authorization code from callback
   * @param state - State from callback
   * @returns Callback result with success status
   */
  async handleCallback(code: string, state: string): Promise<CallbackResult> {
    // Clean up old states
    cleanupExpiredStates();

    // Verify state
    const oauthState = pendingStates.get(state);
    if (!oauthState) {
      logger.error({ state }, 'Invalid or expired OAuth state');
      return {
        success: false,
        chatId: '',
        provider: '',
        error: 'Invalid or expired authorization state. Please try again.',
      };
    }

    // Remove state (one-time use)
    pendingStates.delete(state);

    try {
      // Exchange code for token
      const token = await this.exchangeCodeForToken(
        code,
        oauthState.pkce.codeVerifier,
        oauthState.providerConfig
      );

      // Store token
      await this.tokenStore.setToken(
        oauthState.chatId,
        oauthState.provider,
        token
      );

      logger.info(
        { chatId: oauthState.chatId, provider: oauthState.provider },
        'OAuth callback successful'
      );

      return {
        success: true,
        chatId: oauthState.chatId,
        provider: oauthState.provider,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        { err: error, chatId: oauthState.chatId, provider: oauthState.provider },
        'Token exchange failed'
      );

      return {
        success: false,
        chatId: oauthState.chatId,
        provider: oauthState.provider,
        error: errorMessage,
      };
    }
  }

  /**
   * Exchange authorization code for access token.
   */
  private async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    provider: OAuthProviderConfig
  ): Promise<OAuthToken> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: provider.callbackUrl,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code_verifier: codeVerifier,
    });

    const response = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed: ${response.status} - ${text}`);
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Calculate expiration time
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    return {
      accessToken: String(data.access_token),
      refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
      tokenType: String(data.token_type || 'Bearer'),
      expiresAt,
      scope: typeof data.scope === 'string' ? data.scope : undefined,
      createdAt: Date.now(),
    };
  }

  /**
   * Check if a valid token exists for a provider.
   *
   * @param chatId - Chat identifier
   * @param provider - Provider name
   * @returns Token check result
   */
  async checkToken(chatId: string, provider: string): Promise<TokenCheckResult> {
    const token = await this.tokenStore.getToken(chatId, provider);

    if (!token) {
      return { hasToken: false, provider };
    }

    const isExpired = token.expiresAt ? token.expiresAt < Date.now() : false;

    return {
      hasToken: true,
      isExpired,
      provider,
    };
  }

  /**
   * Make an authenticated API request on behalf of the user.
   * Token is injected server-side, never exposed to LLM.
   *
   * @param chatId - Chat identifier
   * @param provider - Provider name
   * @param config - API request configuration
   * @returns API response
   */
  async makeAuthenticatedRequest<T = unknown>(
    chatId: string,
    provider: string,
    config: ApiRequestConfig
  ): Promise<ApiResponse<T>> {
    const accessToken = await this.tokenStore.getAccessToken(chatId, provider);

    if (!accessToken) {
      return {
        success: false,
        status: 401,
        error: `No valid token found for ${provider}. Please authorize first.`,
      };
    }

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...config.headers,
      };

      // Add Content-Type for requests with body
      if (config.body) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(config.url, {
        method: config.method,
        headers,
        body: config.body ? JSON.stringify(config.body) : undefined,
      });

      const {status} = response;

      if (!response.ok) {
        const text = await response.text();
        logger.error(
          { chatId, provider, status, error: text },
          'API request failed'
        );

        return {
          success: false,
          status,
          error: text,
        };
      }

      // Try to parse JSON, fall back to text
      let data: T;
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        data = (await response.json()) as T;
      } else {
        data = (await response.text()) as T;
      }

      return {
        success: true,
        status,
        data,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        { err: error, chatId, provider },
        'API request error'
      );

      return {
        success: false,
        status: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Revoke (delete) a token.
   *
   * @param chatId - Chat identifier
   * @param provider - Provider name
   * @returns true if token was deleted
   */
  revokeToken(chatId: string, provider: string): Promise<boolean> {
    return this.tokenStore.deleteToken(chatId, provider);
  }

  /**
   * List all authorized providers for a chat.
   *
   * @param chatId - Chat identifier
   * @returns Array of provider names
   */
  listAuthorizations(chatId: string): Promise<string[]> {
    return this.tokenStore.listProviders(chatId);
  }

  /**
   * Start a callback server for OAuth redirects.
   *
   * @param port - Port to listen on
   * @returns Server URL
   */
  startCallbackServer(port: number = 3000): Promise<string> {
    if (this.callbackServer) {
      return Promise.resolve(`http://localhost:${port}`);
    }

    return new Promise((resolve, reject) => {
      this.callbackServer = http.createServer(async (req, res) => {
        try {
          const reqUrl = new url.URL(req.url || '/', `http://localhost:${port}`);

          if (reqUrl.pathname === '/auth/callback') {
            const code = reqUrl.searchParams.get('code');
            const state = reqUrl.searchParams.get('state');
            const error = reqUrl.searchParams.get('error');

            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end(`<h1>Authorization Failed</h1><p>${error}</p>`);
              return;
            }

            if (!code || !state) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<h1>Invalid Callback</h1><p>Missing code or state.</p>');
              return;
            }

            const result = await this.handleCallback(code, state);

            if (result.success) {
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`
                <h1>Authorization Successful</h1>
                <p>You have successfully authorized <strong>${result.provider}</strong>.</p>
                <p>You can close this window and return to your chat.</p>
              `);
            } else {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end(`
                <h1>Authorization Failed</h1>
                <p>${result.error || 'Unknown error'}</p>
              `);
            }
          } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
          }
        } catch (error) {
          logger.error({ err: error }, 'Callback server error');
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      });

      this.callbackServer.listen(port, () => {
        logger.info({ port }, 'OAuth callback server started');
        resolve(`http://localhost:${port}`);
      });

      this.callbackServer.on('error', reject);
    });
  }

  /**
   * Stop the callback server.
   */
  stopCallbackServer(): void {
    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
      logger.info('OAuth callback server stopped');
    }
  }

  /**
   * Initiate Device Code Flow for a provider.
   * Alternative to PKCE flow for server/container deployments.
   *
   * @param provider - Provider configuration with device code endpoints
   * @param chatId - Chat ID initiating the flow
   * @returns Device Code Flow result with user code and verification URL
   */
  async initiateDeviceCodeFlow(
    provider: DeviceCodeProviderConfig,
    chatId: string
  ): Promise<DeviceCodeFlowResult> {
    logger.info({ chatId, provider: provider.name }, 'Initiating Device Code Flow');
    return this.deviceCodeFlow.initiateDeviceCode(provider, chatId);
  }

  /**
   * Poll for Device Code authorization.
   *
   * @param stateId - State ID from initiation
   * @returns Poll result indicating authorization status
   */
  async pollDeviceCode(stateId: string): Promise<DeviceCodePollResult> {
    return this.deviceCodeFlow.pollForToken(stateId);
  }

  /**
   * Start automatic polling for Device Code authorization.
   *
   * @param stateId - State ID from initiation
   * @param onProgress - Callback for progress updates (optional)
   * @returns Final poll result
   */
  async startDeviceCodePolling(
    stateId: string,
    onProgress?: (result: DeviceCodePollResult) => void
  ): Promise<DeviceCodePollResult> {
    return this.deviceCodeFlow.startPolling(stateId, onProgress);
  }

  /**
   * Cancel a pending Device Code Flow.
   *
   * @param stateId - State ID to cancel
   */
  cancelDeviceCodeFlow(stateId: string): void {
    this.deviceCodeFlow.cancelDeviceCode(stateId);
  }

  /**
   * Get Device Code state information.
   *
   * @param stateId - State ID
   * @returns Device Code state or undefined
   */
  getDeviceCodeState(stateId: string) {
    return this.deviceCodeFlow.getState(stateId);
  }
}

/**
 * Singleton OAuth manager instance.
 */
let oauthManagerInstance: OAuthManager | null = null;

/**
 * Get the global OAuth manager instance.
 */
export function getOAuthManager(): OAuthManager {
  if (!oauthManagerInstance) {
    oauthManagerInstance = new OAuthManager();
  }
  return oauthManagerInstance;
}
