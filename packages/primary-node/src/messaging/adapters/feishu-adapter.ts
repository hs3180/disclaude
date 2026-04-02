/**
 * Feishu Channel Adapter - Converts UMF to Feishu Card format.
 *
 * This adapter handles message conversion and sending for Feishu platform.
 * It converts Universal Message Format to Feishu's interactive card format.
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger, type UniversalMessage, type SendResult, type MessageContent, type CardContent, type CardSection, type CardAction } from '@disclaude/core';
import type {
  IChannelAdapter,
  ChannelCapabilities,
} from '../channel-adapter.js';

const logger = createLogger('FeishuAdapter');

/**
 * Feishu client provider interface for dependency injection.
 */
export interface FeishuClientProvider {
  /** Get the Lark client instance */
  getClient(): lark.Client;
}

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
 * Feishu Adapter options.
 */
export interface FeishuAdapterOptions {
  /** Optional client provider for dependency injection */
  clientProvider?: FeishuClientProvider;
}

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

  private clientProvider?: FeishuClientProvider;
  private client: lark.Client | null = null;

  constructor(options?: FeishuAdapterOptions) {
    this.clientProvider = options?.clientProvider;
  }

  /**
   * Set the client provider.
   */
  setClientProvider(provider: FeishuClientProvider): void {
    this.clientProvider = provider;
    this.client = null; // Reset cached client
  }

  /**
   * Get the Lark client.
   * Uses injected provider if available, otherwise requires setClient call.
   */
  private getClient(): lark.Client {
    if (this.clientProvider) {
      return this.clientProvider.getClient();
    }

    if (!this.client) {
      throw new Error('FeishuAdapter requires a client provider or client to be set. Use setClientProvider() or setClient().');
    }
    return this.client;
  }

  /**
   * Set the client directly (for backward compatibility).
   */
  setClient(client: lark.Client): void {
    this.client = client;
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
      case 'text': {
        // Issue #1742: When mentions are provided, use msg_type "post" (rich text)
        // to render @mentions. Plain text (msg_type "text") does not support @mentions.
        if (content.mentions && content.mentions.length > 0) {
          const postContent: Array<Array<Record<string, unknown>>> = [[]];
          let remainingText = content.text;

          for (const mention of content.mentions) {
            const mentionTag = `@${mention.name || mention.id}`;
            const idx = remainingText.indexOf(mentionTag);

            if (idx >= 0) {
              if (idx > 0) {
                postContent[0].push({ tag: 'text', text: remainingText.substring(0, idx) });
              }
              postContent[0].push({ tag: 'at', user_id: mention.id });
              remainingText = remainingText.substring(idx + mentionTag.length);
            } else {
              postContent[0].push({ tag: 'at', user_id: mention.id });
            }
          }

          if (remainingText) {
            postContent[0].push({ tag: 'text', text: remainingText });
          }

          return {
            msg_type: 'post',
            content: JSON.stringify({
              zh_cn: {
                title: '',
                content: postContent,
              },
            }),
          };
        }

        return {
          msg_type: 'text',
          content: JSON.stringify({ text: content.text }),
        };
      }

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

      case 'select': {
        const { label, options } = action;
        return {
          tag: 'select_static',
          placeholder: {
            tag: 'plain_text',
            content: label,
          },
          options: options?.map((opt) => {
            const { label: optLabel, value } = opt;
            return {
              text: {
                tag: 'plain_text',
                content: optLabel,
              },
              value,
            };
          }) || [],
        };
      }

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
