/**
 * @disclaude/primary-node
 *
 * Primary Node process for disclaude.
 *
 * This package contains:
 * - Channels (Feishu, REST, Ruliu)
 * - PrimaryNode implementation
 * - Platform adapters
 * - IPC server
 * - Agent factory and ChatAgent (Issue #2717)
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 * @see Issue #2717 - Migrate ChatAgent/AgentFactory from worker-node
 */

// Re-export types from @disclaude/core
export type {
  // Node types
  NodeType,
  NodeCapabilities,
  BaseNodeConfig,
  PrimaryNodeConfig,
  PrimaryNodeExecInfo,
  RestChannelConfig,
  FileStorageConfig,

  // Channel types
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

  // IPC types
  IpcRequestType,
  IpcRequestPayloads,
  IpcResponsePayloads,
  IpcRequest,
  IpcResponse,
  IpcConfig,

  // WebSocket message types
  CardActionMessage,
} from '@disclaude/core';

// Re-export constants and utilities from @disclaude/core
export {
  getNodeCapabilities,
  DEFAULT_CHANNEL_CAPABILITIES,
  DEFAULT_IPC_CONFIG,
  createLogger,
} from '@disclaude/core';

// Channel base class
export { BaseChannel } from '@disclaude/core';

// IPC module
export {
  // Types re-exported above
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  getIpcClient,
  resetIpcClient,
  createInteractiveMessageHandler,
  type IpcRequestHandler,
  type FeishuApiHandlers,
  type FeishuHandlersContainer,
  type IpcAvailabilityStatus,
  type IpcUnavailableReason,
} from './ipc/index.js';

// Note: ChannelManager is now internal to PrimaryNode (Issue #1594).
// Access it via primaryNode.getChannelManager() instead of direct import.

// Platform adapters (Issue #1040)
export {
  // Welcome service
  WelcomeService,
  initWelcomeService,
  getWelcomeService,
  resetWelcomeService,
  type WelcomeServiceConfig,
  // Feishu client factory
  createFeishuClient,
  type CreateFeishuClientOptions,
  // Interaction manager
  InteractionManager,
  type InteractionManagerConfig,
  // Card builders
  buildTextContent,
  buildPostContent,
  buildSimplePostContent,
  buildButton,
  buildMenu,
  buildDiv,
  buildMarkdown,
  buildDivider,
  buildActionGroup,
  buildNote,
  buildColumnSet,
  buildCard,
  buildConfirmCard,
  buildSelectionCard,
  extractCardTextContent,
  type PostElement,
  type PostTextElement,
  type PostAtElement,
  type PostLinkElement,
  type PostImageElement,
  type PostContent,
  type ButtonStyle,
  type ButtonConfig,
  type MenuOptionConfig,
  type MenuConfig,
  type DividerConfig,
  type MarkdownConfig,
  type ColumnConfig,
  type CardElement,
  type ActionElement,
  type ButtonAction,
  type MenuAction,
  type CardHeaderConfig,
  type CardConfig,
} from './platforms/index.js';

// Routers (Issue #1040)
export {
  CardActionRouter,
  type CardActionRouterConfig,
} from './routers/card-action-router.js';

// Services (Issue #1040)
export {
  DebugGroupService,
  getDebugGroupService,
  resetDebugGroupService,
  type DebugGroupInfo,
} from './services/index.js';

// PrimaryNode main class (Issue #1040)
export {
  PrimaryNode,
  type PrimaryNodeOptions,
} from './primary-node.js';

// Agent pool (Issue #1040)
export { PrimaryAgentPool, type PrimaryAgentPoolOptions } from './primary-agent-pool.js';

// Agents (Issue #2717: migrated from @disclaude/worker-node)
export { AgentFactory, toChatAgentCallbacks, type AgentCreateOptions } from './agents/factory.js';
export { ChatAgent } from './agents/chat-agent.js';
export type { ChatAgentCallbacks, ChatAgentConfig } from './agents/types.js';

// Channel Lifecycle Manager (Issue #1594 Phase 2)
export {
  ChannelLifecycleManager,
  type ChannelSetupContext,
  type WiredContext,
  type WiredChannelDescriptor,
  type IPrimaryNodeForSetup,
} from './channel-lifecycle-manager.js';

// Interactive context store (Issue #1626, #1572)
export {
  InteractiveContextStore,
  type ActionPromptMap,
  type InteractiveContext,
} from './interactive-context.js';

// Version
export const PRIMARY_NODE_VERSION = '0.0.1';

// Messaging module (Issue #513, Issue #515)
export * from './messaging/index.js';
