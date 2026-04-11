/**
 * WeChat Authentication Module (MVP).
 *
 * Handles QR code-based bot authentication flow based on the official
 * @tencent-weixin/openclaw-weixin implementation:
 *
 * 1. Generate QR code URL via GET /ilink/bot/get_bot_qrcode?bot_type=3
 * 2. Display QR code for user to scan
 * 3. Long-poll GET /ilink/bot/get_qrcode_status?qrcode=xxx (35s timeout)
 * 4. On timeout → treat as 'wait' and retry
 * 5. On 'expired' → refresh QR code (up to MAX_QR_REFRESH_COUNT times)
 * 6. On 'confirmed' → return bot token
 *
 * @module channels/wechat/auth
 * @see Issue #1473 - WeChat Channel MVP
 */

import { createLogger } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import QRCode from 'qrcode';
import { execSync } from 'node:child_process';

const logger = createLogger('WeChatAuth');

/** Path to save QR code PNG image. */
const QR_IMAGE_PATH = '/tmp/weixin-login-qrcode.png';

/** Max number of times to auto-refresh expired QR code. */
const MAX_QR_REFRESH_COUNT = 3;

/** Default timeout for the entire auth flow (milliseconds). */
const DEFAULT_AUTH_TIMEOUT_MS = 480_000; // 8 minutes

/** Delay between poll retries (milliseconds). */
const POLL_RETRY_DELAY_MS = 1_000;

/**
 * Authentication result.
 */
export interface AuthResult {
  /** Whether authentication was successful */
  success: boolean;
  /** Bot token (on success) */
  token?: string;
  /** Bot ID (ilink_bot_id, on success) */
  botId?: string;
  /** User ID of the person who scanned the QR code (on success) */
  userId?: string;
  /** Base URL returned by the server (on success) */
  baseUrl?: string;
  /** Error message (on failure) */
  error?: string;
}

/**
 * WeChat authentication handler.
 *
 * Manages the QR code login flow:
 * - Generates QR code for user to scan
 * - Long-polls status until login is confirmed or expires
 * - Auto-refreshes expired QR codes
 * - Returns auth token on success
 */
export class WeChatAuth {
  private readonly client: WeChatApiClient;
  private abortController?: AbortController;

  /**
   * Create a new authentication handler.
   *
   * @param client - WeChat API client
   */
  constructor(client: WeChatApiClient) {
    this.client = client;
  }

  /**
   * Start the QR code login flow.
   *
   * This will:
   * 1. Request a QR code URL from the API
   * 2. Log the URL for the user to scan
   * 3. Long-poll the login status until confirmed or timed out
   * 4. Auto-refresh expired QR codes (up to 3 times)
   *
   * @param options - Authentication options
   * @returns Authentication result with bot token
   */
  async authenticate(options?: {
    /** Total auth timeout in ms (default: 480000 / 8 minutes) */
    timeoutMs?: number;
  }): Promise<AuthResult> {
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    const timeoutMs = Math.max(options?.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS, 1000);
    const deadline = Date.now() + timeoutMs;
    let qrRefreshCount = 0;
    let scannedPrinted = false;

    try {
      // Step 1: Get initial QR code
      let qrData = await this.client.getBotQrCode();
      await this.logQrCode(qrData.qrUrl);

      // Step 2: Poll login status
      while (!signal.aborted && Date.now() < deadline) {
        try {
          const status = await this.client.getQrCodeStatus(qrData.qrcode);

          switch (status.status) {
            case 'wait':
              process.stdout.write('.');
              break;

            case 'scaned':
              if (!scannedPrinted) {
                process.stdout.write('\nQR code scanned, waiting for confirmation...\n');
                scannedPrinted = true;
              }
              break;

            case 'expired': {
              qrRefreshCount++;
              if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
                logger.warn('QR code expired too many times, giving up');
                return { success: false, error: 'QR code expired too many times' };
              }

              process.stdout.write(`\nQR code expired, refreshing... (${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
              logger.info(`QR expired, refreshing (${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})`);

              qrData = await this.client.getBotQrCode();
              await this.logQrCode(qrData.qrUrl);
              scannedPrinted = false;
              break;
            }

            case 'confirmed':
              if (!status.botId) {
                logger.error('Login confirmed but ilink_bot_id missing');
                return { success: false, error: 'Login confirmed but bot ID missing' };
              }

              logger.info({ botId: status.botId, userId: status.userId }, 'Login confirmed!');
              process.stdout.write('\nLogin confirmed!\n');
              return {
                success: true,
                token: status.botToken,
                botId: status.botId,
                userId: status.userId,
                baseUrl: status.baseUrl,
              };

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
          const timer = setTimeout(resolve, POLL_RETRY_DELAY_MS);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }

      // Timeout
      if (signal.aborted) {
        return { success: false, error: 'Authentication aborted' };
      }
      return { success: false, error: 'Authentication timed out' };
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

  /**
   * Render QR code as PNG image and open it.
   * Awaits file creation before attempting to open — avoids race condition
   * where `open` runs before the async QR image write completes.
   */
  private async logQrCode(qrUrl: string): Promise<void> {
    try {
      await QRCode.toFile(QR_IMAGE_PATH, qrUrl, {
        width: 400,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      execSync(`open "${QR_IMAGE_PATH}"`);
      process.stdout.write(`\nQR code image: ${QR_IMAGE_PATH}\n`);
      process.stdout.write(`URL: ${qrUrl}\n`);
      process.stdout.write('Please scan the QR code with WeChat.\n\n');
    } catch {
      // Fallback to URL if image generation fails
      process.stdout.write(`\nScan this URL with WeChat: ${qrUrl}\n\n`);
    }
  }
}
