/**
 * Unified Message abstraction for ChatAgent input (Issue #3329 Phase 1).
 *
 * Three concrete types, distinguished by `source`:
 * - UserMessage: Human input via chat channel
 * - SystemMessage: Infrastructure triggers (scheduler, webhook, IPC)
 * - AgentMessage: A2A delegation (future — excluded from Phase 1)
 *
 * Core principle: Only UserMessage carries chatId.
 * SystemMessage resolves chatId from project configuration at routing time.
 *
 * @see Issue #3329 (RFC: Message — Unified Agent Input Abstraction)
 * @see Issue #3580 (Phase 1: Message types + MessageRouter)
 * @see Issue #3582 (Phase 3: Channel + Scheduler integration)
 */

// ============================================================================
// Base Message Type
// ============================================================================

/**
 * Message — Unified input type for ChatAgent.
 *
 * All messages share a payload (instruction text),
 * differentiated by source and source-specific fields.
 */
export interface Message {
  /** Unique message identifier (UUID or platform-specific ID) */
  id: string;
  /** Discriminator for message source */
  source: 'user' | 'system';
  /** Instruction / text content for the agent */
  payload: string;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
}

// ============================================================================
// UserMessage — Human via Chat
// ============================================================================

/**
 * Attachment metadata carried alongside a user message.
 */
export interface Attachment {
  /** File name */
  fileName: string;
  /** Local file path (after download) */
  filePath: string;
  /** MIME type */
  mimeType?: string;
  /** File size in bytes */
  size?: number;
}

/**
 * UserMessage — Human user input via chat channel.
 *
 * chatId is extracted from the chat platform event (e.g. Feishu WebSocket).
 * The MessageRouter routes directly by chatId → AgentPool.
 */
export interface UserMessage extends Message {
  source: 'user';
  /** Chat/conversation identifier from the platform event */
  chatId: string;
  /** Sender's open_id (for @ mention tracking) */
  senderOpenId?: string;
  /** Platform message ID (for deduplication and reply threading) */
  messageId: string;
  /** File/image attachments (lightweight metadata) */
  attachments?: Attachment[];
  /**
   * File references for agent processing (Issue #3582 Phase 3).
   * When set, these are passed through to ChatAgent.processMessage().
   * Takes precedence over `attachments` when both are present.
   */
  fileRefs?: Array<{
    id: string;
    fileName: string;
    mimeType?: string;
    size?: number;
    source: 'user' | 'agent';
    localPath?: string;
    platformKey?: string;
    createdAt: number;
    expiresAt?: number;
  }>;
  /** Recent chat history context (for trigger-mode mentions) */
  chatHistoryContext?: string;
}

// ============================================================================
// SystemMessage — Infrastructure Triggers
// ============================================================================

/**
 * System trigger sub-types.
 *
 * Distinguishes between different infrastructure trigger mechanisms
 * within a single SystemMessage type — no need for separate classes.
 */
export type SystemTrigger =
  | 'scheduled'   // Cron-triggered task
  | 'signal'      // External event (webhook, IPC)
  | 'command';    // Admin command (/project trigger)

/**
 * SystemMessage — Infrastructure-triggered input.
 *
 * chatId resolution:
 * - When `projectKey` is set → resolved from project config (Phase 2)
 * - When absent → falls back to legacy `task.chatId` (backward compatible)
 *
 * Design note: `trigger` sub-type distinguishes between scheduled tasks,
 * external signals, and admin commands within a single SystemMessage type.
 */
export interface SystemMessage extends Message {
  source: 'system';
  /** What triggered this system message */
  trigger: SystemTrigger;
  /** If set → route to project-bound agent (chatId resolved from config) */
  projectKey?: string;
  /** Task name for scheduled tasks */
  taskName?: string;
  /** Trigger-specific payload data */
  data?: Record<string, unknown>;
}

// ============================================================================
// Union Type
// ============================================================================

/**
 * Union of all concrete Message types.
 *
 * Used for type-safe MessageRouter input.
 */
export type InputMessage = UserMessage | SystemMessage;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a Message is a UserMessage.
 */
export function isUserMessage(message: Message): message is UserMessage {
  return message.source === 'user';
}

/**
 * Check if a Message is a SystemMessage.
 */
export function isSystemMessage(message: Message): message is SystemMessage {
  return message.source === 'system';
}
