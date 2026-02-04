/**
 * Output adapter interface for unified message handling.
 * Allows different output destinations (CLI, Feishu, etc.) to share the same message processing logic.
 */
import type { AgentMessageType } from '../types/agent.js';
import { createLogger } from './logger.js';
import * as path from 'path';

const logger = createLogger('FeishuOutputAdapter');

/**
 * ANSI color codes for terminal output.
 */
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

/**
 * Color mapping for message types.
 */
function getColorForMessageType(messageType: AgentMessageType): keyof typeof colors {
  switch (messageType) {
    case 'tool_use':
      return 'yellow';
    case 'tool_progress':
      return 'blue';
    case 'tool_result':
      return 'cyan';
    case 'error':
      return 'red';
    case 'status':
      return 'magenta';
    case 'result':
      return 'green';
    case 'notification':
      return 'dim';
    default:
      return 'reset';
  }
}

/**
 * Format text with ANSI color.
 */
function colorText(text: string, colorName: keyof typeof colors): string {
  return `${colors[colorName]}${text}${colors.reset}`;
}

/**
 * Output adapter interface.
 * Implementations define how messages are written to their destination.
 */
export interface OutputAdapter {
  /**
   * Write content to the output destination.
   * @param content - The content to write
   * @param messageType - The type of message (for formatting/throttling decisions)
   */
  write(content: string, messageType?: AgentMessageType): Promise<void> | void;
}

/**
 * Message metadata for advanced formatting.
 */
export interface MessageMetadata {
  /** Tool name if this is a tool use message */
  toolName?: string;
  /** Raw tool input for building rich cards */
  toolInputRaw?: Record<string, unknown>;
}

/**
 * CLI output adapter - writes to console with colors.
 */
export class CLIOutputAdapter implements OutputAdapter {
  private lastMessageType: AgentMessageType = 'text';

  write(content: string, messageType: AgentMessageType = 'text'): void {
    // Add newline between different message types
    if (messageType !== this.lastMessageType && messageType !== 'text') {
      console.log('');
    }

    // Format and output message
    const colorName = getColorForMessageType(messageType);
    const formatted = colorText(content, colorName);
    process.stdout.write(formatted);

    // Add newline for non-text messages
    if (messageType !== 'text') {
      console.log('');
    }

    this.lastMessageType = messageType;
  }

  /**
   * Ensure final newline when done.
   */
  finalize(): void {
    if (this.lastMessageType !== 'text') {
      console.log('');
    } else {
      console.log('');
    }
  }
}

/**
 * Feishu output adapter options.
 */
export interface FeishuOutputAdapterOptions {
  sendMessage: (chatId: string, text: string) => Promise<void>;
  sendCard: (chatId: string, card: Record<string, unknown>) => Promise<void>;
  chatId: string;
  throttleIntervalMs?: number;
  sendFile?: (filePath: string) => Promise<void>;
}

/**
 * Feishu output adapter - sends messages via WebSocket.
 * Handles throttling for progress messages and sends interactive cards for Edit tool use.
 *
 * Tracks whether any user-facing message has been sent during a task.
 */
export class FeishuOutputAdapter implements OutputAdapter {
  private progressThrottleMap = new Map<string, number>();
  private readonly throttleIntervalMs: number;
  private messageSentFlag = false;  // Track if any user message was sent

  constructor(private options: FeishuOutputAdapterOptions) {
    this.throttleIntervalMs = options.throttleIntervalMs ?? 2000;
  }

  /**
   * Check if any user message has been sent during this task.
   */
  hasSentMessage(): boolean {
    return this.messageSentFlag;
  }

  /**
   * Reset message tracking for a new task.
   */
  resetMessageTracking(): void {
    this.messageSentFlag = false;
  }

  /**
   * Check if a progress message should be throttled.
   */
  private shouldSendProgress(toolName: string): boolean {
    const key = `${this.options.chatId}:${toolName}`;
    const now = Date.now();
    const lastSent = this.progressThrottleMap.get(key);

    if (lastSent === undefined || now - lastSent >= this.throttleIntervalMs) {
      this.progressThrottleMap.set(key, now);
      return true;
    }
    return false;
  }

  /**
   * Clear throttle state for this chat (call when starting a new query).
   */
  clearThrottleState(): void {
    for (const key of this.progressThrottleMap.keys()) {
      if (key.startsWith(`${this.options.chatId}:`)) {
        this.progressThrottleMap.delete(key);
      }
    }
  }

  async write(
    content: string,
    messageType: AgentMessageType = 'text',
    metadata?: MessageMetadata
  ): Promise<void> {
    // Skip empty or whitespace-only content
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return;
    }

    // Skip SDK completion messages (they create visual noise)
    if (messageType === 'result' && trimmedContent.startsWith('✅ Complete')) {
      return;
    }

    // Throttle progress messages
    if (messageType === 'tool_progress') {
      // Extract tool name from content if possible
      const toolMatch = content.match(/Using (\w+):/);
      const toolName = toolMatch ? toolMatch[1] : 'unknown';
      if (!this.shouldSendProgress(toolName)) {
        return; // Skip this message due to throttling
      }
    }

    let cardSent = false;

    // Handle Edit tool use with unified diff card
    if (messageType === 'tool_use' && metadata?.toolName === 'Edit' && metadata?.toolInputRaw) {
      cardSent = await this.sendEditDiffCard(metadata.toolInputRaw);
    }

    // Handle Write tool use with content preview card
    if (messageType === 'tool_use' && metadata?.toolName === 'Write' && metadata?.toolInputRaw) {
      cardSent = await this.sendWriteContentCard(metadata.toolInputRaw);
    }

    // Only send text message if no card was sent
    if (!cardSent) {
      await this.options.sendMessage(this.options.chatId, content);
      this.messageSentFlag = true;  // Mark that we sent a user message
    } else if (cardSent) {
      this.messageSentFlag = true;  // Card was also sent to user
    }
  }

  /**
   * Send Edit tool use as a Unified Diff card.
   * Dynamically import the diff card builder to avoid circular dependencies.
   *
   * @returns true if card was sent successfully, false otherwise
   */
  private async sendEditDiffCard(toolInput: Record<string, unknown>): Promise<boolean> {
    logger.debug({ keys: Object.keys(toolInput) }, 'Edit tool input keys');
    logger.debug({ toolInput }, 'Edit tool input');

    try {
      // Dynamic import to avoid circular dependencies
      const { parseEditToolInput, buildUnifiedDiffCard } = await import('../feishu/diff-card-builder.js');

      const codeChange = parseEditToolInput(toolInput);
      logger.debug({ success: !!codeChange }, 'Parse edit tool input result');

      if (!codeChange) {
        logger.debug({
          file_path: toolInput.file_path,
          filePath: toolInput.filePath,
        }, 'File path check');
      }

      if (codeChange) {
        const card = buildUnifiedDiffCard([codeChange], '📝 代码编辑', 'blue');
        logger.debug('Card built, sending...');
        await this.options.sendCard(this.options.chatId, card);
        logger.debug('Card sent successfully');
        return true;
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to send diff card, falling back to text');
    }

    // Fallback: send as plain text (will be handled by caller)
    const filePath = (toolInput.file_path as string | undefined) || (toolInput.filePath as string | undefined) || '<unknown>';
    logger.debug({ filePath }, 'Fallback to text');
    await this.options.sendMessage(this.options.chatId, `📝 Editing: ${filePath}`);
    return false;
  }

  /**
   * Send Write tool use as a content preview card.
   * Shows full content if under threshold, otherwise shows truncated version.
   *
   * @returns true if card was sent successfully, false otherwise
   */
  private async sendWriteContentCard(toolInput: Record<string, unknown>): Promise<boolean> {
    logger.debug({ keys: Object.keys(toolInput) }, 'Write tool input keys');
    logger.debug({ toolInput }, 'Write tool input');

    try {
      // Dynamic import to avoid circular dependencies
      const { parseWriteToolInput, buildWriteContentCard } = await import('../feishu/write-card-builder.js');

      const writeContent = parseWriteToolInput(toolInput);
      logger.debug({ success: !!writeContent }, 'Parse write tool input result');

      if (!writeContent) {
        logger.debug({
          file_path: toolInput.file_path,
          filePath: toolInput.filePath,
        }, 'File path check');
      }

      if (writeContent) {
        const card = buildWriteContentCard(writeContent, '✍️ 文件写入', 'green');
        logger.debug('Card built, sending...');
        await this.options.sendCard(this.options.chatId, card);
        logger.debug('Card sent successfully');

        // Send task.md file as attachment if applicable
        if (writeContent.filePath && this.options.sendFile) {
          const fileName = path.basename(writeContent.filePath);
          // Check for task.md pattern (files with "task" in name ending with .md)
          if (fileName.toLowerCase().includes('task') && fileName.endsWith('.md')) {
            logger.info({ filePath: writeContent.filePath }, 'Sending task.md file to user');
            // Send file asynchronously, don't block the response
            this.options.sendFile(writeContent.filePath).catch(err => {
              logger.error({ err, filePath: writeContent.filePath }, 'Failed to send task.md file');
            });
          }
        }

        return true;
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to send write content card, falling back to text');
    }

    // Fallback: send as plain text (will be handled by caller)
    const filePath = (toolInput.file_path as string | undefined) || (toolInput.filePath as string | undefined) || '<unknown>';
    logger.debug({ filePath }, 'Fallback to text');
    await this.options.sendMessage(this.options.chatId, `✍️ Writing: ${filePath}`);
    return false;
  }
}
