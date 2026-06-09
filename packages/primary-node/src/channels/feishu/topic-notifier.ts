/**
 * Topic Group Notifier.
 *
 * Pushes Feishu topic group message notifications to the local machine.
 * Issue #4031: Real-time awareness of topic group activity.
 *
 * Supported backends:
 * - osascript: macOS native notifications
 * - webhook: HTTP POST to localhost
 *
 * @module primary-node/feishu/topic-notifier
 */

import { execFile } from 'node:child_process';
import { createLogger, type FeishuMessageEvent, type TopicGroupNotification, type TopicNotifyConfig } from '@disclaude/core';

const logger = createLogger('TopicNotifier');

/** Default configuration */
const DEFAULT_CONFIG: TopicNotifyConfig = {
  enabled: false,
  backends: ['osascript'],
};

/**
 * Extract plain text from Feishu message content JSON.
 */
function extractPlainText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed.text) {return parsed.text.slice(0, 200);}
    if (parsed.content) {
      const parts: string[] = [];
      for (const block of parsed.content) {
        for (const el of block) {
          if (el.text) {parts.push(el.text);}
          if (el.link) {parts.push(el.link);}
        }
      }
      return parts.join(' ').slice(0, 200);
    }
    return content.slice(0, 200);
  } catch {
    return content.slice(0, 200);
  }
}

/**
 * Send macOS native notification via osascript.
 */
function sendOsascriptNotification(notification: TopicGroupNotification): Promise<void> {
  const label = notification.is_reply ? '跟帖' : '新帖';
  const title = `话题群 ${label}`;
  const body = notification.content || '(无文本内容)';

  const script = `display notification "${body.replace(/"/g, '\\"')}" with title "${title}"`;

  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], (error) => {
      if (error) {
        logger.debug({ err: error }, 'osascript notification failed (may not be macOS)');
      }
      resolve();
    });
  });
}

/**
 * Send notification via HTTP webhook.
 */
async function sendWebhookNotification(
  url: string,
  notification: TopicGroupNotification,
): Promise<void> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notification),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Webhook notification returned non-OK status');
    }
  } catch (error) {
    logger.debug({ err: error }, 'Webhook notification failed');
  }
}

/**
 * Topic Group Notifier.
 *
 * Filters FeishuMessageEvent for topic group messages and pushes
 * structured notifications to configured backends.
 */
export class TopicNotifier {
  private config: TopicNotifyConfig;

  constructor(config?: Partial<TopicNotifyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a message event is from a topic group and should trigger notification.
   */
  shouldNotify(event: FeishuMessageEvent): boolean {
    if (!this.config.enabled) {return false;}

    const { message } = event;
    if (message.chat_type !== 'topic') {return false;}

    // If chatIds filter is set, only notify for listed chats
    if (this.config.chatIds?.length && !this.config.chatIds.includes(message.chat_id)) {
      return false;
    }

    return true;
  }

  /**
   * Build notification payload from a FeishuMessageEvent.
   */
  buildNotification(event: FeishuMessageEvent): TopicGroupNotification {
    const { message, sender } = event;
    const isReply = !!message.parent_id;

    return {
      type: 'topic_group_message',
      chat_id: message.chat_id,
      root_id: message.parent_id || message.message_id,
      thread_id: message.message_id,
      sender: {
        open_id: sender.sender_id?.open_id || '',
      },
      content: extractPlainText(message.content),
      is_reply: isReply,
      timestamp: message.create_time
        ? new Date(message.create_time).toISOString()
        : new Date().toISOString(),
    };
  }

  /**
   * Push notification to all configured backends.
   */
  async notify(event: FeishuMessageEvent): Promise<void> {
    if (!this.shouldNotify(event)) {return;}

    const notification = this.buildNotification(event);
    logger.info(
      { chatId: notification.chat_id, isReply: notification.is_reply },
      'Topic group notification',
    );

    const promises = this.config.backends.map(async (backend) => {
      switch (backend) {
        case 'osascript':
          await sendOsascriptNotification(notification);
          break;
        case 'webhook':
          if (this.config.webhookUrl) {
            await sendWebhookNotification(this.config.webhookUrl, notification);
          }
          break;
      }
    });

    await Promise.allSettled(promises);
  }
}
