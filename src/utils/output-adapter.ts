/**
 * Output adapter interface for unified message handling.
 * Allows different output destinations (CLI, Feishu, etc.) to share the same message processing logic.
 */
import type { AgentMessageType } from '../types/agent.js';

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
}

/**
 * Feishu output adapter - sends messages via WebSocket.
 * Handles throttling for progress messages and sends interactive cards for Edit tool use.
 */
export class FeishuOutputAdapter implements OutputAdapter {
  private progressThrottleMap = new Map<string, number>();
  private readonly throttleIntervalMs: number;

  constructor(private options: FeishuOutputAdapterOptions) {
    this.throttleIntervalMs = options.throttleIntervalMs ?? 2000;
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
    // Throttle progress messages
    if (messageType === 'tool_progress') {
      // Extract tool name from content if possible
      const toolMatch = content.match(/Using (\w+):/);
      const toolName = toolMatch ? toolMatch[1] : 'unknown';
      if (!this.shouldSendProgress(toolName)) {
        return; // Skip this message due to throttling
      }
    }

    // Handle Edit tool use with unified diff card
    if (messageType === 'tool_use' && metadata?.toolName === 'Edit' && metadata?.toolInputRaw) {
      await this.sendEditDiffCard(metadata.toolInputRaw);
      return;
    }

    await this.options.sendMessage(this.options.chatId, content);
  }

  /**
   * Send Edit tool use as a Unified Diff card.
   * Dynamically import the diff card builder to avoid circular dependencies.
   */
  private async sendEditDiffCard(toolInput: Record<string, unknown>): Promise<void> {
    console.log('[Debug Edit] toolInput keys:', Object.keys(toolInput));
    console.log('[Debug Edit] toolInput:', JSON.stringify(toolInput, null, 2));

    try {
      // Dynamic import to avoid circular dependencies
      const { parseEditToolInput, buildUnifiedDiffCard } = await import('../feishu/diff-card-builder.js');

      const codeChange = parseEditToolInput(toolInput);
      console.log('[Debug Edit] parseEditToolInput result:', codeChange ? 'SUCCESS' : 'NULL');
      if (!codeChange) {
        console.log('[Debug Edit] filePath check:', {
          file_path: toolInput.file_path,
          filePath: toolInput.filePath,
        });
      }

      if (codeChange) {
        const card = buildUnifiedDiffCard([codeChange], '📝 代码编辑', 'blue');
        console.log('[Debug Edit] Card built, sending...');
        await this.options.sendCard(this.options.chatId, card);
        console.log('[Debug Edit] Card sent successfully');
        return;
      }
    } catch (error) {
      console.error('[FeishuAdapter] Failed to send diff card, falling back to text:', error);
    }

    // Fallback: send as plain text
    const filePath = (toolInput.file_path as string | undefined) || (toolInput.filePath as string | undefined) || '<unknown>';
    console.log('[Debug Edit] Fallback to text, filePath:', filePath);
    await this.options.sendMessage(this.options.chatId, `📝 Editing: ${filePath}`);
  }
}
