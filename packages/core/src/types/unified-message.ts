/**
 * Unified Message Types — RFC #3329 Phase 1.
 *
 * Defines the Message hierarchy for the 0.4.0 unified agent input abstraction.
 * Three concrete types differentiated by `source`:
 * - UserMessage (source: 'user') — Human via chat
 * - SystemMessage (source: 'system') — Infrastructure (scheduler, webhook, IPC)
 * - AgentMessage (source: 'agent') — Another ChatAgent (A2A)
 *
 * Core principle: Only UserMessage carries chatId.
 * SystemMessage and AgentMessage resolve chatId from project configuration
 * at Agent initialization time.
 *
 * @see Issue #3329 (RFC: Message — Unified Agent Input Abstraction)
 * @see Issue #3331 (Phase 1: NonUserMessage type definition and routing layer)
 */

// ============================================================================
// Base Type
// ============================================================================

/**
 * Message — Unified input type for ChatAgent.
 *
 * All messages share a payload (instruction text),
 * differentiated by source and source-specific fields.
 */
export interface Message {
  /** Unique message identifier */
  id: string;
  /** Message source discriminator */
  source: 'user' | 'system' | 'agent';
  /** Instruction / text content delivered to ChatAgent */
  payload: string;
  /** ISO 8601 timestamp */
  createdAt: string;
}

// ============================================================================
// UserMessage — Human via Chat
// ============================================================================

/**
 * Attachment carried alongside a user message (e.g. file, image).
 */
export interface UserMessageAttachment {
  /** File name */
  fileName: string;
  /** Local file path (after download) */
  filePath: string;
  /** MIME type */
  mimeType?: string;
}

/**
 * UserMessage — Message from a human user via a chat channel.
 *
 * chatId handling: UserMessage carries its own chatId,
 * extracted from the platform event (e.g. Feishu WebSocket event).
 */
export interface UserMessage extends Message {
  source: 'user';
  /** Chat identifier from the platform event */
  chatId: string;
  /** Sender's open ID (for @ mentions) */
  senderOpenId?: string;
  /** Platform message ID */
  messageId: string;
  /** File attachments */
  attachments?: UserMessageAttachment[];
  /** Chat history context for first messages */
  chatHistoryContext?: string;
}

// ============================================================================
// SystemMessage — Infrastructure Triggers
// ============================================================================

/**
 * System trigger sub-types.
 *
 * - 'scheduled': Cron-triggered task
 * - 'signal': External event (webhook, IPC)
 * - 'command': Admin command (/project trigger)
 */
export type SystemTrigger = 'scheduled' | 'signal' | 'command';

/**
 * Model tier override for system messages.
 * Named to avoid conflict with config ModelTier.
 */
export type MessageModelTier = 'low' | 'normal' | 'high';

/**
 * SystemMessage — Message from infrastructure (scheduler, webhook, IPC).
 *
 * chatId handling: When `projectKey` is set, chatId comes from project config
 * (bound at Agent init). When absent, falls back to legacy routing.
 */
export interface SystemMessage extends Message {
  source: 'system';
  /** Trigger sub-type */
  trigger: SystemTrigger;
  /** Target project key (e.g. 'owner/repo'). If set → route to project-bound Agent */
  projectKey?: string;
  /** Task name for scheduled tasks */
  taskName?: string;
  /** Model tier override */
  modelTier?: MessageModelTier;
  /** Trigger-specific payload data */
  data?: Record<string, unknown>;
}

// ============================================================================
// AgentMessage — A2A Delegation
// ============================================================================

/**
 * AgentMessage — Message from another ChatAgent (Agent-to-Agent delegation).
 *
 * chatId handling: Resolved from project config.
 * The source agent's `fromChatId` is for traceability only.
 */
export interface AgentMessage extends Message {
  source: 'agent';
  /** Source Agent's chatId (for traceability) */
  fromChatId: string;
  /** Target project key */
  projectKey?: string;
  /** Message priority */
  priority: 'low' | 'normal' | 'high';
}

// ============================================================================
// Union Type
// ============================================================================

/**
 * Union of all concrete Message types.
 */
export type AnyMessage = UserMessage | SystemMessage | AgentMessage;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a message is a UserMessage.
 */
export function isUserMessage(message: Message): message is UserMessage {
  return message.source === 'user';
}

/**
 * Check if a message is a SystemMessage.
 */
export function isSystemMessage(message: Message): message is SystemMessage {
  return message.source === 'system';
}

/**
 * Check if a message is an AgentMessage.
 */
export function isAgentMessage(message: Message): message is AgentMessage {
  return message.source === 'agent';
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a unique message ID.
 */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create a UserMessage.
 * Named to avoid conflict with utils/error-handler createUserMessage.
 */
export function createUnifiedUserMessage(options: {
  chatId: string;
  payload: string;
  messageId: string;
  senderOpenId?: string;
  attachments?: UserMessageAttachment[];
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
 * Create a SystemMessage.
 */
export function createSystemMessage(options: {
  payload: string;
  trigger: SystemTrigger;
  projectKey?: string;
  taskName?: string;
  modelTier?: MessageModelTier;
  data?: Record<string, unknown>;
}): SystemMessage {
  return {
    id: generateMessageId(),
    source: 'system',
    payload: options.payload,
    trigger: options.trigger,
    projectKey: options.projectKey,
    taskName: options.taskName,
    modelTier: options.modelTier,
    data: options.data,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create an AgentMessage.
 */
export function createAgentMessage(options: {
  payload: string;
  fromChatId: string;
  projectKey?: string;
  priority?: 'low' | 'normal' | 'high';
}): AgentMessage {
  return {
    id: generateMessageId(),
    source: 'agent',
    payload: options.payload,
    fromChatId: options.fromChatId,
    projectKey: options.projectKey,
    priority: options.priority ?? 'normal',
    createdAt: new Date().toISOString(),
  };
}
