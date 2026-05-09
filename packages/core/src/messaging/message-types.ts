/**
 * Unified Message Types for Agent Input Abstraction (0.4.0).
 *
 * This module defines the unified Message hierarchy that all ChatAgent inputs
 * conform to. Through three concrete types — UserMessage, SystemMessage,
 * AgentMessage — ChatAgent receives input from users, infrastructure triggers,
 * and other agents, all through the same processMessage() path.
 *
 * Design Decisions (RFC #3329):
 * - Three Message types with `source` discriminator (not "NonUserMessage")
 * - Only UserMessage carries chatId; SystemMessage/AgentMessage resolve from project config
 * - No new Agent type needed — ChatAgent handles all message sources identically
 *
 * @see Issue #3329 (RFC: Message — Unified Agent Input Abstraction)
 * @see Issue #3331 (Phase 1: Type definition and routing layer)
 */

// ============================================================================
// Message Source Types
// ============================================================================

/**
 * Message source discriminator.
 *
 * - `'user'`: Human via chat (Feishu, etc.)
 * - `'system'`: Infrastructure triggers (scheduler, webhook, IPC)
 * - `'agent'`: Another ChatAgent (A2A delegation)
 */
export type MessageSource = 'user' | 'system' | 'agent';

/**
 * Priority level for messages.
 *
 * Used by the router to order message delivery when multiple messages
 * are queued for the same ChatAgent.
 */
export type MessagePriority = 'low' | 'normal' | 'high';

/**
 * System trigger sub-types.
 *
 * Distinguishes between different infrastructure trigger mechanisms
 * within the single SystemMessage type.
 */
export type SystemTrigger = 'scheduled' | 'signal' | 'command';

/**
 * Model tier for system-driven tasks.
 * Allows the router to specify model capability/cost trade-offs.
 */
export type ModelTier = 'high' | 'low' | 'multimodal';

// ============================================================================
// Base Message Type
// ============================================================================

/**
 * Message — Unified input type for ChatAgent.
 *
 * All messages share a payload (instruction text), differentiated by source
 * and source-specific fields. Only UserMessage carries chatId; SystemMessage
 * and AgentMessage resolve chatId from project configuration at routing time.
 *
 * @example
 * ```typescript
 * const msg: Message = {
 *   id: 'msg-123',
 *   source: 'system',
 *   payload: 'Daily sync and triage...',
 *   createdAt: new Date().toISOString(),
 * };
 * ```
 */
export interface Message {
  /** Unique message identifier */
  id: string;
  /** Message source discriminator */
  source: MessageSource;
  /** Instruction / text content for the ChatAgent */
  payload: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
}

// ============================================================================
// UserMessage — Human via Chat
// ============================================================================

/**
 * Attachment interface for user messages.
 */
export interface MessageAttachment {
  /** File name */
  name: string;
  /** File path */
  path: string;
  /** MIME type */
  type: string;
}

/**
 * UserMessage — Message from a human via chat.
 *
 * chatId is carried in the message itself, extracted from the
 * Feishu WebSocket event by the channel adapter.
 *
 * @example
 * ```typescript
 * const userMsg: UserMessage = {
 *   id: 'msg-456',
 *   source: 'user',
 *   payload: 'Fix the login bug',
 *   chatId: 'oc_abc123',
 *   messageId: 'cli-xyz789',
 *   senderOpenId: 'ou_sender',
 *   createdAt: new Date().toISOString(),
 * };
 * ```
 */
export interface UserMessage extends Message {
  source: 'user';
  /** Chat/conversation ID (from Feishu event) */
  chatId: string;
  /** Feishu message ID */
  messageId: string;
  /** Sender's open_id for @ mentions */
  senderOpenId?: string;
  /** File attachments */
  attachments?: MessageAttachment[];
  /** Chat history context for passive mode */
  chatHistoryContext?: string;
}

// ============================================================================
// SystemMessage — Infrastructure Triggers
// ============================================================================

/**
 * SystemMessage — Message from infrastructure triggers.
 *
 * chatId is NOT carried in the message. When `projectKey` is set,
 * chatId is resolved from project configuration at routing time.
 * When absent, falls back to legacy task.chatId (backward compatible).
 *
 * @example
 * ```typescript
 * const systemMsg: SystemMessage = {
 *   id: 'msg-789',
 *   source: 'system',
 *   trigger: 'scheduled',
 *   payload: 'Daily repo maintenance...',
 *   taskName: 'Daily Repo Maintenance',
 *   projectKey: 'hs3180/disclaude',
 *   modelTier: 'low',
 *   createdAt: new Date().toISOString(),
 * };
 * ```
 */
export interface SystemMessage extends Message {
  source: 'system';
  /** Trigger sub-type */
  trigger: SystemTrigger;
  /** Target project key for routing (optional — falls back to legacy task.chatId) */
  projectKey?: string;
  /** Task name for scheduled tasks */
  taskName?: string;
  /** Model tier override */
  modelTier?: ModelTier;
  /** Trigger-specific payload data */
  data?: Record<string, unknown>;
}

// ============================================================================
// AgentMessage — A2A Delegation
// ============================================================================

/**
 * AgentMessage — Message from another ChatAgent (A2A delegation).
 *
 * chatId is resolved from project configuration at routing time.
 * `fromChatId` is for traceability only.
 *
 * @example
 * ```typescript
 * const agentMsg: AgentMessage = {
 *   id: 'msg-101',
 *   source: 'agent',
 *   fromChatId: 'oc_requester',
 *   projectKey: 'hs3180/disclaude',
 *   payload: 'User requested immediate issue triage.',
 *   priority: 'high',
 *   createdAt: new Date().toISOString(),
 * };
 * ```
 */
export interface AgentMessage extends Message {
  source: 'agent';
  /** Source Agent's chatId (for traceability) */
  fromChatId: string;
  /** Target project key for routing */
  projectKey?: string;
  /** Message priority for queue ordering */
  priority: MessagePriority;
}

// ============================================================================
// Union Types
// ============================================================================

/**
 * Union of all system-driven message types (non-user).
 *
 * Convenience type for router methods that handle non-user messages.
 */
export type NonUserMessage = SystemMessage | AgentMessage;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard: check if a message is a UserMessage.
 */
export function isUserMessage(message: Message): message is UserMessage {
  return message.source === 'user';
}

/**
 * Type guard: check if a message is a SystemMessage.
 */
export function isSystemMessage(message: Message): message is SystemMessage {
  return message.source === 'system';
}

/**
 * Type guard: check if a message is an AgentMessage.
 */
export function isAgentMessage(message: Message): message is AgentMessage {
  return message.source === 'agent';
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a unique message ID.
 *
 * Format: `msg-{timestamp}-{random}` for easy identification and debugging.
 */
export function generateMessageId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `msg-${timestamp}-${random}`;
}

/**
 * Create a UserMessage with defaults.
 */
export function createUserMessage(options: {
  chatId: string;
  payload: string;
  messageId: string;
  senderOpenId?: string;
  attachments?: MessageAttachment[];
  chatHistoryContext?: string;
}): UserMessage {
  return {
    id: generateMessageId(),
    source: 'user',
    payload: options.payload,
    chatId: options.chatId,
    messageId: options.messageId,
    senderOpenId: options.senderOpenId,
    attachments: options.attachments,
    chatHistoryContext: options.chatHistoryContext,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create a SystemMessage with defaults.
 */
export function createSystemMessage(options: {
  trigger: SystemTrigger;
  payload: string;
  projectKey?: string;
  taskName?: string;
  modelTier?: ModelTier;
  data?: Record<string, unknown>;
}): SystemMessage {
  return {
    id: generateMessageId(),
    source: 'system',
    trigger: options.trigger,
    payload: options.payload,
    projectKey: options.projectKey,
    taskName: options.taskName,
    modelTier: options.modelTier,
    data: options.data,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create an AgentMessage with defaults.
 */
export function createAgentMessage(options: {
  fromChatId: string;
  payload: string;
  projectKey?: string;
  priority?: MessagePriority;
}): AgentMessage {
  return {
    id: generateMessageId(),
    source: 'agent',
    fromChatId: options.fromChatId,
    projectKey: options.projectKey,
    payload: options.payload,
    priority: options.priority ?? 'normal',
    createdAt: new Date().toISOString(),
  };
}
