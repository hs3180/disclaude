/**
 * @disclaude/primary-node
 *
 * Primary Node process for disclaude.
 *
 * This package contains:
 * - Channels (Feishu, REST, Ruliu)
 * - PrimaryNode implementation
 * - Platform adapters
 * - REST API server
 * - Agent factory and ChatAgent (Issue #2717)
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 * @see Issue #2717 - Remove Worker Node design
 */
// Re-export constants and utilities from @disclaude/core
export { DEFAULT_CHANNEL_CAPABILITIES, createLogger } from "../../core/dist/index.js";
// Channel base class
export { BaseChannel } from "../../core/dist/index.js";
// Note: ChannelManager is now internal to PrimaryNode (Issue #1594).
// Access it via primaryNode.getChannelManager() instead of direct import.
// Platform adapters (Issue #1040)
export { 
// Welcome service
WelcomeService, initWelcomeService, getWelcomeService, resetWelcomeService, 
// Feishu client factory
createFeishuClient, 
// Interaction manager
InteractionManager, 
// Card builders
buildTextContent, buildPostContent, buildSimplePostContent, buildButton, buildMenu, buildDiv, buildMarkdown, buildDivider, buildActionGroup, buildNote, buildColumnSet, buildCard, buildConfirmCard, buildSelectionCard, extractCardTextContent, extractFullCardContent, } from './platforms/index.js';
// Routers (Issue #1040)
export { CardActionRouter } from './routers/card-action-router.js';
// Services (Issue #1040)
export { DebugGroupService, getDebugGroupService, resetDebugGroupService, } from './services/index.js';
// PrimaryNode main class (Issue #1040)
export { PrimaryNode } from './primary-node.js';
// Agent pool (Issue #1040)
export { PrimaryAgentPool } from './primary-agent-pool.js';
// Agents (Issue #2717: consolidated into primary-node)
export { AgentFactory, toChatAgentCallbacks } from './agents/factory.js';
export { ChatAgent } from './agents/chat-agent.js';
// Channel Lifecycle Manager (Issue #1594 Phase 2)
export { ChannelLifecycleManager, } from './channel-lifecycle-manager.js';
// Interactive context store (Issue #1626, #1572)
export { InteractiveContextStore, } from './interactive-context.js';
// Feishu message handling (Issue #1626: integration test exports)
export { MessageHandler as FeishuMessageHandler, } from './channels/feishu/message-handler.js';
export { TriggerModeManager } from './channels/feishu/passive-mode.js';
export { MentionDetector } from './channels/feishu/mention-detector.js';
// Version (Issue #3857: extracted to version.ts to avoid heavy import chain in tests)
export { PRIMARY_NODE_VERSION } from './version.js';
// HTTP API Server (Issue #3857 Phase 2)
export { HttpApiServer, } from './http-api-server.js';
// Messaging module (Issue #513, Issue #515)
export * from './messaging/index.js';
