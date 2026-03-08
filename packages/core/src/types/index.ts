/**
 * Core type definitions for disclaude.
 */

// File transfer types
export type {
  FileRef,
  InboundAttachment,
  OutboundFile,
  FileUploadRequest,
  FileUploadResponse,
  FileDownloadResponse,
  StoredFile,
} from './file.js';

export { createFileRef, createInboundAttachment, createOutboundFile } from './file.js';

// Platform types (Feishu-specific)
export type {
  FeishuMessageEvent,
  FeishuEventData,
  FeishuCardActionEvent,
  FeishuCardActionEventData,
  InteractionContext,
  InteractionHandler,
  FeishuChatMemberAddedEvent,
  FeishuChatMemberAddedEventData,
  FeishuP2PChatEnteredEvent,
  FeishuP2PChatEnteredEventData,
} from './platform.js';

// WebSocket message types
export type {
  PromptMessage,
  CommandMessage,
  RegisterMessage,
  ExecNodeInfo,
  FeedbackMessage,
  CardActionMessage,
  CardContextMessage,
} from './websocket-messages.js';

// MCP Server types
export type {
  SendMessageResult,
  SendFileResult,
  MessageSentCallback,
  ActionPromptMap,
  InteractiveMessageContext,
  SendInteractiveResult,
  AskUserOption,
  AskUserResult,
  StudyGuideOptions,
  StudyGuideResult,
  McpToolDefinition,
  McpToolContext,
  NodeType,
  BaseNodeConfig,
  McpServerConfig,
  NodeCapabilities,
} from './mcp-server.js';

export { getNodeCapabilities } from './mcp-server.js';
