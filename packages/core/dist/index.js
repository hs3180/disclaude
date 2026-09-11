/**
 * @disclaude/core
 *
 * Shared core utilities, types, and interfaces for disclaude.
 *
 * This package contains:
 * - Type definitions (platform, websocket, file)
 * - Constants (deduplication, dialogue, api config)
 * - Utility functions (logger, error-handler, retry)
 * - REST API Protocol (shared between disclaude service and MCP Server)
 * - Agent SDK abstraction layer
 */
// Types (extended types for application-level use)
export * from './types/index.js';
// Constants
export * from './constants/index.js';
// Utils
export * from './utils/index.js';
// REST API Protocol (shared between disclaude service and MCP Server)
export * from './channel-api/index.js';
// Config
export * from './config/index.js';
// Unified filter / delivery observability (Issue #4749)
export * from './observability/lifecycle-events.js';
// Agent SDK abstraction layer (Issue #1040)
// Export SDK functions and classes
export { 
// Provider
ClaudeSDKProvider, 
// stderr capture utilities (Issue #2920)
StderrCapture, getErrorStderr, isStartupFailure, 
// Process listener cleanup (Issue #3745)
// Factory functions
getProvider, registerProvider, registerProviderClass, setDefaultProvider, getDefaultProviderType, getAvailableProviders, clearProviderCache, isProviderAvailable, } from './sdk/index.js';
// Agent Infrastructure (Issue #1040, Issue #1501: Simplified to ChatAgent-only)
// Types and interfaces
export { 
// Type guards
isChatAgent, isDisposable, setRuntimeContext, getRuntimeContext, hasRuntimeContext, clearRuntimeContext, } from './agents/types.js';
// Message channel
export { MessageChannel } from './agents/message-channel.js';
// Session management
export { SessionManager, buildSessionKey, chatIdOfSessionKey, } from './agents/session-manager.js';
// Restart manager
export { RestartManager, } from './agents/restart-manager.js';
// Empty-turn retry policy (Issue #4391): eligibility + bounded-to-1 retry for
// the (deferred) empty-turn session-reset/replay mechanism.
export { EmptyTurnRetryPolicy } from './agents/empty-turn-retry-policy.js';
// MCP tool health tracker (Issue #4179 part 1): per-session circuit breaker
// for MCP tools — records consecutive failures and marks a tool degraded once
// it crosses a threshold, so the agent can pivot to alternatives instead of
// silently retrying a failing tool. Primitive only; call-path wiring is a
// subsequent part.
export { McpHealthTracker, } from './agents/mcp-health-tracker.js';
// Agent pool
export { AgentPool, } from './agents/agent-pool.js';
// Base Agent
export { BaseAgent, } from './agents/base-agent.js';
// Message Builder (Issue #1492: extracted from worker-node to core)
export { MessageBuilder, buildChatHistorySection, buildPersistedHistorySection, buildNextStepGuidance, buildOutputFormatGuidance, buildLocationAwarenessGuidance, CHANNEL_CLI_HELP, buildChannelCliHelpGuidance, } from './agents/message-builder/index.js';
// Conversation module (Issue #1041)
export { MessageQueue, ConversationSessionManager, ConversationOrchestrator, SessionTimeoutManager, } from './conversation/index.js';
// Scheduling module (Issue #1041, Issue #1382)
export { CooldownManager, 
// Issue #4648 residual ⑥: restart-surviving failure streaks
TaskFailureStore, 
// Issue #2947: Bot group chat mapping
BotChatMappingStore, makeMappingKey, parseGroupNameToKey, purposeFromKey, 
// Issue #1041: Full schedule module migrated from worker-node
ScheduleFileScanner, ScheduleFileWatcher, ScheduleManager, Scheduler, TaskTimeoutError, } from './scheduling/index.js';
// Queue module (Issue #1041)
export { TaskQueue, } from './queue/index.js';
export { isTextContent, isMarkdownContent, isCardContent, isFileContent, isDoneContent, createTextMessage, createMarkdownMessage, createCardMessage, createDoneMessage, } from './messaging/index.js';
// Input MessageRouter (Issue #3580: RFC #3329 Phase 1)
export { MessageRouter, MessageRoutingError, } from './messaging/index.js';
// Typed turn-outcome error (Issue #4649 review ①)
export { TurnSupersededError } from './messaging/index.js';
// Channels module (Issue #1041 - migrated from service)
export { BaseChannel } from './channels/index.js';
// Channel Registry (Issue #1553)
export { ChannelRegistry, ChannelRegistryError, } from './channels/index.js';
// Dynamic channel registration (Issue #1422)
export { ChannelLoader, addChannel, removeChannel, setChannelEnabled, getChannel as getDynamicChannel, listChannels as listDynamicChannels, resolveChannelsDir, resolveChannelDir, resolveChannelConfigPath, validateChannelId, parseChannelConfig, serializeChannelConfig, } from './channels/index.js';
// File module (Issue #1041 - migrated from worker-node)
export { AttachmentManager, attachmentManager } from './file/index.js';
// Control module - unified control command handling
export { createControlHandler, commandRegistry, getHandler, createControlCommand, normalizeCommandData, } from './control/index.js';
// Internal Event Bus (Issue #4031: decoupled event propagation)
export { InternalEventBus, eventBus } from './event-bus.js';
export { ProjectManager, 
// Project state utilities (Issue #3335)
createDefaultState, getStateDir, getStateFilePath, isValidIssueEntry, isValidProjectState, isValidPrEntry, readProjectState, updateSyncTimestamp, upsertIssue, upsertPr, writeProjectState, STATE_DIR_NAME, STATE_FILE_NAME, STATE_VERSION, } from './project/index.js';
