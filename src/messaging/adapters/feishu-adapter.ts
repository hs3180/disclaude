/**
 * Feishu Channel Adapter - Converts UMF to Feishu Card format.
 *
 * This adapter handles message conversion and sending for Feishu platform.
 * It converts Universal Message Format to Feishu's interactive card format.
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { getLarkClientService, isLarkClientServiceInitialized } from '../../services/index.js';
import type {
  IChannelAdapter,
  ChannelCapabilities,
} from '../channel-adapter.js';
import type {
  UniversalMessage,
  SendResult,
  MessageContent,
  CardContent,
  CardSection,
  CardAction,
} from '../universal-message.js';

const logger = createLogger('FeishuAdapter');

/**
 * Feishu card theme colors mapping.
 */
const THEME_MAP: Record<string, string> = {
  blue: 'blue',
  wathet: 'wathet',
  turquoise: 'turquoise',
  green: 'green',
  yellow: 'yellow',
  orange: 'orange',
  red: 'red',
  carmine: 'carmine',
  violet: 'violet',
  purple: 'purple',
  indigo: 'indigo',
  grey: 'grey',
};

/**
 * Feishu Adapter - Converts UMF to Feishu format and sends via API.
 */
export class FeishuAdapter implements IChannelAdapter {
  readonly name = 'feishu';
  readonly capabilities: ChannelCapabilities = {
    supportsCard: true,
    supportsThread: true,
    supportsFile: true,
    supportsMarkdown: true,
    maxMessageLength: 30000,
    supportedContentTypes: ['text', 'markdown', 'card', 'file'],
    supportsUpdate: true,
    supportsDelete: true,
    supportsMention: true,
    supportsReactions: true,
  };

  private client: lark.Client | null = null;

  /**
   * Get or create the Lark client.
   * Issue #1034: Prefer unified LarkClientService if available.
   */
  private getClient(): lark.Client {
    // Prefer unified LarkClientService if initialized
    if (isLarkClientServiceInitialized()) {
      return getLarkClientService().getClient();
    }

    // Fallback to creating client directly (for backward compatibility)
    if (!this.client) {
      const appId = Config.FEISHU_APP_ID;
      const appSecret = Config.FEISHU_APP_SECRET;
      if (!appId || !appSecret) {
        throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be configured');
      }
      // Dynamic import to avoid circular dependency
      const { createFeishuClient } = require('../../platforms/feishu/create-feishu-client.js');
      this.client = createFeishuClient(appId, appSecret, {
        domain: lark.Domain.Feishu,
      });
    }
    // Client is guaranteed to be initialized at this point
    return this.client!;
  }

  /**
   * Check if this adapter can handle the given chatId.
   * Feishu chat IDs start with: oc_ (group), ou_ (user), on_ (bot)
   */
  canHandle(chatId: string): boolean {
    return /^(oc_|ou_|on_)/.test(chatId);
  }

  /**
   * Convert Universal Message to Feishu format.
   */
  convert(message: UniversalMessage): unknown {
    const { content } = message;

    switch (content.type) {
      case 'text':
        return {
          msg_type: 'text',
          content: JSON.stringify({ text: content.text }),
        };

      case 'markdown':
        return {
          msg_type: 'interactive',
          content: JSON.stringify(this.markdownToCard(content.text)),
        };

      case 'card':
        return {
          msg_type: 'interactive',
          content: JSON.stringify(this.convertCard(content)),
        };

      case 'file':
        return {
          msg_type: 'file',
          content: JSON.stringify({ file_path: content.path }),
        };

      case 'done':
        return {
          msg_type: 'text',
          content: JSON.stringify({
            text: content.success
              ? `✅ ${content.message || 'Task completed'}`
              : `❌ ${content.error || 'Task failed'}`,
          }),
        };

      default:
        throw new Error(`Unsupported content type: ${(content as MessageContent).type}`);
    }
  }

  /**
   * Convert UMF Card to Feishu Card format.
   */
  private convertCard(card: CardContent): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [];

    // Convert sections to Feishu elements
    for (const section of card.sections) {
      const element = this.convertSection(section);
      if (element) {
        elements.push(element);
      }
    }

    // Convert actions to Feishu actions
    let actions: Record<string, unknown>[] | undefined;
    if (card.actions && card.actions.length > 0) {
      actions = card.actions.map((action) => this.convertAction(action));
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
        template: THEME_MAP[card.theme || 'blue'] || 'blue',
        ...(card.subtitle && {
          subtitle: {
            tag: 'plain_text',
            content: card.subtitle,
          },
        }),
      },
      elements,
      ...(actions && actions.length > 0 && { card_link: actions[0] }),
    };
  }

  /**
   * Convert UMF section to Feishu element.
   */
  private convertSection(section: CardSection): Record<string, unknown> | null {
    switch (section.type) {
      case 'text':
        return {
          tag: 'div',
          text: {
            tag: 'plain_text',
            content: section.content || '',
          },
        };

      case 'markdown':
        return {
          tag: 'markdown',
          content: section.content || '',
        };

      case 'divider':
        return { tag: 'hr' };

      case 'fields':
        if (!section.fields || section.fields.length === 0) {
          return null;
        }
        return {
          tag: 'div',
          fields: section.fields.map((field) => ({
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**${field.label}**\n${field.value}`,
            },
          })),
        };

      case 'image':
        return {
          tag: 'img',
          img_key: section.imageUrl || '',
          alt: {
            tag: 'plain_text',
            content: 'Image',
          },
        };

      default:
        return null;
    }
  }

  /**
   * Convert UMF action to Feishu action.
   */
  private convertAction(action: CardAction): Record<string, unknown> {
    switch (action.type) {
      case 'button':
        return {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: action.label,
          },
          value: { action: action.value },
          type: {
            primary: 'primary',
            secondary: 'default',
            danger: 'danger',
          }[action.style || 'primary'] || 'primary',
        };

      case 'select':
        return {
          tag: 'select_static',
          placeholder: {
            tag: 'plain_text',
            content: action.label,
          },
          options: action.options?.map((opt) => ({
            text: {
              tag: 'plain_text',
              content: opt.label,
            },
            value: opt.value,
          })) || [],
        };

      case 'link':
        return {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: action.label,
              },
              url: action.url || '',
              type: 'primary',
            },
          ],
        };

      default:
        return {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: action.label,
          },
          value: { action: action.value },
        };
    }
  }

  /**
   * Convert markdown to a simple Feishu card.
   */
  private markdownToCard(text: string): Record<string, unknown> {
    return {
      config: {
        wide_screen_mode: true,
      },
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    };
  }

  /**
   * Send a message through Feishu API.
   */
  async send(message: UniversalMessage): Promise<SendResult> {
    try {
      const client = this.getClient();
      const feishuMessage = this.convert(message) as {
        msg_type: string;
        content: string;
      };

      // Use thread reply if threadId is provided
      if (message.threadId) {
        await client.im.message.reply({
          path: {
            message_id: message.threadId,
          },
          data: {
            msg_type: feishuMessage.msg_type,
            content: feishuMessage.content,
          },
        });
      } else {
        const response = await client.im.message.create({
          params: {
            receive_id_type: 'chat_id',
          },
          data: {
            receive_id: message.chatId,
            msg_type: feishuMessage.msg_type,
            content: feishuMessage.content,
          },
        });

        const messageId = response.data?.message_id;
        logger.debug({ chatId: message.chatId, messageId }, 'Message sent to Feishu');

        return {
          success: true,
          messageId,
        };
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, chatId: message.chatId }, 'Failed to send message to Feishu');
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Update an existing message.
   */
  async update(messageId: string, message: UniversalMessage): Promise<SendResult> {
    try {
      const client = this.getClient();
      const feishuMessage = this.convert(message) as {
        msg_type: string;
        content: string;
      };

      // Only cards can be updated
      if (message.content.type !== 'card') {
        return {
          success: false,
          error: 'Only card messages can be updated',
        };
      }

      await client.im.message.patch({
        path: {
          message_id: messageId,
        },
        data: {
          content: feishuMessage.content,
        },
      });

      logger.debug({ messageId }, 'Message updated in Feishu');
      return { success: true, messageId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, messageId }, 'Failed to update message in Feishu');
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}

/**
 * Create a new Feishu adapter instance.
 */
export function createFeishuAdapter(): FeishuAdapter {
  return new FeishuAdapter();
}
