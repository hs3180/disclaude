/**
 * Message history storage for Feishu/Lark bot.
 *
 * Tracks conversation history between users and the bot,
 * including both inbound (user) and outbound (bot) messages.
 *
 * This provides context for InteractionAgent to understand
 * the conversation flow before creating Task.md.
 *
 * Storage: In-memory Map (lost on restart)
 * TODO: Consider persisting to Redis or database for production
 */

/**
 * Single message in conversation history.
 */
export interface ChatMessage {
  /** Message ID from Feishu */
  messageId: string;
  /** Timestamp when message was sent/received */
  timestamp: number;
  /** Message sender: 'user' or 'bot' */
  role: 'user' | 'bot';
  /** Message content text */
  content: string;
  /** Optional user ID who sent the message */
  userId?: string;
}

/**
 * Chat history for a specific conversation.
 */
export interface ChatHistory {
  /** All messages in chronological order */
  messages: ChatMessage[];
  /** When this chat was first tracked */
  createdAt: number;
  /** Last message timestamp */
  lastUpdatedAt: number;
}

/**
 * Message history manager.
 * Stores and retrieves conversation history per chat.
 */
export class MessageHistoryManager {
  private histories = new Map<string, ChatHistory>();

  /**
   * Maximum messages to keep per chat.
   * Prevents unbounded memory growth.
   */
  private readonly MAX_MESSAGES_PER_CHAT = 100;

  /**
   * Add a user message to history.
   */
  addUserMessage(chatId: string, messageId: string, content: string, userId?: string): void {
    this.addMessage(chatId, {
      messageId,
      timestamp: Date.now(),
      role: 'user',
      content,
      userId,
    });
  }

  /**
   * Add a bot message to history.
   */
  addBotMessage(chatId: string, messageId: string, content: string): void {
    this.addMessage(chatId, {
      messageId,
      timestamp: Date.now(),
      role: 'bot',
      content,
    });
  }

  /**
   * Internal method to add message and enforce limits.
   */
  private addMessage(chatId: string, message: ChatMessage): void {
    let history = this.histories.get(chatId);

    if (!history) {
      history = {
        messages: [],
        createdAt: Date.now(),
        lastUpdatedAt: Date.now(),
      };
      this.histories.set(chatId, history);
    }

    // Add new message
    history.messages.push(message);
    history.lastUpdatedAt = Date.now();

    // Trim old messages if over limit
    if (history.messages.length > this.MAX_MESSAGES_PER_CHAT) {
      const removeCount = history.messages.length - this.MAX_MESSAGES_PER_CHAT;
      history.messages.splice(0, removeCount);
    }
  }

  /**
   * Get conversation history for a chat.
   * Returns messages in chronological order.
   */
  getHistory(chatId: string): ChatMessage[] {
    const history = this.histories.get(chatId);
    return history ? [...history.messages] : [];
  }

  /**
   * Get formatted conversation history as text.
   * Useful for including in prompts.
   */
  getFormattedHistory(chatId: string, maxMessages?: number): string {
    const messages = this.getHistory(chatId);

    // Apply limit if specified
    const limitedMessages = maxMessages
      ? messages.slice(-maxMessages)
      : messages;

    if (limitedMessages.length === 0) {
      return '(No previous conversation history)';
    }

    const lines = limitedMessages.map((msg, idx) => {
      const prefix = msg.role === 'user' ? 'User' : 'Bot';
      return `[${idx + 1}] ${prefix}: ${msg.content}`;
    });

    return lines.join('\n');
  }

  /**
   * Clear history for a chat.
   */
  clearHistory(chatId: string): void {
    this.histories.delete(chatId);
  }

  /**
   * Get statistics about stored histories.
   */
  getStats(): { totalChats: number; totalMessages: number } {
    let totalMessages = 0;
    for (const history of this.histories.values()) {
      totalMessages += history.messages.length;
    }
    return {
      totalChats: this.histories.size,
      totalMessages,
    };
  }
}

/**
 * Global message history manager instance.
 */
export const messageHistoryManager = new MessageHistoryManager();
