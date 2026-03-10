/**
 * Channel abstraction types.
 *
 * A Channel represents a communication pathway between users and the agent.
 * Different platforms (Feishu, REST API, etc.) can implement this interface
 * to provide a unified way of receiving and sending messages.
 *
 * Architecture:
 * ```
 *                    ┌─────────────────┐
 *                    │  Communication  │
 *   Feishu Channel ──│      Node       │── Execution Node
 *   REST Channel   ──│  (multiplexer)  │    (Agent)
 *   (future)       ──│                 │
 *                    └─────────────────┘
 * ```
 *
 * @deprecated Import from @disclaude/core instead
 * @see Issue #1040 - Types moved to @disclaude/core
 */

// Re-export all types from @disclaude/core for backward compatibility
export type {
  IncomingMessage,
  OutgoingMessage,
  OutgoingContentType,
  MessageAttachment,
  ControlCommand,
  ControlCommandType,
  ControlResponse,
  ChannelStatus,
  MessageHandler,
  ControlHandler,
  IChannel,
  ChannelConfig,
  ChannelFactory,
  ChannelCapabilities,
} from '@disclaude/core';

export { DEFAULT_CHANNEL_CAPABILITIES } from '@disclaude/core';
