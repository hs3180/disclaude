/**
 * Device Code Flow implementation (RFC 8628).
 *
 * Provides OAuth 2.0 Device Authorization Grant for scenarios
 * where a local callback server is not available or practical:
 * - Server deployments without public IP
 * - Chat/IM scenarios
 * - Containerized deployments
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8628
 */

import { createLogger } from '../utils/logger.js';
import { getTokenStore, TokenStore } from './token-store.js';
import type {
  DeviceCodeProviderConfig,
  DeviceCodeResponse,
  DeviceCodeState,
  OAuthToken,
} from './types.js';

const logger = createLogger('DeviceCodeFlow');

/**
 * In-memory store for pending Device Code states.
 * States are short-lived (default 15 minutes) so memory storage is acceptable.
 */
const pendingDeviceCodes = new Map<string, DeviceCodeState>();

/**
 * Active polling intervals for cleanup on cancellation.
 */
const activePollers = new Map<string, NodeJS.Timeout>();

/**
 * Generate a unique ID for device code flow.
 */
function generateFlowId(): string {
  return `dc_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Clean up expired device code states.
 */
function cleanupExpiredStates(): void {
  const now = Date.now();

  for (const [id, state] of pendingDeviceCodes.entries()) {
    if (now > state.expiresAt) {
      pendingDeviceCodes.delete(id);
      // Also stop any active polling
      const poller = activePollers.get(id);
      if (poller) {
        clearInterval(poller);
        activePollers.delete(id);
      }
      logger.debug({ id, provider: state.provider }, 'Expired device code state removed');
    }
  }
}

/**
 * Request a device code from the OAuth provider.
 *
 * @param config - Provider configuration with device code endpoint
 * @returns Device code response with user_code and verification_uri
 */
export async function initiateDeviceCode(
  config: DeviceCodeProviderConfig
): Promise<DeviceCodeResponse> {
  if (!config.deviceCodeUrl) {
    throw new Error(`Provider ${config.name} does not have a device code URL configured`);
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    scope: config.scopes.join(' '),
  });

  logger.info({ provider: config.name }, 'Requesting device code');

  const response = await fetch(config.deviceCodeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to request device code: ${response.status} - ${text}`);
  }

  const data = (await response.json()) as DeviceCodeResponse;

  logger.info(
    {
      provider: config.name,
      userCode: data.user_code,
      expiresIn: data.expires_in,
    },
    'Device code received'
  );

  return data;
}

/**
 * Poll for token after user authorization.
 *
 * @param config - Provider configuration
 * @param deviceCode - The device code from initiation
 * @param interval - Polling interval in seconds
 * @param onStatus - Optional callback for status updates
 * @returns OAuth token when authorization is complete
 */
export async function pollForToken(
  config: DeviceCodeProviderConfig,
  deviceCode: string,
  interval: number = 5,
  onStatus?: (status: string) => void
): Promise<OAuthToken> {
  const tokenUrl = config.deviceTokenUrl || config.tokenUrl;

  if (!tokenUrl) {
    throw new Error(`Provider ${config.name} does not have a token URL configured`);
  }

  const maxAttempts = 180; // 15 minutes at 5 second intervals
  let attempts = 0;
  let currentInterval = interval;

  while (attempts < maxAttempts) {
    attempts++;

    // Wait before polling (except first attempt)
    if (attempts > 1) {
      await new Promise(resolve => setTimeout(resolve, currentInterval * 1000));
    }

    const params = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: config.clientId,
      device_code: deviceCode,
    });

    // Include client secret if available (required by some providers)
    if (config.clientSecret) {
      params.append('client_secret', config.clientSecret);
    }

    try {
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: params.toString(),
      });

      const data = (await response.json()) as Record<string, unknown>;

      // Check for errors
      if (data.error) {
        const error = data.error as string;

        if (error === 'authorization_pending') {
          onStatus?.('waiting');
          logger.debug({ provider: config.name }, 'Authorization pending, continuing to poll');
          continue;
        }

        if (error === 'slow_down') {
          currentInterval = Math.min(currentInterval + 5, 60); // Max 60 seconds
          onStatus?.(`slow_down:${currentInterval}`);
          logger.info(
            { provider: config.name, newInterval: currentInterval },
            'Slowing down polling'
          );
          continue;
        }

        if (error === 'expired_token') {
          throw new Error('Device code has expired. Please start a new authorization flow.');
        }

        if (error === 'access_denied') {
          throw new Error('Authorization was denied by the user.');
        }

        throw new Error(`Token polling error: ${error} - ${data.error_description || 'Unknown error'}`);
      }

      // Success! We have a token
      const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
      const expiresAt = Date.now() + expiresIn * 1000;

      const token: OAuthToken = {
        accessToken: String(data.access_token),
        refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
        tokenType: String(data.token_type || 'Bearer'),
        expiresAt,
        scope: typeof data.scope === 'string' ? data.scope : undefined,
        createdAt: Date.now(),
      };

      logger.info({ provider: config.name }, 'Device code authorization successful');
      onStatus?.('success');

      return token;
    } catch (error) {
      if (error instanceof Error && (
        error.message.includes('expired') ||
        error.message.includes('denied')
      )) {
        throw error;
      }

      logger.warn(
        { err: error, provider: config.name, attempt: attempts },
        'Token polling attempt failed, retrying'
      );
    }
  }

  throw new Error('Device code authorization timed out after maximum attempts');
}

/**
 * Device Code Flow Manager.
 *
 * Manages the complete Device Code Flow lifecycle:
 * 1. Initiate: Request device code from provider
 * 2. Display: Show user code and verification URL
 * 3. Poll: Wait for user to complete authorization
 * 4. Store: Save token when authorization completes
 */
export class DeviceCodeFlowManager {
  private readonly tokenStore: TokenStore;

  constructor(tokenStore?: TokenStore) {
    this.tokenStore = tokenStore || getTokenStore();
  }

  /**
   * Start a Device Code Flow.
   *
   * @param config - Provider configuration
   * @param chatId - Chat ID initiating the flow
   * @returns Device code state with user_code and verification_uri
   */
  async startFlow(
    config: DeviceCodeProviderConfig,
    chatId: string
  ): Promise<DeviceCodeState> {
    // Clean up old states
    cleanupExpiredStates();

    // Request device code
    const response = await initiateDeviceCode(config);

    // Create state
    const state: DeviceCodeState = {
      id: generateFlowId(),
      chatId,
      provider: config.name,
      deviceCode: response.device_code,
      userCode: response.user_code,
      verificationUri: response.verification_uri_complete || response.verification_uri,
      interval: response.interval,
      expiresAt: Date.now() + response.expires_in * 1000,
      createdAt: Date.now(),
      providerConfig: config,
    };

    // Store state
    pendingDeviceCodes.set(state.id, state);

    logger.info(
      {
        id: state.id,
        chatId,
        provider: config.name,
        userCode: state.userCode,
      },
      'Device code flow started'
    );

    return state;
  }

  /**
   * Complete a Device Code Flow by polling for the token.
   *
   * @param flowId - The flow ID returned from startFlow
   * @param onStatus - Optional callback for status updates
   * @returns The chat ID and provider when complete
   */
  async completeFlow(
    flowId: string,
    onStatus?: (status: string) => void
  ): Promise<{ chatId: string; provider: string }> {
    const state = pendingDeviceCodes.get(flowId);

    if (!state) {
      throw new Error('Invalid or expired device code flow');
    }

    if (Date.now() > state.expiresAt) {
      pendingDeviceCodes.delete(flowId);
      throw new Error('Device code has expired. Please start a new authorization flow.');
    }

    try {
      // Poll for token
      const token = await pollForToken(
        state.providerConfig,
        state.deviceCode,
        state.interval,
        onStatus
      );

      // Store token
      await this.tokenStore.setToken(state.chatId, state.provider, token);

      // Clean up state
      pendingDeviceCodes.delete(flowId);

      logger.info(
        { flowId, chatId: state.chatId, provider: state.provider },
        'Device code flow completed successfully'
      );

      return {
        chatId: state.chatId,
        provider: state.provider,
      };
    } catch (error) {
      // Clean up on failure
      pendingDeviceCodes.delete(flowId);
      throw error;
    }
  }

  /**
   * Cancel a pending Device Code Flow.
   *
   * @param flowId - The flow ID to cancel
   */
  cancelFlow(flowId: string): void {
    const poller = activePollers.get(flowId);
    if (poller) {
      clearInterval(poller);
      activePollers.delete(flowId);
    }
    pendingDeviceCodes.delete(flowId);
    logger.info({ flowId }, 'Device code flow cancelled');
  }

  /**
   * Get a pending flow state.
   *
   * @param flowId - The flow ID
   * @returns The flow state or undefined
   */
  getFlowState(flowId: string): DeviceCodeState | undefined {
    return pendingDeviceCodes.get(flowId);
  }

  /**
   * Start polling in the background and resolve when complete.
   *
   * @param flowId - The flow ID
   * @param onStatus - Status callback
   * @returns Promise that resolves when authorization completes
   */
  async pollInBackground(
    flowId: string,
    onStatus?: (status: string) => void
  ): Promise<{ chatId: string; provider: string }> {
    return new Promise((resolve, reject) => {
      const state = pendingDeviceCodes.get(flowId);

      if (!state) {
        reject(new Error('Invalid or expired device code flow'));
        return;
      }

      const poll = async () => {
        try {
          const result = await this.completeFlow(flowId, onStatus);
          activePollers.delete(flowId);
          resolve(result);
        } catch (error) {
          activePollers.delete(flowId);
          reject(error);
        }
      };

      // Start polling
      poll();
    });
  }
}

/**
 * Singleton instance.
 */
let deviceCodeFlowInstance: DeviceCodeFlowManager | null = null;

/**
 * Get the global Device Code Flow manager instance.
 */
export function getDeviceCodeFlowManager(): DeviceCodeFlowManager {
  if (!deviceCodeFlowInstance) {
    deviceCodeFlowInstance = new DeviceCodeFlowManager();
  }
  return deviceCodeFlowInstance;
}
