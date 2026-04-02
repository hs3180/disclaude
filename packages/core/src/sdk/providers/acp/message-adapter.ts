/**
 * ACP Message Adapter
 *
 * Converts ACP session/update notifications to unified AgentMessage format.
 * Also converts unified UserInput to ACP prompt format.
 *
 * @module sdk/providers/acp/message-adapter
 */

import type { AgentMessageMetadata, UserInput, ContentBlock } from '../../types.js';
import type { MessageBridge } from './types.js';

// ============================================================================
// ACP → AgentMessage Conversion
// ============================================================================

/**
 * ACP text content block.
 */
interface ACPTextContent {
  type: string;
  text: string;
}

/**
 * ACP session update for agent message chunks.
 */
interface ACPCloudUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: ACPTextContent;
  messageId?: string;
}

/**
 * ACP session update for thought chunks.
 */
interface ACPThoughtUpdate {
  sessionUpdate: 'agent_thought_chunk';
  content: ACPTextContent;
}

/**
 * ACP session update for user message chunks.
 */
interface ACPUserChunkUpdate {
  sessionUpdate: 'user_message_chunk';
  content: ACPTextContent;
}

/**
 * ACP session update for tool calls.
 */
interface ACPToolCallUpdate {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  rawInput?: unknown;
}

/**
 * ACP tool call output content.
 */
interface ACPOutputContent {
  type: string;
  content: ACPTextContent;
}

/**
 * ACP session update for tool call progress.
 */
interface ACPToolCallProgressUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status: string;
  content?: ACPOutputContent[];
  rawOutput?: unknown;
}

/**
 * ACP session update for execution plans.
 */
interface ACPPlanUpdate {
  sessionUpdate: 'plan';
  title?: string;
  content?: Array<{ type: string; text: string }>;
}

/**
 * Union type for all ACP session update types.
 */
type ACPSessionUpdate =
  | ACPCloudUpdate
  | ACPThoughtUpdate
  | ACPUserChunkUpdate
  | ACPToolCallUpdate
  | ACPToolCallProgressUpdate
  | ACPPlanUpdate;

/**
 * ACP session notification (from session/update method).
 */
interface ACPSessionNotification {
  sessionId: string;
  update: ACPSessionUpdate;
}

/**
 * Adapt an ACP session/update notification to unified AgentMessage.
 *
 * Pushes converted messages to the bridge for async consumption.
 *
 * @param notification - The ACP session notification
 * @param bridge - Message bridge for async generator consumption
 */
export function adaptACPUpdate(notification: ACPSessionNotification, bridge: MessageBridge): void {
  const { update } = notification;

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const metadata: AgentMessageMetadata = {};
      if (update.messageId) {
        metadata.messageId = update.messageId;
      }
      bridge.push({
        type: 'text',
        content: update.content.text,
        role: 'assistant',
        metadata,
      });
      break;
    }

    case 'agent_thought_chunk': {
      bridge.push({
        type: 'text',
        content: `💭 ${update.content.text}`,
        role: 'assistant',
      });
      break;
    }

    case 'tool_call': {
      const metadata: AgentMessageMetadata = {
        toolName: update.title,
        toolInput: update.rawInput,
      };
      bridge.push({
        type: 'tool_use',
        content: formatToolCall(update.title, update.kind, update.rawInput),
        role: 'assistant',
        metadata,
      });
      break;
    }

    case 'tool_call_update': {
      const metadata: AgentMessageMetadata = {
        toolName: update.toolCallId,
      };
      if (update.status === 'completed') {
        const text = extractToolOutputText(update.content);
        bridge.push({
          type: 'tool_result',
          content: `✓ ${text || update.toolCallId}`,
          role: 'assistant',
          metadata,
        });
      } else if (update.status === 'failed') {
        const text = extractToolOutputText(update.content);
        bridge.push({
          type: 'error',
          content: `❌ Tool failed: ${text || update.toolCallId}`,
          role: 'assistant',
          metadata,
        });
      } else {
        bridge.push({
          type: 'tool_progress',
          content: `⏳ ${update.toolCallId} (${update.status})`,
          role: 'assistant',
          metadata,
        });
      }
      break;
    }

    case 'user_message_chunk':
      // Echo of user message — skip (not needed in output stream)
      break;

    case 'plan': {
      const planText = update.title || 'Execution plan updated';
      bridge.push({
        type: 'status',
        content: `📋 ${planText}`,
        role: 'assistant',
      });
      break;
    }

    default:
      // Unknown update types — log and skip
      break;
  }
}

// ============================================================================
// AgentMessage → ACP Prompt Conversion
// ============================================================================

/**
 * Convert unified UserInput to ACP prompt content array.
 *
 * ACP prompt format:
 * ```
 * [{ type: "text", text: "user message" }]
 * ```
 *
 * @param input - Unified user input (string or UserInput array)
 * @returns ACP prompt content array
 */
export function userInputToACPPrompt(input: string | UserInput[]): Array<{ type: 'text'; text: string }> {
  if (typeof input === 'string') {
    return [{ type: 'text', text: input }];
  }

  return input.map((userInput) => ({
    type: 'text' as const,
    text: extractTextFromContent(userInput.content),
  }));
}

// ============================================================================
// Stop Reason Formatting
// ============================================================================

/**
 * ACP prompt response stop reasons.
 */
type ACPStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/**
 * Format an ACP stop reason as a result message.
 *
 * @param stopReason - The stop reason from the ACP prompt response
 * @returns Formatted result message
 */
export function formatStopReason(stopReason: ACPStopReason | string): string {
  switch (stopReason) {
    case 'end_turn':
      return '✅ Complete';
    case 'max_tokens':
      return '⚠️ Stopped: max tokens reached';
    case 'max_turn_requests':
      return '⚠️ Stopped: max turn requests reached';
    case 'refusal':
      return '⚠️ Stopped: agent refused';
    case 'cancelled':
      return '⚠️ Stopped: cancelled';
    default:
      return `⚠️ Stopped: ${stopReason}`;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a tool call for display.
 */
function formatToolCall(title: string, kind: string, rawInput: unknown): string {
  if (kind === 'execute') {
    const input = rawInput as Record<string, unknown> | undefined;
    const cmd = input?.command as string | undefined;
    return cmd ? `🔧 Running: ${cmd}` : `🔧 ${title}`;
  }
  if (kind === 'edit') {
    return `🔧 Editing: ${title}`;
  }
  if (kind === 'read') {
    return `🔧 Reading: ${title}`;
  }
  if (kind === 'search') {
    return `🔧 Searching: ${title}`;
  }
  return `🔧 ${title}`;
}

/**
 * Extract text content from a tool call update.
 */
function extractToolOutputText(
  content: ACPOutputContent[] | undefined
): string {
  if (!content || content.length === 0) {
    return '';
  }

  return content
    .filter((c) => c.type === 'content' && c.content?.type === 'text')
    .map((c) => c.content.text)
    .join('\n');
}

/**
 * Extract plain text from UserInput content.
 */
function extractTextFromContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((block) => {
      if (block.type === 'text') {
        return block.text;
      }
      return '[non-text content]';
    })
    .join('\n');
}
