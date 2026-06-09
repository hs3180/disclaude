/**
 * TopicNotifier — Pushes notifications for Feishu topic group messages.
 *
 * Issue #4031: Provides notification dispatch infrastructure for topic group
 * messages. Supports macOS native notifications (osascript) and HTTP webhook
 * backends.
 *
 * Usage:
 * ```typescript
 * const notifier = new TopicNotifier({ backend: 'osascript' });
 * await notifier.notify({
 *   chatId: 'oc_xxx',
 *   messageId: 'om_xxx',
 *   parentId: undefined,  // root post (no parent)
 *   senderName: '张三',
 *   content: '消息摘要...',
 *   chatType: 'topic',
 * });
 * ```
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { createLogger } from '@disclaude/core';

const logger = createLogger('TopicNotifier');

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for TopicNotifier.
 */
export interface TopicNotifierConfig {
  /** Notification backend(s) to use */
  backend?: 'osascript' | 'webhook' | 'both';
  /** HTTP webhook URL (required when backend is 'webhook' or 'both') */
  webhookUrl?: string;
}

/**
 * A topic group message event to notify about.
 */
export interface TopicMessageEvent {
  /** Chat ID of the topic group */
  chatId: string;
  /** Message ID */
  messageId: string;
  /** Parent message ID (undefined for root posts, set for replies) */
  parentId?: string;
  /** Sender display name */
  senderName?: string;
  /** Message content (plain text summary) */
  content: string;
  /** Chat type (should be 'topic') */
  chatType?: string;
}

/**
 * Structured notification payload.
 */
export interface NotificationPayload {
  type: 'topic_group_message';
  chat_id: string;
  message_id: string;
  root_id: string | null;
  thread_id: string;
  sender: {
    name: string;
  };
  content: string;
  is_reply: boolean;
  timestamp: string;
}

// ============================================================================
// TopicNotifier
// ============================================================================

/**
 * TopicNotifier — Dispatches notifications for topic group messages.
 *
 * Supported backends:
 * - **osascript**: macOS native notifications via `osascript -e 'display notification'`
 * - **webhook**: HTTP POST to a configurable URL
 *
 * The notifier is designed to be called from the Feishu event handler when
 * a message is received in a topic group chat. It filters by chat_type === 'topic'
 * and formats the notification payload.
 */
export class TopicNotifier {
  private readonly backend: 'osascript' | 'webhook' | 'both';
  private readonly webhookUrl?: string;

  constructor(config: TopicNotifierConfig = {}) {
    this.backend = config.backend ?? 'osascript';
    this.webhookUrl = config.webhookUrl;

    if ((this.backend === 'webhook' || this.backend === 'both') && !this.webhookUrl) {
      logger.warn('webhook backend selected but no webhookUrl configured — webhook dispatch will be skipped');
    }
  }

  /**
   * Check if a message event should generate a notification.
   * Only topic group messages qualify.
   */
  shouldNotify(event: TopicMessageEvent): boolean {
    return event.chatType === 'topic';
  }

  /**
   * Build a structured notification payload from a message event.
   */
  buildPayload(event: TopicMessageEvent): NotificationPayload {
    const isReply = event.parentId !== undefined && event.parentId !== null && event.parentId !== '';
    return {
      type: 'topic_group_message',
      chat_id: event.chatId,
      message_id: event.messageId,
      root_id: isReply ? event.parentId ?? null : null,
      thread_id: event.messageId,
      sender: {
        name: event.senderName ?? 'Unknown',
      },
      content: this.truncateContent(event.content, 200),
      is_reply: isReply,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Dispatch a notification for a topic group message.
   * Sends via the configured backend(s).
   */
  async notify(event: TopicMessageEvent): Promise<void> {
    if (event.chatType !== 'topic') {
      return;
    }

    const payload = this.buildPayload(event);
    const errors: Error[] = [];

    if (this.backend === 'osascript' || this.backend === 'both') {
      try {
        await this.sendOsascriptNotification(payload);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    if (this.backend === 'webhook' || this.backend === 'both') {
      try {
        await this.sendWebhookNotification(payload);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    if (errors.length > 0) {
      logger.error({ errors: errors.map(e => e.message) }, 'Topic notification dispatch had errors');
    }
  }

  /**
   * Send a macOS native notification via osascript.
   */
  async sendOsascriptNotification(payload: NotificationPayload): Promise<void> {
    const title = payload.is_reply
      ? `话题群回复 - ${payload.sender.name}`
      : `话题群新帖 - ${payload.sender.name}`;
    const subtitle = payload.is_reply ? '回复帖子' : '';
    const text = this.escapeOsascript(payload.content);

    const script = subtitle
      ? `display notification "${text}" with title "${this.escapeOsascript(title)}" subtitle "${this.escapeOsascript(subtitle)}"`
      : `display notification "${text}" with title "${this.escapeOsascript(title)}"`;

    try {
      await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
      logger.debug({ title }, 'macOS notification sent');
    } catch (error) {
      // osascript may fail on non-macOS or in headless environments
      logger.debug({ err: error }, 'osascript notification failed (non-fatal, expected on Linux)');
    }
  }

  /**
   * Send a notification via HTTP webhook.
   */
  async sendWebhookNotification(payload: NotificationPayload): Promise<void> {
    if (this.webhookUrl === undefined || this.webhookUrl === null || this.webhookUrl === '') {
      logger.warn('Webhook URL not configured, skipping webhook notification');
      return;
    }

    const body = JSON.stringify(payload);
    const url = new URL(this.webhookUrl);
    const isHttps = url.protocol === 'https:';
    const requestFn = isHttps ? httpsRequest : httpRequest;

    await new Promise<void>((resolve, reject) => {
      const req = requestFn(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 5000,
        },
        (res) => {
          // Consume response body to free the connection
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            logger.debug({ statusCode: res.statusCode }, 'Webhook notification sent');
            resolve();
          } else {
            reject(new Error(`Webhook returned status ${res.statusCode}`));
          }
        },
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Webhook request timed out'));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Escape a string for safe use in osascript double-quoted strings.
   */
  private escapeOsascript(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, ' ')
      .substring(0, 200);
  }

  /**
   * Truncate content to a maximum length.
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }
    return `${content.substring(0, maxLength - 3)  }...`;
  }
}
