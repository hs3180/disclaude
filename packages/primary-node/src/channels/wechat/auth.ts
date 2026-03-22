/**
 * WeChat Authentication Handler.
 *
 * Handles QR code login flow for WeChat bot authentication.
 *
 * @module channels/wechat/auth
 */

import { createLogger } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';

const logger = createLogger('WeChatAuth');

/**
 * Authentication state.
 */
export type AuthState = 'unauthenticated' | 'pending' | 'authenticated' | 'error';

/**
 * Auth state change callback.
 */
export type AuthStateCallback = (state: AuthState, token?: string, botId?: string) => void;

/**
 * QR code display callback.
 */
export type QRCodeCallback = (qrCodeUrl: string) => void;

/**
 * Default QR code check interval in milliseconds.
 */
const DEFAULT_CHECK_INTERVAL = 2000;

/**
 * Default QR code timeout in milliseconds (5 minutes).
 */
const DEFAULT_QR_TIMEOUT = 5 * 60 * 1000;

/**
 * WeChat authentication handler.
 *
 * Manages QR code login flow:
 * 1. Request QR code from API
 * 2. Display QR code to user
 * 3. Poll for scan status
 * 4. Handle login success/failure
 */
export class WeChatAuthHandler {
  private readonly client: WeChatApiClient;
  private state: AuthState = 'unauthenticated';
  private stateCallback?: AuthStateCallback;
  private qrCodeCallback?: QRCodeCallback;
  private checkInterval: number;
  private qrTimeout: number;
  private pollTimer?: ReturnType<typeof setInterval>;
  private qrcodeId?: string;

  constructor(
    client: WeChatApiClient,
    options: {
      checkInterval?: number;
      qrTimeout?: number;
    } = {}
  ) {
    this.client = client;
    this.checkInterval = options.checkInterval ?? DEFAULT_CHECK_INTERVAL;
    this.qrTimeout = options.qrTimeout ?? DEFAULT_QR_TIMEOUT;
  }

  /**
   * Get current authentication state.
   */
  getState(): AuthState {
    return this.state;
  }

  /**
   * Set callback for auth state changes.
   */
  onStateChange(callback: AuthStateCallback): void {
    this.stateCallback = callback;
  }

  /**
   * Set callback for QR code display.
   */
  onQRCode(callback: QRCodeCallback): void {
    this.qrCodeCallback = callback;
  }

  /**
   * Update state and notify callback.
   */
  private setState(state: AuthState, token?: string, botId?: string): void {
    const oldState = this.state;
    this.state = state;
    logger.info({ oldState, newState: state }, 'Auth state changed');
    this.stateCallback?.(state, token, botId);
  }

  /**
   * Start QR code login flow.
   */
  async startLogin(): Promise<void> {
    if (this.state === 'pending') {
      logger.warn('Login already in progress');
      return;
    }

    logger.info('Starting QR code login');
    this.setState('pending');

    try {
      // Request QR code
      const response = await this.client.getQRCode();

      if (!response.success) {
        logger.error({ error: response.error }, 'Failed to get QR code');
        this.setState('error');
        return;
      }

      const { qrcode_url, qrcode_id } = response.data;
      this.qrcodeId = qrcode_id;

      // Display QR code
      logger.info({ qrcodeId: this.qrcodeId }, 'QR code generated');
      this.qrCodeCallback?.(qrcode_url);

      // Start polling for status
      this.startStatusPolling();
    } catch (err) {
      logger.error({ err }, 'Error starting login');
      this.setState('error');
    }
  }

  /**
   * Start polling for QR code scan status.
   */
  private startStatusPolling(): void {
    this.stopPolling();

    const startTime = Date.now();

    this.pollTimer = setInterval(async () => {
      // Check for timeout
      if (Date.now() - startTime > this.qrTimeout) {
        logger.warn('QR code timed out');
        this.stopPolling();
        this.setState('error');
        return;
      }

      // Check status
      if (!this.qrcodeId) {
        return;
      }

      try {
        const response = await this.client.getQRCodeStatus(this.qrcodeId);

        if (!response.success) {
          logger.warn({ error: response.error }, 'Failed to check QR status');
          return;
        }

        const { status, bot_token, ilink_bot_id } = response.data;

        switch (status) {
          case 'confirmed':
            logger.info('QR code confirmed, login successful');
            this.stopPolling();
            if (bot_token && ilink_bot_id) {
              this.client.setCredentials(bot_token, ilink_bot_id);
              this.setState('authenticated', bot_token, ilink_bot_id);
            } else {
              logger.error('Missing credentials in confirmed response');
              this.setState('error');
            }
            break;

          case 'expired':
            logger.warn('QR code expired');
            this.stopPolling();
            this.setState('error');
            break;

          case 'canceled':
            logger.info('QR code scan canceled');
            this.stopPolling();
            this.setState('error');
            break;

          case 'scaned':
            logger.debug('QR code scanned, waiting for confirmation');
            // Continue polling
            break;

          case 'wait':
          default:
            // Continue polling
            break;
        }
      } catch (err) {
        logger.error({ err }, 'Error checking QR status');
      }
    }, this.checkInterval);
  }

  /**
   * Stop status polling.
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Cancel login flow.
   */
  cancelLogin(): void {
    logger.info('Canceling login');
    this.stopPolling();
    this.qrcodeId = undefined;
    this.setState('unauthenticated');
  }

  /**
   * Check if already authenticated.
   */
  checkAuthentication(): boolean {
    return this.client.isAuthenticated();
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    this.stopPolling();
    this.qrcodeId = undefined;
    this.stateCallback = undefined;
    this.qrCodeCallback = undefined;
  }
}
