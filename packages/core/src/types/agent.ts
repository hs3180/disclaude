/**
 * Agent type definitions for disclaude.
 *
 * Extended types for application-level use that build upon SDK types.
 *
 * @module types/agent
 */

import type {
  AgentMessageMetadata as SdkAgentMessageMetadata,
  StreamingUserMessage as SdkStreamingUserMessage,
  AgentMessageType as SdkAgentMessageType,
} from '../sdk/types.js';

/**
 * Extended ContentBlock type for application-level use.
 * Includes all content block types from Anthropic API.
 */
export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | unknown[];
  [key: string]: unknown;
}

/**
 * Extended AgentMessageType for application-level use.
 * Adds application-specific message types not present in SDK.
 */
export type ExtendedAgentMessageType = SdkAgentMessageType | 'notification' | 'task_completion' | 'max_iterations_warning';

/**
 * Extended AgentMessageMetadata for application-level use.
 * Adds additional metadata fields for tool input display.
 */
export interface ExtendedAgentMessageMetadata extends SdkAgentMessageMetadata {
  /** Formatted tool input for display */
  toolInput?: string;
  /** Raw tool input for processing (e.g., building diff cards) */
  toolInputRaw?: Record<string, unknown>;
  /** Elapsed time in seconds */
  elapsed?: number;
  /** Cost in dollars */
  cost?: number;
  /** Token count */
  tokens?: number;
  /** Status string */
  status?: string;
}

/**
 * Extended AgentMessage for application-level use.
 * Supports both string content and ContentBlock array.
 */
export interface AgentMessage {
  /** Message type */
  type?: ExtendedAgentMessageType;
  /** Message content (string or array of content blocks) */
  content: string | ContentBlock[];
  /** Message role */
  role?: 'user' | 'assistant';
  /** Message type for compatibility */
  messageType?: ExtendedAgentMessageType;
  /** Message metadata */
  metadata?: ExtendedAgentMessageMetadata;
  /** Stop reason */
  stop_reason?: string;
  /** Stop sequence */
  stop_sequence?: string | null;
}

/**
 * Agent options (compatible with Agent SDK).
 * This is a simplified version for backward compatibility.
 */
export interface AgentOptions {
  apiKey: string;
  model: string;
  apiBaseUrl?: string;
  // Agent SDK specific options
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  bypassPermissions?: boolean;
}

/**
 * Parsed SDK message result.
 * Used by legacy message parsing utilities.
 */
export interface ParsedSDKMessage {
  type: ExtendedAgentMessageType;
  content: string;
  metadata?: ExtendedAgentMessageMetadata;
  sessionId?: string;
}

/**
 * Union type for agent input supporting both string prompts and streaming message arrays.
 * This enables Streaming Input Mode for multi-turn conversation support.
 */
export type AgentInput = string | AsyncIterable<SdkStreamingUserMessage>;
