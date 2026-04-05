/**
 * Feishu Channel Adapter - Converts UMF to Feishu Card format.
 *
 * This adapter handles message conversion and sending for Feishu platform.
 * It converts Universal Message Format to Feishu's interactive card format.
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 * Issue #1619: File type support with proper upload and thread reply.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger, type UniversalMessage, type SendResult, type MessageContent, type FileContent, type CardContent, type CardSection, type CardAction } from '@disclaude/core';
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
        // File messages require async upload (handled in send()).
        // convert() is synchronous and cannot perform file uploads.
        throw new Error(
          'File content cannot be converted synchronously. ' +
          'Use send() directly for file messages, which handles upload via Feishu API.',
        );

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
   *
   * Issue #1619: File messages are handled with proper upload flow:
   * 1. Upload file/image via Feishu API to get file_key/image_key
   * 2. Send message with the key using create or reply (thread) API
   *
   * Thread reply support: when threadId is provided, messages are sent
   * as replies using client.im.message.reply() instead of create().
   */
  async send(message: UniversalMessage): Promise<SendResult> {
    try {
      const client = this.getClient();

      // Issue #1619: Handle file messages with proper upload flow.
      // File upload is async and cannot be done in convert().
      if (message.content.type === 'file') {
        return this.sendFileMessage(client, message);
      }

      const feishuMessage = this.convert(message) as {
        msg_type: string;
        content: string;
      };

      // Use thread reply if threadId is provided (Issue #1619)
      if (message.threadId) {
        const replyResp = await client.im.message.reply({
          path: {
            message_id: message.threadId,
          },
          data: {
            msg_type: feishuMessage.msg_type,
            content: feishuMessage.content,
          },
        });
        const messageId = replyResp.data?.message_id;
        logger.debug({ chatId: message.chatId, messageId, threadId: message.threadId }, 'Message sent as thread reply to Feishu');
        return { success: true, messageId };
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
   * Send a file message with proper upload flow.
   *
   * Issue #1619: Uploads the file to Feishu API first, then sends
   * the message with the obtained file_key or image_key.
   * Supports both image and document file types, with thread reply.
   *
   * @param client - Lark client instance
   * @param message - Universal message with file content
   * @returns Send result with messageId
   */
  private async sendFileMessage(client: lark.Client, message: UniversalMessage): Promise<SendResult> {
    const fileContent = message.content as FileContent;
    const filePath = fileContent.path;
    if (!filePath) {
      return { success: false, error: 'File path is required for file messages' };
    }

    const fileName = fileContent.name || path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    // Check file exists
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    const { size: fileSize } = fs.statSync(filePath);

    // Determine if image based on extension
    const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico']);
    const isImage = IMAGE_EXTENSIONS.has(ext);

    let msgType: string;
    let content: string;

    if (isImage) {
      // Upload image
      if (fileSize > 10 * 1024 * 1024) {
        return { success: false, error: `Image file too large: ${fileSize} bytes (max 10MB)` };
      }

      const uploadResp = await client.im.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(filePath),
        },
      });
      const imageKey = uploadResp?.image_key;
      if (!imageKey) {
        return { success: false, error: `Failed to upload image: ${fileName} (no image_key returned)` };
      }

      msgType = 'image';
      content = JSON.stringify({ image_key: imageKey });
    } else {
      // Upload file
      if (fileSize > 30 * 1024 * 1024) {
        return { success: false, error: `File too large: ${fileSize} bytes (max 30MB)` };
      }

      // Map file extension to Feishu file_type
      const extToType: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
        '.opus': 'opus',
        '.mp4': 'mp4',
        '.pdf': 'pdf',
        '.doc': 'doc', '.docx': 'doc',
        '.xls': 'xls', '.xlsx': 'xls', '.csv': 'xls',
        '.ppt': 'ppt', '.pptx': 'ppt',
      };
      const fileType = extToType[ext] || 'stream';

      const uploadResp = await client.im.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: fs.createReadStream(filePath),
        },
      });
      const fileKey = uploadResp?.file_key;
      if (!fileKey) {
        return { success: false, error: `Failed to upload file: ${fileName} (no file_key returned)` };
      }

      msgType = 'file';
      content = JSON.stringify({ file_key: fileKey });
    }

    // Send the message (thread reply or new message)
    let messageId: string | undefined;
    if (message.threadId) {
      const replyResp = await client.im.message.reply({
        path: { message_id: message.threadId },
        data: { msg_type: msgType, content },
      });
      messageId = replyResp.data?.message_id;
      logger.info({ chatId: message.chatId, messageId, threadId: message.threadId, fileName, isImage }, 'File sent as thread reply');
    } else {
      const createResp = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: message.chatId, msg_type: msgType, content },
      });
      messageId = createResp.data?.message_id;
      logger.info({ chatId: message.chatId, messageId, fileName, isImage }, 'File sent');
    }

    return { success: true, messageId };
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
