/**
 * WeChat QR Code Authentication Handler.
 *
 * Manages QR code login flow for WeChat ilink bot API.
 * MVP v1: Basic QR code login with polling.
 *
 * @module channels/wechat/auth
 */

import { EventEmitter } from 'events';
import { createLogger } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import type { AuthState, AuthCredentials, QRCodeEvent } from './types.js';

const logger = createLogger('WeChatAuthHandler');

/**
 * Default configuration values.
 */
const DEFAULTS = {
  LOGIN_TIMEOUT: 5 * 60 * 1000, // 5 minutes
  POLL_INTERVAL: 2000, // 2 seconds
} as const;

/**
 * WeChat QR code authentication handler.
 *
 * Handles the QR code login flow:
 * 1. Request QR code from API
 * 2. Emit 'qrcode' event with QR URL
 * 3. Poll for status changes
 * 4. Emit 'authenticated' or 'error' event
 *
 * @example
 * ```typescript
 * const auth = new WeChatAuthHandler(apiClient);
 * auth.on('qrcode', (event) => {
 *   console.log('Scan this QR code:', event.url);
 * });
 * auth.on('authenticated', (creds) => {
 *   console.log('Logged in!', creds.token);
 * });
 * await auth.startLogin();
 * ```
 */
export class WeChatAuthHandler extends EventEmitter {
  private readonly apiClient: WeChatApiClient;
  private readonly timeout: number;
  private readonly pollInterval: number;

  private state: AuthState = 'unauthenticated';
  private currentQRId?: string;
  private pollTimer?: ReturnType<typeof setInterval>;
  private credentials?: AuthCredentials;

  constructor(apiClient: WeChatApiClient, options?: { timeout?: number; pollInterval?: number }) {
    super();
    this.apiClient = apiClient;
    this.timeout = options?.timeout ?? DEFAULTS.LOGIN_TIMEOUT;
    this.pollInterval = options?.pollInterval ?? DEFAULTS.POLL_INTERVAL;
  }

  /**
   * Get current authentication state.
   */
  getState(): AuthState {
    return this.state;
  }

  /**
   * Get current credentials (if authenticated).
   */
  getCredentials(): AuthCredentials | undefined {
    return this.credentials;
  }

  /**
   * Check if authenticated.
   */
  isAuthenticated(): boolean {
    return this.state === 'authenticated' && !!this.credentials;
  }

  /**
   * Start QR code login flow.
   *
   * Emits:
   * - 'qrcode': QR code ready for scanning
   * - 'authenticated': Login successful
   * - 'error': Login failed
   */
  async startLogin(): Promise<void> {
    if (this.state === 'pending') {
      logger.warn('Login already in progress');
      return;
    }

    if (this.apiClient.isAuthenticated()) {
      logger.info('Already authenticated via config');
      this.state = 'authenticated';
      this.credentials = {
        token: this.apiClient.getToken()!,
        botId: '', // Bot ID should be provided in config
      };
      this.emit('authenticated', this.credentials);
      return;
    }

    logger.info('Starting QR code login');
    this.state = 'pending';

    try {
      // Step 1: Get QR code
      const qrResponse = await this.apiClient.getQRCode();
      this.currentQRId = qrResponse.qrid;

      // Emit QR code event
      const qrEvent: QRCodeEvent = {
        url: qrResponse.qrurl,
        id: qrResponse.qrid,
      };
      this.emit('qrcode', qrEvent);
      logger.info({ qrid: qrResponse.qrid }, 'QR code emitted');

      // Step 2: Start polling for status
      await this.startPolling();
    } catch (error) {
      logger.error({ err: error }, 'Failed to start login');
      this.state = 'error';
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Cancel ongoing login process.
   */
  cancelLogin(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.currentQRId = undefined;
    this.state = 'unauthenticated';
    logger.info('Login cancelled');
  }

  /**
   * Start polling for QR code status.
   */
  private async startPolling(): Promise<void> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      this.pollTimer = setInterval(async () => {
        // Check timeout
        if (Date.now() - startTime > this.timeout) {
          this.cancelLogin();
          const error = new Error('QR code login timeout');
          this.state = 'error';
          this.emit('error', error);
          reject(error);
          return;
        }

        // Poll status
        try {
          if (!this.currentQRId) {
            throw new Error('No QR code ID');
          }

          const status = await this.apiClient.getQRCodeStatus(this.currentQRId);
          logger.debug({ status: status.status }, 'QR status polled');

          switch (status.status) {
            case 'confirmed':
              // Login successful
              if (!status.bot_token || !status.ilink_bot_id) {
                throw new Error('Missing credentials in confirmed response');
              }
              this.onLoginSuccess(status.bot_token, status.ilink_bot_id);
              resolve();
              return;

            case 'expired':
            case 'canceled':
              // Login failed
              const error = new Error(`QR code ${status.status}`);
              this.state = 'error';
              this.emit('error', error);
              reject(error);
              return;

            case 'scaned':
              // User scanned, waiting for confirmation
              logger.info('QR code scanned, waiting for confirmation');
              break;

            case 'wait':
              // Still waiting for scan
              break;
          }
        } catch (error) {
          logger.error({ err: error }, 'Polling error');
          // Don't reject on transient errors, keep polling
        }
      }, this.pollInterval);
    });
  }

  /**
   * Handle successful login.
   */
  private onLoginSuccess(token: string, botId: string): void {
    // Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    // Update state
    this.apiClient.setToken(token);
    this.credentials = { token, botId };
    this.state = 'authenticated';
    this.currentQRId = undefined;

    logger.info({ botId }, 'Login successful');
    this.emit('authenticated', this.credentials);
  }
}
