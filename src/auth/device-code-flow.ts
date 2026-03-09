/**
 * Device Code Flow implementation (RFC 8628).
 *
 * Provides OAuth authentication for devices without a browser
 * or when callback URLs are not available (e.g., server deployment).
 */

import { createLogger } from '../utils/logger.js';
import { getTokenStore, TokenStore } from './token-store.js';
import { generateState } from './crypto.js';
import type {
  DeviceCodeResponse,
  DeviceTokenResponse,
  DeviceCodeState,
  DeviceCodeProviderConfig,
  DeviceCodeFlowResult,
  DeviceCodePollResult,
  OAuthToken,
} from './types.js';

const logger = createLogger('DeviceCodeFlow');

/**
 * In-memory store for pending Device Code states.
 * States are short-lived (typically 15 minutes) so memory storage is acceptable.
 */
const pendingDeviceCodes = new Map<string, DeviceCodeState>();

/**
 * Active polling intervals for cleanup.
 */
const activePollingIntervals = new Map<string, NodeJS.Timeout>();

/**
 * Clean up expired device code states.
 */
function cleanupExpiredStates(): void {
  const now = Date.now();

  for (const [id, state] of pendingDeviceCodes.entries()) {
    if (state.expiresAt < now) {
      pendingDeviceCodes.delete(id);
      stopPolling(id);
      logger.debug({ stateId: id }, 'Expired Device Code state removed');
    }
  }
}

/**
 * Stop polling for a specific state.
 */
function stopPolling(stateId: string): void {
  const interval = activePollingIntervals.get(stateId);
  if (interval) {
    clearInterval(interval);
    activePollingIntervals.delete(stateId);
    logger.debug({ stateId }, 'Polling stopped');
  }
}

/**
 * Device Code Flow manager.
 */
export class DeviceCodeFlow {
  private readonly tokenStore: TokenStore;

  constructor(tokenStore?: TokenStore) {
    this.tokenStore = tokenStore || getTokenStore();
  }

  /**
   * Initiate Device Code Flow for a provider.
   *
   * @param provider - Provider configuration with device code endpoints
   * @param chatId - Chat ID initiating the flow
   * @returns Device Code Flow result with user code and verification URL
   */
  async initiateDeviceCode(
    provider: DeviceCodeProviderConfig,
    chatId: string
  ): Promise<DeviceCodeFlowResult> {
    // Clean up old states
    cleanupExpiredStates();

    if (!provider.supportsDeviceCode || !provider.deviceCodeUrl) {
      return {
        success: false,
        error: `Provider ${provider.name} does not support Device Code Flow`,
      };
    }

    try {
      // Request device code from provider
      const params = new URLSearchParams({
        client_id: provider.clientId,
        scope: provider.scopes.join(' '),
      });

      // Some providers require client_secret
      if (provider.clientSecret) {
        params.append('client_secret', provider.clientSecret);
      }

      logger.info({ provider: provider.name, chatId }, 'Requesting device code');

      const response = await fetch(provider.deviceCodeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error({ status: response.status, body: text }, 'Device code request failed');
        return {
          success: false,
          error: `Failed to request device code: ${response.status} - ${text}`,
        };
      }

      const data = (await response.json()) as DeviceCodeResponse;

      // Validate required fields
      if (!data.device_code || !data.user_code || !data.verification_uri) {
        return {
          success: false,
          error: 'Invalid device code response: missing required fields',
        };
      }

      // Create state for tracking
      const stateId = generateState();
      const now = Date.now();
      const expiresIn = data.expires_in || 900; // Default 15 minutes
      const interval = data.interval || 5; // Default 5 seconds

      const state: DeviceCodeState = {
        id: stateId,
        chatId,
        provider: provider.name,
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        createdAt: now,
        expiresAt: now + expiresIn * 1000,
        interval,
        providerConfig: provider,
        polling: false,
      };

      pendingDeviceCodes.set(stateId, state);

      logger.info(
        { stateId, chatId, provider: provider.name, userCode: data.user_code },
        'Device Code Flow initiated'
      );

      return {
        success: true,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        stateId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, provider: provider.name }, 'Device code initiation failed');
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Poll for token after user authorizes.
   *
   * @param stateId - State ID from initiation
   * @returns Poll result indicating authorization status
   */
  async pollForToken(stateId: string): Promise<DeviceCodePollResult> {
    const state = pendingDeviceCodes.get(stateId);

    if (!state) {
      return {
        complete: true,
        success: false,
        error: 'Invalid or expired device code state',
      };
    }

    // Check if expired
    if (state.expiresAt < Date.now()) {
      pendingDeviceCodes.delete(stateId);
      stopPolling(stateId);
      return {
        complete: true,
        success: false,
        error: 'Device code has expired',
        errorType: 'expired_token',
      };
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: state.deviceCode,
        client_id: state.providerConfig.clientId,
      });

      // Some providers require client_secret
      if (state.providerConfig.clientSecret) {
        params.append('client_secret', state.providerConfig.clientSecret);
      }

      const response = await fetch(state.providerConfig.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: params.toString(),
      });

      const data = (await response.json()) as DeviceTokenResponse;

      // Check for errors
      if (data.error) {
        switch (data.error) {
          case 'authorization_pending':
            return {
              complete: false,
              errorType: 'authorization_pending',
            };
          case 'slow_down':
            // Increase interval
            state.interval = Math.min(state.interval * 2, 60);
            return {
              complete: false,
              errorType: 'slow_down',
            };
          case 'expired_token':
            pendingDeviceCodes.delete(stateId);
            stopPolling(stateId);
            return {
              complete: true,
              success: false,
              error: 'Device code has expired',
              errorType: 'expired_token',
            };
          case 'access_denied':
            pendingDeviceCodes.delete(stateId);
            stopPolling(stateId);
            return {
              complete: true,
              success: false,
              error: 'User denied authorization',
              errorType: 'access_denied',
            };
          default:
            return {
              complete: true,
              success: false,
              error: data.error_description || data.error,
            };
        }
      }

      // Success - store token
      if (data.access_token) {
        const token: OAuthToken = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          tokenType: data.token_type || 'Bearer',
          expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
          scope: data.scope,
          createdAt: Date.now(),
        };

        await this.tokenStore.setToken(state.chatId, state.provider, token);

        // Clean up state
        pendingDeviceCodes.delete(stateId);
        stopPolling(stateId);

        logger.info(
          { stateId, chatId: state.chatId, provider: state.provider },
          'Device Code Flow completed successfully'
        );

        return {
          complete: true,
          success: true,
        };
      }

      return {
        complete: true,
        success: false,
        error: 'Invalid token response',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, stateId }, 'Token polling failed');
      return {
        complete: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Start automatic polling for token.
   * Polls until authorization is complete, expired, or cancelled.
   *
   * @param stateId - State ID from initiation
   * @param onProgress - Callback for progress updates (optional)
   * @returns Final poll result
   */
  async startPolling(
    stateId: string,
    onProgress?: (result: DeviceCodePollResult) => void
  ): Promise<DeviceCodePollResult> {
    const state = pendingDeviceCodes.get(stateId);

    if (!state) {
      return {
        complete: true,
        success: false,
        error: 'Invalid or expired device code state',
      };
    }

    if (state.polling) {
      return {
        complete: false,
        error: 'Polling already in progress',
      };
    }

    state.polling = true;

    return new Promise((resolve) => {
      const poll = async () => {
        const result = await this.pollForToken(stateId);

        if (onProgress) {
          onProgress(result);
        }

        if (result.complete) {
          resolve(result);
          return;
        }

        // Schedule next poll
        const interval = activePollingIntervals.get(stateId);
        if (interval) {
          // Interval already set, just return
          return;
        }

        const newInterval = setInterval(async () => {
          const pollResult = await this.pollForToken(stateId);

          if (onProgress) {
            onProgress(pollResult);
          }

          if (pollResult.complete) {
            clearInterval(newInterval);
            activePollingIntervals.delete(stateId);
            resolve(pollResult);
          }
        }, state.interval * 1000);

        activePollingIntervals.set(stateId, newInterval);
      };

      // Start polling immediately
      poll();
    });
  }

  /**
   * Cancel a pending Device Code Flow.
   *
   * @param stateId - State ID to cancel
   */
  cancelDeviceCode(stateId: string): void {
    const state = pendingDeviceCodes.get(stateId);
    if (state) {
      state.polling = false;
      pendingDeviceCodes.delete(stateId);
      stopPolling(stateId);
      logger.info({ stateId }, 'Device Code Flow cancelled');
    }
  }

  /**
   * Get a pending Device Code state.
   *
   * @param stateId - State ID
   * @returns Device Code state or undefined
   */
  getState(stateId: string): DeviceCodeState | undefined {
    return pendingDeviceCodes.get(stateId);
  }

  /**
   * Check if a state is currently polling.
   *
   * @param stateId - State ID
   * @returns Whether polling is active
   */
  isPolling(stateId: string): boolean {
    const state = pendingDeviceCodes.get(stateId);
    return state?.polling ?? false;
  }
}

/**
 * Singleton Device Code Flow instance.
 */
let deviceCodeFlowInstance: DeviceCodeFlow | null = null;

/**
 * Get the global Device Code Flow instance.
 */
export function getDeviceCodeFlow(): DeviceCodeFlow {
  if (!deviceCodeFlowInstance) {
    deviceCodeFlowInstance = new DeviceCodeFlow();
  }
  return deviceCodeFlowInstance;
}

/**
 * Create a Device Code authorization card for Feishu.
 */
export function createDeviceCodeCard(
  userCode: string,
  verificationUri: string,
  provider: string
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🔐 ${provider} 授权` },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content: `请在浏览器中完成授权：\n\n**1.** 访问: ${verificationUri}\n**2.** 输入设备码: \`${userCode}\`\n\n⏳ 等待授权中...`,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '打开授权页面' },
            url: verificationUri,
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
