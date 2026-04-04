/**
 * Platform Adapter Interfaces.
 *
 * These interfaces define platform-agnostic contracts for message handling
 * and file operations. Each platform (Feishu, REST, etc.) should implement
 * these interfaces.
 *
 * Architecture:
 * ```
 * Channel (BaseChannel)
 *     ├── IMessageSender (adapter)
 *     └── IFileHandler (adapter)
 * ```
 *
 * Migrated to @disclaude/core (Issue #1040)
 */

/**
 * File attachment metadata.
 * Platform-independent representation of a file attachment.
 */
export interface FileAttachment {
  /** Unique file identifier (platform-specific) */
  fileKey: string;
  /** Original file name */
  fileName?: string;
  /** Local file path after download */
  localPath?: string;
  /** File type: image, file, media */
  fileType: 'image' | 'file' | 'media';
  /** Associated message ID */
  messageId?: string;
  /** Upload timestamp */
  timestamp?: number;
  /** File size in bytes */
  fileSize?: number;
  /** MIME type */
  mimeType?: string;
}

/**
 * Result of file handling operation.
 */
export interface FileHandlerResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Local file path (if downloaded) */
  filePath?: string;
  /** Platform file key */
  fileKey?: string;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Message Sender Interface.
 *
 * Platform-agnostic interface for sending messages.
 * Implementations should handle platform-specific message formats.
 */
export interface IMessageSender {
  /**
   * Send a text message.
   *
   * @param chatId - Target chat/conversation ID
   * @param text - Message text content
   * @param threadId - Optional thread ID for threaded replies
   */
  sendText(chatId: string, text: string, threadId?: string): Promise<void>;

  /**
   * Send an interactive card message.
   *
   * @param chatId - Target chat/conversation ID
   * @param card - Platform-specific card structure
   * @param description - Optional description for logging
   * @param threadId - Optional thread ID for threaded replies
   */
  sendCard(
    chatId: string,
    card: Record<string, unknown>,
    description?: string,
    threadId?: string
  ): Promise<void>;

  /**
   * Send a file attachment.
   *
   * @param chatId - Target chat/conversation ID
   * @param filePath - Local file path to send
   * @param threadId - Optional thread ID for threaded replies
   */
  sendFile(chatId: string, filePath: string, threadId?: string): Promise<void>;

  /**
   * Add a reaction to a message (if supported).
   *
   * @param messageId - Message ID to react to
   * @param emoji - Emoji identifier
   * @returns Whether the reaction was added successfully
   */
  addReaction?(messageId: string, emoji: string): Promise<boolean>;
}

/**
 * File Handler Interface.
 *
 * Platform-agnostic interface for handling file operations.
 * Implementations should handle platform-specific file download/upload.
 */
export interface IFileHandler {
  /**
   * Handle an incoming file message.
   * Download and process the file.
   *
   * @param chatId - Chat/conversation ID
   * @param messageType - Type of file message
   * @param content - Raw message content (platform-specific)
   * @param messageId - Message ID for tracking
   */
  handleFileMessage(
    chatId: string,
    messageType: 'image' | 'file' | 'media' | 'audio',
    content: string,
    messageId: string
  ): Promise<FileHandlerResult>;

  /**
   * Build a structured prompt for file upload notification.
   *
   * @param attachment - File attachment metadata
   */
  buildUploadPrompt(attachment: FileAttachment): string;
}

/**
 * Attachment Manager Interface.
 *
 * Platform-agnostic interface for managing attachments in memory.
 */
export interface IAttachmentManager {
  /**
   * Check if a chat has attachments.
   */
  hasAttachments(chatId: string): boolean;

  /**
   * Get all attachments for a chat.
   */
  getAttachments(chatId: string): FileAttachment[];

  /**
   * Add an attachment.
   */
  addAttachment(chatId: string, attachment: FileAttachment): void;

  /**
   * Clear all attachments for a chat.
   */
  clearAttachments(chatId: string): void;

  /**
   * Clean up old attachments.
   */
  cleanupOldAttachments?(): void;
}

/**
 * Platform Adapter Interface.
 *
 * Combines all platform-specific adapters into a single interface.
 * This allows channels to work with any platform through a unified interface.
 */
export interface IPlatformAdapter {
  /** Platform identifier */
  readonly platformId: string;

  /** Platform name for display */
  readonly platformName: string;

  /** Message sender adapter */
  readonly messageSender: IMessageSender;

  /** File handler adapter (optional, may not be supported on all platforms) */
  readonly fileHandler?: IFileHandler;
}
