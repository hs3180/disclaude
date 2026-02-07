import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// Agent message type enum
export type AgentMessageType =
  | 'text'
  | 'tool_use'
  | 'tool_progress'
  | 'tool_result'
  | 'error'
  | 'status'
  | 'result'
  | 'notification'
  | 'task_completion'  // Task completed message
  | 'max_iterations_warning';  // Max iterations reached warning

// Content block type from Anthropic API
export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | unknown[];
  [key: string]: unknown;
}

// Metadata for enhanced agent messages
export interface AgentMessageMetadata {
  toolName?: string;
  toolInput?: string;  // Formatted tool input for display
  toolInputRaw?: Record<string, unknown>;  // Raw tool input for processing (e.g., building diff cards)
  toolOutput?: string;
  elapsed?: number;
  cost?: number;
  tokens?: number;
  status?: string;
}

// Parsed SDK message result
export interface ParsedSDKMessage {
  type: AgentMessageType;
  content: string;
  metadata?: AgentMessageMetadata;
  sessionId?: string;
}

// Agent message interface (wraps SDK message)
export interface AgentMessage {
  content: string | ContentBlock[];
  role?: 'user' | 'assistant';
  messageType?: AgentMessageType;
  metadata?: AgentMessageMetadata;
  stop_reason?: string;
  stop_sequence?: string | null;
}

// Agent options (compatible with Agent SDK)
export interface AgentOptions {
  apiKey: string;
  model: string;
  apiBaseUrl?: string;
  // Agent SDK specific options
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  bypassPermissions?: boolean;
}

// Session info for resuming conversations
export interface SessionInfo {
  sessionId?: string;
  resume?: string;
}

/**
 * Union type for agent input supporting both string prompts and streaming message arrays.
 * This enables Streaming Input Mode for multi-turn conversation support.
 */
export type AgentInput = string | AsyncIterable<SDKUserMessage>;

/**
 * Conversation history for multi-turn context.
 * Used to maintain conversation state across multiple turns.
 */
export type ConversationHistory = SDKUserMessage[];
