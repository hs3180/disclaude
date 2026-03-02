/**
 * CLI Channel Adapter - Console output for CLI mode.
 *
 * Converts UniversalMessage to console output.
 * Handles chatIds starting with "cli-".
 *
 * @see Issue #480
 */

import { createLogger } from '../../utils/logger.js';
import { BaseChannelAdapter, type SendResult } from '../channel-adapter.js';
import {
  CLI_CAPABILITIES,
  type UniversalMessage,
  type CardContent,
  isTextContent,
  isMarkdownContent,
  isCardContent,
  isFileContent,
  isDoneContent,
} from '../universal-message.js';

const logger = createLogger('CLIAdapter');

/**
 * CLI Channel Adapter.
 * Outputs messages to the console.
 */
export class CLIAdapter extends BaseChannelAdapter {
  readonly id = 'cli';
  readonly name = 'CLI Adapter';
  readonly capabilities = CLI_CAPABILITIES;

  /**
   * Handle chatIds starting with "cli-".
   */
  canHandle(chatId: string): boolean {
    return chatId.startsWith('cli-');
  }

  /**
   * Convert to console-friendly format.
   */
  convert(message: UniversalMessage): { text: string; type: string } {
    const { content } = message;

    if (isTextContent(content)) {
      return { text: content.text, type: 'text' };
    }

    if (isMarkdownContent(content)) {
      return { text: content.text, type: 'markdown' };
    }

    if (isCardContent(content)) {
      return { text: this.formatCard(content), type: 'card' };
    }

    if (isFileContent(content)) {
      return { text: `[File: ${content.fileName}]`, type: 'file' };
    }

    if (isDoneContent(content)) {
      return {
        text: content.success ? '✅ Task completed' : `❌ Task failed: ${content.error}`,
        type: 'done',
      };
    }

    return { text: JSON.stringify(content, null, 2), type: 'unknown' };
  }

  /**
   * Send to console.
   */
  send(message: UniversalMessage): Promise<SendResult> {
    const converted = this.convert(message);
    const messageId = `cli-${Date.now()}`;

    try {
      // Log to console
      console.log(`\n${converted.text}\n`);

      logger.debug({
        chatId: message.chatId,
        type: converted.type,
        messageLength: converted.text.length,
      }, 'CLI message sent');

      return Promise.resolve(this.successResult(messageId));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, chatId: message.chatId }, 'CLI send failed');
      return Promise.resolve(this.errorResult(errorMessage));
    }
  }

  /**
   * Format card content for console display.
   */
  private formatCard(card: CardContent): string {
    const lines: string[] = [];

    // Header
    lines.push('─'.repeat(50));
    lines.push(`📋 ${card.title}`);
    if (card.subtitle) {
      lines.push(`   ${card.subtitle}`);
    }
    lines.push('─'.repeat(50));
    lines.push('');

    // Sections
    for (const section of card.sections) {
      if (section.type === 'text' || section.type === 'markdown') {
        lines.push(section.content ?? '');
        lines.push('');
      } else if (section.type === 'divider') {
        lines.push('─'.repeat(30));
        lines.push('');
      } else if (section.type === 'actions' && section.actions) {
        const actionLabels = section.actions.map((a, i) => `[${i + 1}] ${a.label}`);
        lines.push(`Actions: ${actionLabels.join('  ')}`);
        lines.push('');
      } else if (section.type === 'columns' && section.columns) {
        // Simple column display
        for (const column of section.columns) {
          for (const colSection of column.sections) {
            if (colSection.content) {
              lines.push(colSection.content);
            }
          }
        }
        lines.push('');
      } else if (section.type === 'image') {
        lines.push(`[Image: ${section.imageUrl}]`);
        lines.push('');
      }
    }

    // Card-level actions
    if (card.actions && card.actions.length > 0) {
      lines.push('─'.repeat(30));
      const actionLabels = card.actions.map((a, i) => `[${i + 1}] ${a.label}`);
      lines.push(actionLabels.join('  '));
    }

    lines.push('─'.repeat(50));

    return lines.join('\n');
  }
}

/**
 * Factory function to create CLI adapter.
 */
export function createCLIAdapter(): CLIAdapter {
  return new CLIAdapter();
}
