/**
 * WeChat Authentication Module (MVP).
 *
 * Handles QR code-based bot authentication flow:
 * 1. Generate QR code URL via API
 * 2. Display QR code (terminal ASCII or log URL)
 * 3. Poll login status until confirmed or expired
 * 4. Return bot token on success
 *
 * Status flow: wait → scaned → confirmed | expired
 *
 * @module channels/wechat/auth
 * @see Issue #1473 - WeChat Channel MVP
 */

import { createLogger } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';

const logger = createLogger('WeChatAuth');

/** Default QR code polling interval in milliseconds. */
const QR_POLL_INTERVAL_MS = 3000;

/** Default QR code expiration time in seconds. */
const QR_EXPIRATION_S = 300;

/**
 * Authentication result.
 */
export interface AuthResult {
  /** Whether authentication was successful */
  success: boolean;
  /** Bot token (on success) */
  token?: string;
  /** Bot ID (on success) */
  botId?: string;
  /** User info who scanned the QR code (on success) */
  userInfo?: {
    name: string;
    id: string;
  };
  /** Error message (on failure) */
  error?: string;
}

/**
 * WeChat authentication handler.
 *
 * Manages the QR code login flow:
 * - Generates QR code for user to scan
 * - Polls status until login is confirmed or expires
 * - Returns auth token on success
 */
export class WeChatAuth {
  private readonly client: WeChatApiClient;
  private readonly pollInterval: number;
  private readonly expiration: number;
  private abortController?: AbortController;

  /**
   * Create a new authentication handler.
   *
   * @param client - WeChat API client
   * @param options - Authentication options
   */
  constructor(
    client: WeChatApiClient,
    options?: {
      /** Polling interval in ms (default: 3000) */
      pollInterval?: number;
      /** QR code expiration in seconds (default: 300) */
      expiration?: number;
    }
  ) {
    this.client = client;
    this.pollInterval = options?.pollInterval || QR_POLL_INTERVAL_MS;
    this.expiration = options?.expiration || QR_EXPIRATION_S;
  }

  /**
   * Start the QR code login flow.
   *
   * This will:
   * 1. Request a QR code URL from the API
   * 2. Log the URL for the user to scan
   * 3. Poll the login status until confirmed or expired
   *
   * @returns Authentication result with bot token
   */
  async authenticate(): Promise<AuthResult> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      // Step 1: Get QR code URL
      logger.info('Requesting QR code for WeChat bot login...');
      const qrUrl = await this.client.getBotQrCode();

      logger.info('========================================');
      logger.info('  WeChat Bot Login - Scan QR Code');
      logger.info('========================================');
      logger.info(`  QR Code URL: ${qrUrl}`);
      logger.info('  Please scan this QR code with WeChat.');
      logger.info('  Waiting for confirmation...');
      logger.info('========================================');

      // Step 2: Poll login status
      const startTime = Date.now();
      const expirationMs = this.expiration * 1000;

      while (!signal.aborted) {
        const elapsed = Date.now() - startTime;

        if (elapsed > expirationMs) {
          logger.warn('QR code expired');
          return { success: false, error: 'QR code expired' };
        }

        try {
          const status = await this.client.getQrCodeStatus();

          switch (status.status) {
            case 'wait':
              logger.debug('Waiting for QR code scan...');
              break;

            case 'scaned':
              logger.info('QR code scanned, waiting for confirmation...');
              break;

            case 'confirmed':
              logger.info({ botId: status.botId }, 'Login confirmed!');
              return {
                success: true,
                token: status.botToken,
                botId: status.botId,
                userInfo: status.userInfo,
              };

            case 'expired':
              logger.warn('QR code expired during polling');
              return { success: false, error: 'QR code expired' };

            default:
              logger.warn({ status: status.status }, 'Unknown QR code status');
          }
        } catch (error) {
          // Network errors during polling should be retried
          logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            'Failed to poll QR code status, retrying...'
          );
        }

        // Wait before next poll
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.pollInterval);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }

      // Aborted by caller
      return { success: false, error: 'Authentication aborted' };
    } finally {
      this.abortController = undefined;
    }
  }

  /**
   * Abort an in-progress authentication flow.
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      logger.info('Authentication aborted');
    }
  }

  /**
   * Check if authentication is currently in progress.
   */
  isAuthenticating(): boolean {
    return !!this.abortController && !this.abortController.signal.aborted;
  }
}
