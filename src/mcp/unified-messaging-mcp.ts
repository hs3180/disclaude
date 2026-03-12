/**
 * @deprecated Import from '@disclaude/mcp-server' instead.
 *
 * Issue #1042: MCP Server migration to @disclaude/mcp-server package.
 * This file is now a re-export wrapper for backward compatibility.
 */
export {
  unified_send_message as send_message,
  detectChannel,
  createUnifiedMessagingMcpServer,
  unifiedMessagingToolDefinitions,
  unifiedSetMessageSentCallback as setMessageSentCallback,
  type ChannelType,
  type UnifiedSendMessageResult as SendMessageResult,
  type UnifiedMessageSentCallback as MessageSentCallback,
} from '@disclaude/mcp-server';
