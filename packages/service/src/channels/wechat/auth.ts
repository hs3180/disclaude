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

const logger = createLogger('WeChatAuth');

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
 * Login flow stage for progress reporting (#5479): waiting for the QR scan,
 * scanned and awaiting confirmation, or confirmed with fresh credentials.
 * Credential submission and connection verification that follow belong to
 * the CLI's save path, not the auth flow.
 */
export type WeChatAuthStage = 'waiting-for-scan' | 'scanned' | 'confirmed';

/** Extra context for a stage event. */
export interface WeChatAuthStageDetail {
  /** A previous QR expired and this many-th replacement is displayed. */
  qrRefresh?: number;
  /** The remote asked for the private pairing digits. */
  needVerifyCode?: boolean;
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
    /** Caller renders/delivers the temporary QR without writing it to logs. */
    onQrCode?: (url: string) => Promise<void>;
    /** Pairing input belongs in a private terminal/card, never in chat or logs. */
    requestVerifyCode?: (signal: AbortSignal) => Promise<string>;
    /** Stage transitions for progress reporting (#5479). */
    onStage?: (stage: WeChatAuthStage, detail?: WeChatAuthStageDetail) => Promise<void> | void;
  }): Promise<AuthResult> {
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    const timeoutMs = Math.max(options?.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS, 1000);
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => this.abortController?.abort(), timeoutMs);
    let qrRefreshCount = 0;
    let scannedPrinted = false;
    let verifyCode: string | undefined;
    const display = options?.onQrCode ?? ((url: string) => this.logQrCode(url));
    const report = async (stage: WeChatAuthStage, detail?: WeChatAuthStageDetail) => { await options?.onStage?.(stage, detail); };

    try {
      // Step 1: Get initial QR code
      let qrData = await this.client.getBotQrCode({ signal });
      await display(qrData.qrUrl);
      await report('waiting-for-scan');

      // Step 2: Poll login status
      while (!signal.aborted && Date.now() < deadline) {
        try {
          const status = await this.client.getQrCodeStatus(qrData.qrcode, { signal, verifyCode });

          switch (status.status) {
            case 'wait':
              process.stdout.write('.');
              break;

            case 'scaned':
              verifyCode = undefined;
              if (!scannedPrinted) {
                process.stdout.write('\nQR code scanned, waiting for confirmation...\n');
                scannedPrinted = true;
                await report('scanned');
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

              qrData = await this.client.getBotQrCode({ signal });
              await display(qrData.qrUrl);
              scannedPrinted = false;
              await report('waiting-for-scan', { qrRefresh: qrRefreshCount });
              break;
            }

            case 'confirmed':
              if (!status.botId) {
                logger.error('Login confirmed but ilink_bot_id missing');
                return { success: false, error: 'Login confirmed but bot ID missing' };
              }
              if (!status.botToken?.trim()) { return { success: false, error: 'Login confirmed but bot token missing' }; }

              logger.info({ botId: status.botId, userId: status.userId }, 'Login confirmed!');
              process.stdout.write('\nLogin confirmed!\n');
              await report('confirmed');
              return {
                success: true,
                token: status.botToken,
                botId: status.botId,
                userId: status.userId,
                baseUrl: status.baseUrl,
              };

            case 'scaned_but_redirect':
              break; // The API client validates and applies the regional host.
            case 'need_verifycode':
              if (!options?.requestVerifyCode) { return { success: false, error: 'Private pairing input required; run disclaude wechat login in a terminal' }; }
              await report('scanned', { needVerifyCode: true });
              try { verifyCode = await options.requestVerifyCode(signal); }
              catch { return { success: false, error: 'Private pairing input unavailable; use an interactive terminal' }; }
              break;
            case 'verify_code_blocked':
              return { success: false, error: 'Pairing code blocked; start a new login later' };
            case 'binded_redirect':
              return { success: false, error: 'Account already bound; use the existing saved login' };

            default:
              logger.warn({ status: status.status }, 'Unknown QR code status');
          }
        } catch (error) {
          if (signal.aborted) { break; }
          // Network errors during polling should be retried
          logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            'Failed to poll QR code status, retrying...'
          );
        }

        // Wait before next poll
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(retryTimer); signal.removeEventListener('abort', done); resolve(); };
          const retryTimer = setTimeout(done, POLL_RETRY_DELAY_MS);
          signal.addEventListener('abort', done, { once: true });
        });
      }

      // Timeout
      if (signal.aborted && Date.now() < deadline) {
        return { success: false, error: 'Authentication aborted' };
      }
      return { success: false, error: 'Authentication timed out' };
    } catch {
      return { success: false, error: signal.aborted ? (Date.now() >= deadline ? 'Authentication timed out' : 'Authentication aborted') : 'Authentication request failed' };
    } finally {
      clearTimeout(timer);
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
  private logQrCode(qrUrl: string): Promise<void> {
    process.stdout.write(`\nScan this URL with WeChat: ${qrUrl}\n\n`);
    return Promise.resolve();
  }
}
