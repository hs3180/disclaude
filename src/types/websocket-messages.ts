/**
 * WebSocket message types for Communication Node and Execution Node communication.
 *
 * These types are now defined in @disclaude/core and re-exported here for backward compatibility.
 *
 * @see packages/core/src/types/websocket-messages.ts
 */

// Re-export all types from @disclaude/core
export type {
  PromptMessage,
  CommandMessage,
  RegisterMessage,
  ExecNodeInfo,
  FeedbackMessage,
  CardActionMessage,
  CardContextMessage,
  FeishuApiAction,
  FeishuApiRequestMessage,
  FeishuApiResponseMessage,
} from '@disclaude/core';
