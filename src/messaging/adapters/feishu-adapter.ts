/**
 * Feishu Channel Adapter - Convert UMF to Feishu message format.
 *
 * Converts UniversalMessage to Feishu-specific formats:
 * - Text → Feishu text message
 * - Card → Feishu interactive card
 * - File → Feishu file message
 *
 * Handles chatIds starting with "oc_", "ou_", "on_".
 *
 * @see Issue #480
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { BaseChannelAdapter, type SendResult } from '../channel-adapter.js';
import {
  FEISHU_CAPABILITIES,
  type UniversalMessage,
  type CardContent,
  type CardSection,
  type CardAction,
  isTextContent,
  isMarkdownContent,
  isCardContent,
  isFileContent,
  isDoneContent,
} from '../universal-message.js';

const logger = createLogger('FeishuAdapter');

/**
 * Theme color mapping.
 */
const THEME_MAP: Record<string, string> = {
  default: 'blue',
  blue: 'blue',
  green: 'green',
  red: 'red',
  orange: 'orange',
  purple: 'purple',
};

/**
 * Feishu Channel Adapter.
 * Converts UMF to Feishu message format and sends via Lark SDK.
 */
export class FeishuAdapter extends BaseChannelAdapter {
  readonly id = 'feishu';
  readonly name = 'Feishu Adapter';
  readonly capabilities = FEISHU_CAPABILITIES;

  private client: lark.Client | null = null;

  /**
   * Handle Feishu chat IDs (oc_*, ou_*, on_*).
   */
  canHandle(chatId: string): boolean {
    return (
      chatId.startsWith('oc_') ||
      chatId.startsWith('ou_') ||
      chatId.startsWith('on_')
    );
  }

  /**
   * Get or create Lark client.
   */
  private getClient(): lark.Client {
    if (!this.client) {
      const appId = Config.FEISHU_APP_ID;
      const appSecret = Config.FEISHU_APP_SECRET;

      if (!appId || !appSecret) {
        throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be configured');
      }

      this.client = new lark.Client({
        appId,
        appSecret,
        domain: lark.Domain.Feishu,
      });
    }
    return this.client;
  }

  /**
   * Convert to Feishu message format.
   */
  convert(message: UniversalMessage): { msgType: string; content: string } {
    const { content } = message;

    if (isTextContent(content)) {
      return {
        msgType: 'text',
        content: JSON.stringify({ text: content.text }),
      };
    }

    if (isMarkdownContent(content)) {
      // Feishu uses "post" type for markdown
      return {
        msgType: 'post',
        content: JSON.stringify({
          zh_cn: {
            title: '',
            content: this.markdownToFeishuPost(content.text),
          },
        }),
      };
    }

    if (isCardContent(content)) {
      return {
        msgType: 'interactive',
        content: JSON.stringify(this.convertCard(content)),
      };
    }

    if (isFileContent(content)) {
      return {
        msgType: 'file',
        content: JSON.stringify({ file_key: content.filePath }),
      };
    }

    if (isDoneContent(content)) {
      const text = content.success ? '✅ Task completed' : `❌ Task failed: ${content.error}`;
      return {
        msgType: 'text',
        content: JSON.stringify({ text }),
      };
    }

    // Fallback to JSON
    return {
      msgType: 'text',
      content: JSON.stringify({ text: JSON.stringify(content, null, 2) }),
    };
  }

  /**
   * Send message to Feishu.
   */
  async send(message: UniversalMessage): Promise<SendResult> {
    const { chatId, threadId } = message;

    try {
      const client = this.getClient();
      const { msgType, content } = this.convert(message);

      let response;
      let messageId: string;

      if (threadId) {
        // Reply to thread
        response = await client.im.message.reply({
          path: {
            message_id: threadId,
          },
          data: {
            msg_type: msgType,
            content,
          },
        });
        messageId = response.data?.message_id ?? `reply-${Date.now()}`;
      } else {
        // New message
        response = await client.im.message.create({
          params: {
            receive_id_type: 'chat_id',
          },
          data: {
            receive_id: chatId,
            msg_type: msgType,
            content,
          },
        });
        messageId = response.data?.message_id ?? `msg-${Date.now()}`;
      }

      logger.debug({
        chatId,
        msgType,
        hasThreadId: !!threadId,
        messageId,
      }, 'Feishu message sent');

      return this.successResult(messageId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, chatId }, 'Feishu send failed');
      return this.errorResult(errorMessage);
    }
  }

  /**
   * Update an existing message.
   */
  async update(messageId: string, content: UniversalMessage['content']): Promise<SendResult> {
    try {
      const client = this.getClient();

      if (isCardContent(content)) {
        await client.im.message.patch({
          path: {
            message_id: messageId,
          },
          data: {
            content: JSON.stringify(this.convertCard(content)),
          },
        });

        return this.successResult(messageId);
      }

      return this.errorResult('Only card messages can be updated');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, messageId }, 'Feishu update failed');
      return this.errorResult(errorMessage);
    }
  }

  /**
   * Convert UMF Card to Feishu Card format.
   */
  private convertCard(card: CardContent): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [];

    for (const section of card.sections) {
      elements.push(this.convertSection(section));
    }

    return {
      config: {
        wide_screen_mode: true,
      },
      header: {
        title: {
          tag: 'plain_text',
          content: card.title,
        },
        subtitle: card.subtitle
          ? { tag: 'plain_text', content: card.subtitle }
          : undefined,
        template: THEME_MAP[card.theme ?? 'default'] ?? 'blue',
      },
      elements,
    };
  }

  /**
   * Convert UMF CardSection to Feishu element.
   */
  private convertSection(section: CardSection): Record<string, unknown> {
    switch (section.type) {
      case 'text':
        return {
          tag: 'div',
          text: {
            tag: 'plain_text',
            content: section.content ?? '',
          },
        };

      case 'markdown':
        return {
          tag: 'markdown',
          content: section.content ?? '',
        };

      case 'divider':
        return { tag: 'hr' };

      case 'actions':
        return {
          tag: 'action',
          actions: section.actions?.map(this.convertAction) ?? [],
        };

      case 'columns':
        return {
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'default',
          columns:
            section.columns?.map((col) => ({
              tag: 'column',
              width: col.weight ? 'weighted' : 'auto',
              weight: col.weight,
              elements: col.sections.map(this.convertSection.bind(this)),
            })) ?? [],
        };

      case 'image':
        return {
          tag: 'img',
          img_key: section.imageUrl,
          alt: { tag: 'plain_text', content: section.imageAlt ?? '' },
        };

      default:
        return {
          tag: 'div',
          text: {
            tag: 'plain_text',
            content: JSON.stringify(section),
          },
        };
    }
  }

  /**
   * Convert UMF CardAction to Feishu action.
   */
  private convertAction(action: CardAction): Record<string, unknown> {
    switch (action.type) {
      case 'button':
        return {
          tag: 'button',
          text: { tag: 'plain_text', content: action.label },
          type: action.style === 'primary' ? 'primary' : action.style === 'danger' ? 'danger' : 'default',
          value: { action: action.value },
        };

      case 'select':
        return {
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: action.label },
          options:
            action.options?.map((opt) => ({
              text: { tag: 'plain_text', content: opt.label },
              value: opt.value,
            })) ?? [],
        };

      case 'link':
        return {
          tag: 'action',
          text: { tag: 'plain_text', content: action.label },
          url: action.url,
          type: 'primary',
        };

      default:
        return {
          tag: 'button',
          text: { tag: 'plain_text', content: action.label },
          value: { action: action.value },
        };
    }
  }

  /**
   * Convert markdown to Feishu post format.
   * Note: This is a simplified conversion.
   */
  private markdownToFeishuPost(markdown: string): unknown[][] {
    // Simplified: split by newlines and wrap in paragraph tags
    const lines = markdown.split('\n');
    return lines.map((line) => [
      {
        tag: 'text',
        text: line,
      },
    ]);
  }
}

/**
 * Factory function to create Feishu adapter.
 */
export function createFeishuAdapter(): FeishuAdapter {
  return new FeishuAdapter();
}
