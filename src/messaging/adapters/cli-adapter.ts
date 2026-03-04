/**
 * CLI Channel Adapter - Converts UMF to console output.
 *
 * This adapter handles message conversion and output for CLI mode.
 * It converts Universal Message Format to human-readable text for console.
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 */

import { createLogger } from '../../utils/logger.js';
import { cardToText, type IChannelAdapter, type ChannelCapabilities } from '../channel-adapter.js';
import type { UniversalMessage, SendResult, MessageContent } from '../universal-message.js';

const logger = createLogger('CliAdapter');

/**
 * CLI Adapter - Converts UMF to text and outputs to console.
 */
export class CliAdapter implements IChannelAdapter {
  readonly name = 'cli';
  readonly capabilities: ChannelCapabilities = {
    supportsCard: false,
    supportsThread: false,
    supportsFile: false,
    supportsMarkdown: true,
    maxMessageLength: Infinity,
    supportedContentTypes: ['text', 'markdown', 'done'],
    supportsUpdate: false,
    supportsDelete: false,
    supportsMention: false,
    supportsReactions: false,
  };

  /**
   * Check if this adapter can handle the given chatId.
   * CLI chat IDs start with "cli-".
   */
  canHandle(chatId: string): boolean {
    return chatId.startsWith('cli-');
  }

  /**
   * Convert Universal Message to CLI text format.
   */
  convert(message: UniversalMessage): string {
    const { content } = message;
    const prefix = `[${message.chatId}]`;

    switch (content.type) {
      case 'text':
        return `${prefix} ${content.text}`;

      case 'markdown':
        return `${prefix}\n${content.text}`;

      case 'card':
        // Convert card to text representation
        const cardText = cardToText(content);
        return `${prefix}\n${cardText}`;

      case 'file':
        return `${prefix} 📎 File: ${content.name || content.path}`;

      case 'done':
        const status = content.success ? '✅' : '❌';
        const msg = content.success ? content.message : content.error;
        return `${prefix} ${status} ${msg || 'Task completed'}`;

      default:
        return `${prefix} Unknown message type: ${(content as MessageContent).type}`;
    }
  }

  /**
   * Send a message to the console.
   */
  send(message: UniversalMessage): Promise<SendResult> {
    try {
      const text = this.convert(message);

      // Output to console
      console.log(`\n${text}\n`);

      logger.debug({ chatId: message.chatId }, 'CLI message displayed');

      return Promise.resolve({
        success: true,
        // CLI doesn't have real message IDs, generate a pseudo one
        messageId: `cli-${Date.now()}`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, chatId: message.chatId }, 'Failed to display CLI message');
      return Promise.resolve({
        success: false,
        error: errorMessage,
      });
    }
  }
}

/**
 * Create a new CLI adapter instance.
 */
export function createCliAdapter(): CliAdapter {
  return new CliAdapter();
}
